/* eslint-disable @typescript-eslint/no-explicit-any */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { requireAuth, getAuth } from '../middleware/auth';
import { idParam, validate } from '../middleware/validate';
import { asyncHandler, ApiError } from '../utils/errors';
import { MESSAGE_POPULATE, serializeMessage } from '../utils/serializers';
import { fileUrl } from '../services/storage';
import { connectNewUser } from '../services/conversations';
import { hardDeleteConversation, hardDeleteMessage, hardDeleteUser, isAdminUsername } from '../services/admin';

const router = Router();
const PAGE_SIZE = 50;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const me = await User.findById(getAuth(req).userId).select('username').lean();
    if (!me || !isAdminUsername(me.username)) throw ApiError.forbidden('Admins only');
    next();
  } catch (err) {
    next(err);
  }
}

router.use(requireAuth, requireAdmin);

const userRow = (u: any) => ({
  id: String(u._id),
  username: u.username,
  displayName: u.displayName,
  email: u.email ?? null,
  avatarUrl: fileUrl(u.avatar, 'public'),
  approved: u.approved !== false,
  isAdmin: isAdminUsername(u.username),
  isOnline: !!u.isOnline,
  lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
  createdAt: new Date(u.createdAt).toISOString(),
});

router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const [users, pending, conversations, messages] = await Promise.all([
      User.countDocuments({ approved: { $ne: false } }),
      User.countDocuments({ approved: false }),
      Conversation.countDocuments(),
      Message.countDocuments(),
    ]);
    res.json({ users, pending, conversations, messages });
  }),
);

// ---------- Users ----------

router.get(
  '/users',
  validate({
    query: z.object({
      status: z.enum(['all', 'pending', 'approved']).default('all'),
      q: z.string().trim().max(60).optional(),
      page: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, q, page } = req.query as unknown as { status: string; q?: string; page: number };
    const filter: Record<string, unknown> = {};
    if (status === 'pending') filter.approved = false;
    if (status === 'approved') filter.approved = { $ne: false };
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ username: rx }, { displayName: rx }, { email: rx }];
    }
    const [rows, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      User.countDocuments(filter),
    ]);
    res.json({ users: rows.map(userRow), total, pageSize: PAGE_SIZE });
  }),
);

router.post(
  '/users/:id/approve',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id);
    if (!user) throw ApiError.notFound('User not found');
    if (user.approved === false) {
      user.approved = true;
      await user.save();
      await connectNewUser(String(user._id)).catch(() => undefined);
    }
    res.json({ user: userRow(user.toObject()) });
  }),
);

/** Rejecting a sign-up request removes the pending account entirely. */
router.post(
  '/users/:id/reject',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('approved username').lean();
    if (!user) throw ApiError.notFound('User not found');
    if (user.approved !== false) throw ApiError.badRequest('This user is already approved. Use delete instead.');
    await hardDeleteUser(req.params.id);
    res.json({ ok: true });
  }),
);

router.delete(
  '/users/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    if (req.params.id === getAuth(req).userId) throw ApiError.badRequest("You can't delete your own account here");
    await hardDeleteUser(req.params.id);
    res.json({ ok: true });
  }),
);

// ---------- Chats ----------

router.get(
  '/conversations',
  validate({
    query: z.object({
      q: z.string().trim().max(60).optional(),
      type: z.enum(['all', 'private', 'group']).default('all'),
      page: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q, type, page } = req.query as unknown as { q?: string; type: string; page: number };
    const filter: Record<string, any> = {};
    if (type !== 'all') filter.type = type;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      const ids = (await User.find({ $or: [{ username: rx }, { displayName: rx }] }).select('_id').limit(200).lean()).map((u) => u._id);
      filter.$or = [{ groupName: rx }, { participants: { $in: ids } }];
    }
    const [rows, total] = await Promise.all([
      Conversation.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(page * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .populate('participants', 'username displayName')
        .lean(),
      Conversation.countDocuments(filter),
    ]);
    const counts = await Message.aggregate([
      { $match: { conversationId: { $in: rows.map((r) => r._id) } } },
      { $group: { _id: '$conversationId', n: { $sum: 1 } } },
    ]);
    const countMap = new Map<string, number>(counts.map((c) => [String(c._id), c.n]));
    res.json({
      conversations: rows.map((c: any) => ({
        id: String(c._id),
        type: c.type,
        title: c.type === 'group' ? c.groupName ?? 'Group' : c.participants.map((p: any) => p.displayName).join(' & '),
        participants: c.participants.map((p: any) => ({ id: String(p._id), username: p.username, displayName: p.displayName })),
        messageCount: countMap.get(String(c._id)) ?? 0,
        lastMessageAt: new Date(c.lastMessageAt).toISOString(),
      })),
      total,
      pageSize: PAGE_SIZE,
    });
  }),
);

router.get(
  '/conversations/:id/messages',
  validate({ params: idParam, query: z.object({ before: z.string().datetime().optional() }) }),
  asyncHandler(async (req, res) => {
    const before = (req.query as { before?: string }).before;
    const rows = await Message.find({ conversationId: req.params.id, ...(before ? { createdAt: { $lt: new Date(before) } } : {}) })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate(MESSAGE_POPULATE)
      .lean();
    const messages = rows.reverse().map((m: any) => {
      const s = serializeMessage(m)!;
      // Admins see the original text even if a user deleted it "for everyone".
      return { ...s, content: m.content ?? '', attachment: m.attachment ? serializeMessage({ ...m, deletedAt: null })!.attachment : null };
    });
    res.json({ messages, hasMore: rows.length === 100 });
  }),
);

router.delete(
  '/conversations/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await hardDeleteConversation(req.params.id);
    res.json({ ok: true });
  }),
);

router.delete(
  '/messages/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await hardDeleteMessage(req.params.id);
    res.json({ ok: true });
  }),
);

export default router;
