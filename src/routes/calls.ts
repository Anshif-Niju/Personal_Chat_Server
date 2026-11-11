import { Router } from 'express';
import { z } from 'zod';
import { Call } from '../models/Call';
import { requireAuth, getAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/errors';
import { getIceServers } from '../services/ice';
import { toPublicUser, PUBLIC_USER_FIELDS } from '../utils/serializers';

const router = Router();
router.use(requireAuth);

router.get('/ice-servers', (req, res) => {
  res.json({ iceServers: getIceServers(getAuth(req).userId) });
});

/** Call history (most recent first). */
router.get(
  '/',
  validate({ query: z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const { before, limit } = req.query as unknown as { before?: string; limit: number };
    const filter: Record<string, unknown> = { $or: [{ callerId: userId }, { receiverId: userId }] };
    if (before) filter.createdAt = { $lt: new Date(before) };
    const rows = await Call.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('callerId', PUBLIC_USER_FIELDS)
      .populate('receiverId', PUBLIC_USER_FIELDS)
      .lean();
    res.json({
      calls: rows.map((c) => {
        const outgoing = String((c.callerId as unknown as { _id: unknown })?._id) === userId;
        const peer = outgoing ? c.receiverId : c.callerId;
        return {
          id: String(c._id),
          direction: outgoing ? 'outgoing' : 'incoming',
          peer: peer ? { ...toPublicUser(peer)!, isOnline: null, lastSeen: null } : null,
          conversationId: String(c.conversationId),
          callType: c.callType,
          status: c.status,
          startedAt: c.startedAt,
          endedAt: c.endedAt,
          duration: c.duration,
          createdAt: c.createdAt,
        };
      }),
    });
  }),
);

export default router;
