import { Router } from 'express';
import { z } from 'zod';
import { UserSettings, getSettings } from '../models/UserSettings';
import { UserSession } from '../models/UserSession';
import { requireAuth, getAuth } from '../middleware/auth';
import { validate, idParam } from '../middleware/validate';
import { asyncHandler, ApiError } from '../utils/errors';
import { revokeSessions } from '../services/auth';
import { vapidPublicKey } from '../services/notifications';
import { broadcastPresence } from '../socket/presence';

const router = Router();
router.use(requireAuth);

const visibility = z.enum(['everyone', 'friends', 'nobody']);
const settingsSchema = z.object({
  privacy: z
    .object({
      lastSeen: visibility.optional(),
      onlineStatus: visibility.optional(),
      friendRequests: z.enum(['everyone', 'nobody']).optional(),
      calls: z.enum(['friends', 'nobody']).optional(),
      readReceipts: z.boolean().optional(),
    })
    .optional(),
  notifications: z
    .object({
      messages: z.boolean().optional(),
      groups: z.boolean().optional(),
      calls: z.boolean().optional(),
      friendRequests: z.boolean().optional(),
      showPreview: z.boolean().optional(),
      sound: z.boolean().optional(),
    })
    .optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
});

const shape = (s: Awaited<ReturnType<typeof getSettings>>) => ({ privacy: s.privacy, notifications: s.notifications, theme: s.theme });

router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    res.json({ settings: shape(await getSettings(getAuth(req).userId)) });
  }),
);

router.patch(
  '/settings',
  validate({ body: settingsSchema }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const body = req.body as z.infer<typeof settingsSchema>;
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.privacy ?? {})) if (v !== undefined) $set[`privacy.${k}`] = v;
    for (const [k, v] of Object.entries(body.notifications ?? {})) if (v !== undefined) $set[`notifications.${k}`] = v;
    if (body.theme) $set.theme = body.theme;
    await getSettings(userId); // ensure doc exists
    const updated = await UserSettings.findOneAndUpdate({ userId }, { $set }, { new: true }).lean();
    if (body.privacy?.onlineStatus || body.privacy?.lastSeen) void broadcastPresence(userId);
    res.json({ settings: shape(updated!) });
  }),
);

// ---------- Sessions / devices ----------

router.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const { userId, sessionId } = getAuth(req);
    const rows = await UserSession.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
      .select('deviceName platform ip lastActive createdAt')
      .sort({ lastActive: -1 })
      .lean();
    res.json({
      sessions: rows.map((s) => ({
        id: String(s._id),
        deviceName: s.deviceName,
        platform: s.platform,
        ip: s.ip ?? null,
        lastActive: s.lastActive,
        createdAt: s.createdAt,
        current: String(s._id) === sessionId,
      })),
    });
  }),
);

router.delete(
  '/sessions/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const n = await revokeSessions({ _id: req.params.id, userId });
    if (!n) throw ApiError.notFound('Session not found');
    res.json({ ok: true });
  }),
);

/** Log out every other device. */
router.delete(
  '/sessions',
  asyncHandler(async (req, res) => {
    const { userId, sessionId } = getAuth(req);
    const revoked = await revokeSessions({ userId, _id: { $ne: sessionId } });
    res.json({ ok: true, revoked });
  }),
);

// ---------- Push registration (bound to the current session/device) ----------

router.post(
  '/push/expo',
  validate({ body: z.object({ token: z.string().min(10).max(200).nullable() }) }),
  asyncHandler(async (req, res) => {
    const { sessionId } = getAuth(req);
    // A device token belongs to one session at a time.
    if (req.body.token) await UserSession.updateMany({ expoPushToken: req.body.token, _id: { $ne: sessionId } }, { expoPushToken: null });
    await UserSession.updateOne({ _id: sessionId }, { expoPushToken: req.body.token });
    res.json({ ok: true });
  }),
);

router.get('/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: vapidPublicKey() });
});

router.post(
  '/push/web',
  validate({
    body: z.object({
      subscription: z
        .object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) })
        .nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { sessionId } = getAuth(req);
    await UserSession.updateOne({ _id: sessionId }, { webPush: req.body.subscription });
    res.json({ ok: true });
  }),
);

export default router;
