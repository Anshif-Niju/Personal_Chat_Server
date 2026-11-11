import { Router } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { User } from '../models/User';
import { UserSettings, getSettingsMap } from '../models/UserSettings';
import { UserSession } from '../models/UserSession';
import { FriendRequest } from '../models/FriendRequest';
import { Block, Report } from '../models/Block';
import { Conversation } from '../models/Conversation';
import { requireAuth, getAuth } from '../middleware/auth';
import { validate, objectId, idParam } from '../middleware/validate';
import { imageUpload } from '../middleware/upload';
import { uploadLimiter } from '../middleware/security';
import { asyncHandler, ApiError } from '../utils/errors';
import { toMe, toPublicUser, PUBLIC_USER_FIELDS } from '../utils/serializers';
import { getBlockRelations, getFriendIds, relationshipBetween } from '../services/relationships';
import { storage, driverFor } from '../services/storage';
import { revokeSessions, verifyPassword, clearRefreshCookie } from '../services/auth';
import { emitToUser } from '../services/realtime';
import { usernameSchema } from './auth';
import { removeMemberFromGroup } from '../services/conversations';

const router = Router();
router.use(requireAuth);

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- Search ----------
router.get(
  '/search',
  validate({ query: z.object({ q: z.string().trim().min(1).max(50) }) }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const q = String(req.query.q).replace(/^@/, '');
    const rx = escapeRegex(q);
    const { blockedByMe, blockedMe } = await getBlockRelations(userId);
    const exclude = [userId, ...blockedMe, ...blockedByMe].map((id) => new Types.ObjectId(id));

    const users = await User.find({
      _id: { $nin: exclude },
      $or: [{ username: { $regex: `^${rx.toLowerCase()}` } }, { displayName: { $regex: rx, $options: 'i' } }],
    })
      .select(PUBLIC_USER_FIELDS)
      .limit(20)
      .lean();

    const ids = users.map((u) => u._id);
    const [friendIds, settingsMap, requests] = await Promise.all([
      getFriendIds(userId),
      getSettingsMap(ids),
      FriendRequest.find({
        $or: [
          { senderId: userId, receiverId: { $in: ids } },
          { receiverId: userId, senderId: { $in: ids } },
        ],
      }).lean(),
    ]);
    const friendSet = new Set(friendIds);
    const reqByUser = new Map(requests.map((r) => [String(r.senderId) === userId ? String(r.receiverId) : String(r.senderId), r]));

    res.json({
      users: users.map((u) => {
        const r = reqByUser.get(String(u._id));
        let relationship: string = 'none';
        if (r?.status === 'accepted') relationship = 'friends';
        else if (r?.status === 'pending') relationship = String(r.senderId) === userId ? 'outgoing' : 'incoming';
        return {
          ...toPublicUser(u, { viewerId: userId, friendIds: friendSet, settingsMap }),
          relationship,
          requestId: r && r.status !== 'rejected' ? String(r._id) : null,
        };
      }),
    });
  }),
);

// ---------- Own profile ----------
const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  bio: z.string().trim().max(250).optional(),
  username: usernameSchema.optional(),
});

router.patch(
  '/me',
  validate({ body: updateProfileSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const body = req.body as z.infer<typeof updateProfileSchema>;
    if (body.username && (await User.exists({ username: body.username, _id: { $ne: userId } }))) {
      throw ApiError.conflict('That username is already taken');
    }
    const user = await User.findByIdAndUpdate(userId, { $set: body }, { new: true, runValidators: true }).lean();
    if (!user) throw ApiError.notFound();
    res.json({ user: toMe(user) });
  }),
);

router.post(
  '/me/avatar',
  uploadLimiter,
  imageUpload.single('file'),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    if (!req.file) throw ApiError.badRequest('No file uploaded');
    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound();
    const uploaded = await storage.upload(req.file.buffer, {
      mimeType: req.file.mimetype,
      originalName: req.file.originalname,
      visibility: 'public',
      folder: 'avatars',
    });
    const previous = user.avatar;
    user.avatar = { key: uploaded.key, provider: uploaded.provider, resourceType: uploaded.resourceType };
    await user.save();
    if (previous?.key) driverFor(previous.provider).remove(previous, 'public').catch(() => undefined);
    res.json({ user: toMe(user.toObject()) });
  }),
);

router.delete(
  '/me/avatar',
  asyncHandler(async (req, res) => {
    const user = await User.findById(getAuth(req).userId);
    if (!user) throw ApiError.notFound();
    const previous = user.avatar;
    user.avatar = null;
    await user.save();
    if (previous?.key) driverFor(previous.provider).remove(previous, 'public').catch(() => undefined);
    res.json({ user: toMe(user.toObject()) });
  }),
);

