import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { FriendRequest, pairKeyFor } from '../models/FriendRequest';
import { getSettings, getSettingsMap } from '../models/UserSettings';
import { requireAuth, getAuth } from '../middleware/auth';
import { validate, objectId, idParam } from '../middleware/validate';
import { asyncHandler, ApiError } from '../utils/errors';
import { toPublicUser, PUBLIC_USER_FIELDS } from '../utils/serializers';
import { getFriendIds, isBlockedEitherWay } from '../services/relationships';
import { emitToUser } from '../services/realtime';
import { notify } from '../services/notifications';

const router = Router();
router.use(requireAuth);

/** Accepted friends with presence (respecting each friend's privacy). */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const friendIds = await getFriendIds(userId);
    const [users, settingsMap] = await Promise.all([
      User.find({ _id: { $in: friendIds } }).select(PUBLIC_USER_FIELDS).sort({ displayName: 1 }).lean(),
      getSettingsMap(friendIds),
    ]);
    const friendSet = new Set(friendIds);
    res.json({ friends: users.map((u) => toPublicUser(u, { viewerId: userId, friendIds: friendSet, settingsMap })) });
  }),
);

router.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const [incoming, outgoing] = await Promise.all([
      FriendRequest.find({ receiverId: userId, status: 'pending' }).populate('senderId', PUBLIC_USER_FIELDS).sort({ createdAt: -1 }).lean(),
      FriendRequest.find({ senderId: userId, status: 'pending' }).populate('receiverId', PUBLIC_USER_FIELDS).sort({ createdAt: -1 }).lean(),
    ]);
    const hidePresence = (u: unknown) => ({ ...toPublicUser(u, { viewerId: userId })!, isOnline: null, lastSeen: null });
    res.json({
      incoming: incoming.filter((r) => r.senderId).map((r) => ({ id: String(r._id), user: hidePresence(r.senderId), createdAt: r.createdAt })),
      outgoing: outgoing.filter((r) => r.receiverId).map((r) => ({ id: String(r._id), user: hidePresence(r.receiverId), createdAt: r.createdAt })),
    });
  }),
);

async function acceptRequest(requestId: string, userId: string) {
  const fr = await FriendRequest.findOneAndUpdate(
    { _id: requestId, receiverId: userId, status: 'pending' },
    { status: 'accepted', respondedAt: new Date() },
    { new: true },
  );
  if (!fr) throw ApiError.notFound('Friend request not found');
  const [me, them] = await Promise.all([
    User.findById(userId).select(PUBLIC_USER_FIELDS).lean(),
    User.findById(fr.senderId).select(PUBLIC_USER_FIELDS).lean(),
  ]);
  const senderId = String(fr.senderId);
  const settingsMap = await getSettingsMap([userId, senderId]);
  emitToUser(senderId, 'friend:accepted', {
    requestId: String(fr._id),
    user: toPublicUser(me, { viewerId: senderId, friendIds: new Set([userId]), settingsMap }),
  });
  emitToUser(userId, 'friend:accepted', {
    requestId: String(fr._id),
    user: toPublicUser(them, { viewerId: userId, friendIds: new Set([senderId]), settingsMap }),
  });
  void notify(
    senderId,
    {
      type: 'friend_accepted',
      title: 'Friend request accepted',
      body: `${me?.displayName ?? 'Someone'} (@${me?.username}) accepted your friend request`,
      data: { userId },
    },
    { socket: false },
  );
  return fr;
}

router.post(
  '/requests',
  validate({ body: z.object({ userId: objectId }) }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const targetId: string = req.body.userId;
    if (targetId === userId) throw ApiError.badRequest("You can't add yourself");
    const target = await User.findById(targetId).select(PUBLIC_USER_FIELDS).lean();
    if (!target) throw ApiError.notFound('User not found');
    if (await isBlockedEitherWay(userId, targetId)) throw ApiError.forbidden("You can't send a request to this user");

    const pairKey = pairKeyFor(userId, targetId);
    const existing = await FriendRequest.findOne({ pairKey });
    if (existing?.status === 'accepted') throw ApiError.conflict('You are already friends');
    if (existing?.status === 'pending') {
      if (String(existing.senderId) === userId) throw ApiError.conflict('Friend request already sent');
      // They already asked us → accept.
      await acceptRequest(String(existing._id), userId);
      return res.json({ status: 'friends', requestId: String(existing._id) });
    }

    const targetSettings = await getSettings(targetId);
    if (targetSettings.privacy.friendRequests === 'nobody') throw ApiError.forbidden('This user is not accepting friend requests');

    const fr = await FriendRequest.findOneAndUpdate(
      { pairKey },
      { senderId: userId, receiverId: targetId, status: 'pending', respondedAt: null, pairKey },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const me = await User.findById(userId).select(PUBLIC_USER_FIELDS).lean();
    const meForThem = { ...toPublicUser(me, { viewerId: targetId })!, isOnline: null, lastSeen: null };
    emitToUser(targetId, 'friend:request', { id: String(fr._id), user: meForThem, createdAt: fr.createdAt });
    void notify(
      targetId,
      {
        type: 'friend_request',
        title: 'New friend request',
        body: `${me?.displayName} (@${me?.username}) wants to be your friend`,
        data: { requestId: String(fr._id), userId },
      },
      { socket: false },
    );
    res.status(201).json({ status: 'outgoing', requestId: String(fr._id) });
  }),
);

router.post(
  '/requests/:id/accept',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const fr = await acceptRequest(req.params.id, getAuth(req).userId);
    res.json({ ok: true, requestId: String(fr._id) });
  }),
);

router.post(
  '/requests/:id/reject',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const fr = await FriendRequest.findOneAndUpdate(
      { _id: req.params.id, receiverId: getAuth(req).userId, status: 'pending' },
      { status: 'rejected', respondedAt: new Date() },
    );
    if (!fr) throw ApiError.notFound('Friend request not found');
    // The sender is intentionally not told explicitly; their request just disappears.
    emitToUser(String(fr.senderId), 'friend:request-closed', { requestId: String(fr._id) });
    res.json({ ok: true });
  }),
);

/** Cancel an outgoing request. */
router.delete(
  '/requests/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const fr = await FriendRequest.findOneAndDelete({ _id: req.params.id, senderId: getAuth(req).userId, status: 'pending' });
    if (!fr) throw ApiError.notFound('Friend request not found');
    emitToUser(String(fr.receiverId), 'friend:request-closed', { requestId: String(fr._id) });
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const fr = await FriendRequest.findOneAndDelete({ pairKey: pairKeyFor(userId, req.params.id), status: 'accepted' });
    if (!fr) throw ApiError.notFound('Not friends');
    emitToUser(req.params.id, 'friend:removed', { userId });
    emitToUser(userId, 'friend:removed', { userId: req.params.id });
    res.json({ ok: true });
  }),
);

export default router;