router.delete(
  '/me',
  validate({ body: z.object({ password: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw ApiError.notFound();
    if (!(await verifyPassword(req.body.password, user.passwordHash))) throw ApiError.badRequest('Incorrect password');

    // Leave all groups (promotes a new admin where needed).
    const groups = await Conversation.find({ type: 'group', participants: userId }).select('_id').lean();
    for (const g of groups) await removeMemberFromGroup(String(g._id), userId, userId, { silent: false }).catch(() => undefined);

    const friendIds = await getFriendIds(userId);
    await Promise.all([
      FriendRequest.deleteMany({ $or: [{ senderId: userId }, { receiverId: userId }] }),
      Block.deleteMany({ $or: [{ blocker: userId }, { blocked: userId }] }),
      UserSettings.deleteOne({ userId }),
    ]);
    await revokeSessions({ userId });
    await UserSession.deleteMany({ userId });
    if (user.avatar?.key) driverFor(user.avatar.provider).remove(user.avatar, 'public').catch(() => undefined);
    await user.deleteOne();
    // Private conversations stay for the other participant; the sender shows as "Deleted account".
    emitToUser(friendIds, 'friend:removed', { userId });
    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

// ---------- Blocking ----------
router.get(
  '/me/blocked',
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const rows = await Block.find({ blocker: userId }).populate('blocked', PUBLIC_USER_FIELDS).sort({ createdAt: -1 }).lean();
    res.json({
      users: rows
        .filter((r) => r.blocked)
        .map((r) => ({ ...toPublicUser(r.blocked, { viewerId: userId }), isOnline: null, lastSeen: null, blockedAt: r.createdAt })),
    });
  }),
);

router.post(
  '/:id/block',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const target = req.params.id;
    if (target === userId) throw ApiError.badRequest("You can't block yourself");
    if (!(await User.exists({ _id: target }))) throw ApiError.notFound('User not found');
    await Block.updateOne({ blocker: userId, blocked: target }, { $setOnInsert: { blocker: userId, blocked: target } }, { upsert: true });
    // Blocking also removes friendship / pending requests.
    const removed = await FriendRequest.findOneAndDelete({
      $or: [
        { senderId: userId, receiverId: target },
        { senderId: target, receiverId: userId },
      ],
    });
    if (removed) {
      emitToUser(target, 'friend:removed', { userId });
      emitToUser(userId, 'friend:removed', { userId: target });
    }
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id/block',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await Block.deleteOne({ blocker: getAuth(req).userId, blocked: req.params.id });
    res.json({ ok: true });
  }),
);

// ---------- Reporting ----------
const reportSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'impersonation', 'inappropriate', 'other']),
  details: z.string().trim().max(1000).optional(),
  conversationId: objectId.optional(),
  messageId: objectId.optional(),
  alsoBlock: z.boolean().optional(),
});

router.post(
  '/:id/report',
  validate({ params: idParam, body: reportSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const body = req.body as z.infer<typeof reportSchema>;
    if (req.params.id === userId) throw ApiError.badRequest("You can't report yourself");
    if (!(await User.exists({ _id: req.params.id }))) throw ApiError.notFound('User not found');
    if (body.conversationId && !(await Conversation.exists({ _id: body.conversationId, participants: userId }))) {
      throw ApiError.forbidden();
    }
    await Report.create({ reporter: userId, reported: req.params.id, ...body });
    if (body.alsoBlock) {
      await Block.updateOne({ blocker: userId, blocked: req.params.id }, { $setOnInsert: { blocker: userId, blocked: req.params.id } }, { upsert: true });
      await FriendRequest.deleteOne({
        $or: [
          { senderId: userId, receiverId: req.params.id },
          { senderId: req.params.id, receiverId: userId },
        ],
      });
    }
    res.status(201).json({ ok: true });
  }),
);

// ---------- Profiles ----------
async function profileResponse(viewerId: string, user: Record<string, unknown> & { _id: Types.ObjectId }) {
  const [rel, friendIds, settingsMap, blockedMe] = await Promise.all([
    relationshipBetween(viewerId, user._id),
    getFriendIds(viewerId),
    getSettingsMap([user._id]),
    Block.exists({ blocker: user._id, blocked: viewerId }),
  ]);
  if (blockedMe) throw ApiError.notFound('User not found');
  const pub = toPublicUser(user, { viewerId, friendIds: new Set(friendIds), settingsMap });
  return { user: { ...pub, relationship: rel.status, requestId: rel.requestId ?? null } };
}

router.get(
  '/by-username/:username',
  asyncHandler(async (req, res) => {
    const username = String(req.params.username).toLowerCase().replace(/^@/, '');
    const user = await User.findOne({ username }).select(PUBLIC_USER_FIELDS).lean();
    if (!user) throw ApiError.notFound('User not found');
    res.json(await profileResponse(getAuth(req).userId, user as never));
  }),
);

router.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select(PUBLIC_USER_FIELDS).lean();
    if (!user) throw ApiError.notFound('User not found');
    res.json(await profileResponse(getAuth(req).userId, user as never));
  }),
);

export default router;
