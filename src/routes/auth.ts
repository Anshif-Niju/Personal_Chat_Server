import { Router } from 'express';
import { z } from 'zod';
import { User, USERNAME_REGEX } from '../models/User';
import { UserSettings } from '../models/UserSettings';
import { UserSession } from '../models/UserSession';
import { validate } from '../middleware/validate';
import { requireAuth, getAuth } from '../middleware/auth';
import { authLimiter } from '../middleware/security';
import { asyncHandler, ApiError } from '../utils/errors';
import { toMe } from '../utils/serializers';
import { randomToken, sha256 } from '../utils/tokens';
import { env } from '../config/env';
import { sendPasswordResetEmail } from '../services/mail';
import { connectNewUser } from '../services/conversations';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  createSession,
  hashPassword,
  revokeSessions,
  rotateRefreshToken,
  sendAuthResponse,
  verifyPassword,
} from '../services/auth';
import { parseRefreshToken } from '../utils/tokens';

const router = Router();

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_REGEX, 'Username must be 3-30 characters: lowercase letters, numbers, "_" or "."');

const registerSchema = z
  .object({
    username: usernameSchema,
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('Invalid email')
      .max(254)
      .optional()
      .or(z.literal('').transform(() => undefined)),
    password: passwordSchema,
    confirmPassword: z.string(),
    displayName: z.string().trim().min(1, 'Display name is required').max(50),
  })
  .refine((d) => d.password === d.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

// A real bcrypt hash used to keep login timing constant for unknown users.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password-0'));

router.post(
  '/register',
  authLimiter,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { username, email, password, displayName } = req.body as z.infer<typeof registerSchema>;
    if (await User.exists({ username })) throw ApiError.conflict('That username is already taken');
    if (email && (await User.exists({ email }))) throw ApiError.conflict('That email is already registered');

    const user = await User.create({ username, email, displayName, passwordHash: await hashPassword(password) });
    await UserSettings.create({ userId: user._id });
    await connectNewUser(String(user._id)).catch(() => undefined);
    const { accessToken, refreshToken } = await createSession(user._id, req);
    sendAuthResponse(req, res, 201, { user: toMe(user.toObject()), accessToken, refreshToken });
  }),
);

/** "alice", "@alice" → username lookup; "a@b.com" → email lookup. */
function identifierQuery(identifier: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier) ? { email: identifier } : { username: identifier.replace(/^@/, '') };
}

const loginSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(1, 'Username or email is required').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});

router.post(
  '/login',
  authLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body as z.infer<typeof loginSchema>;
    const query = identifierQuery(identifier);
    const user = await User.findOne(query).select('+passwordHash');
    const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !ok) throw ApiError.unauthorized('Incorrect username/email or password');

    const { accessToken, refreshToken } = await createSession(user._id, req);
    const obj = user.toObject() as unknown as Record<string, unknown>;
    delete obj.passwordHash;
    sendAuthResponse(req, res, 200, { user: toMe(obj), accessToken, refreshToken });
  }),
);

router.post(
  '/refresh',
  validate({ body: z.object({ refreshToken: z.string().max(200).optional() }) }),
  asyncHandler(async (req, res) => {
    const token: string | undefined = req.body.refreshToken || req.cookies?.[REFRESH_COOKIE];
    if (!token) throw ApiError.unauthorized('No refresh token');
    try {
      const result = await rotateRefreshToken(token);
      const user = await User.findById(result.userId).lean();
      if (!user) throw ApiError.unauthorized('Account not found');
      sendAuthResponse(req, res, 200, { user: toMe(user), accessToken: result.accessToken, refreshToken: result.refreshToken });
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  }),
);

router.post(
  '/logout',
  validate({ body: z.object({ refreshToken: z.string().max(200).optional() }) }),
  asyncHandler(async (req, res) => {
    const token: string | undefined = req.body.refreshToken || req.cookies?.[REFRESH_COOKIE];
    const parsed = token ? parseRefreshToken(token) : null;
    if (parsed && token) {
      // Only revoke if the presented token really belongs to the session.
      const session = await UserSession.findById(parsed.sessionId).select('refreshTokenHash previousTokenHash').lean();
      const hash = sha256(token);
      if (session && (session.refreshTokenHash === hash || session.previousTokenHash === hash)) {
        await revokeSessions({ _id: session._id });
      }
    }
    clearRefreshCookie(res);
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(getAuth(req).userId).lean();
    if (!user) throw ApiError.notFound('Account not found');
    res.json({ user: toMe(user) });
  }),
);

router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: z.object({ identifier: z.string().trim().toLowerCase().min(1).max(254) }) }),
  asyncHandler(async (req, res) => {
    const { identifier } = req.body as { identifier: string };
    const query = identifierQuery(identifier);
    const user = await User.findOne(query);
    if (user?.email) {
      const token = randomToken(32);
      user.resetTokenHash = sha256(token);
      user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save();
      await sendPasswordResetEmail(user.email, user.displayName, `${env.webAppUrl}/reset-password?token=${token}`);
    }
    // Same response whether or not the account exists (no user enumeration).
    res.json({
      ok: true,
      message: 'If an account with a recovery email exists, a reset link has been sent.',
    });
  }),
);

const resetSchema = z
  .object({ token: z.string().min(10).max(200), password: passwordSchema, confirmPassword: z.string() })
  .refine((d) => d.password === d.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetSchema }),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body as z.infer<typeof resetSchema>;
    const user = await User.findOne({ resetTokenHash: sha256(token), resetTokenExpires: { $gt: new Date() } });
    if (!user) throw ApiError.badRequest('This reset link is invalid or has expired');
    user.passwordHash = await hashPassword(password);
    user.passwordChangedAt = new Date();
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    await user.save();
    await revokeSessions({ userId: user._id });
    res.json({ ok: true });
  }),
);

const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });

router.post(
  '/change-password',
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const { userId, sessionId } = getAuth(req);
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
    const user = await User.findById(userId).select('+passwordHash');
    if (!user) throw ApiError.notFound();
    if (!(await verifyPassword(currentPassword, user.passwordHash))) throw ApiError.badRequest('Current password is incorrect');
    user.passwordHash = await hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    await user.save();
    // Keep this device, sign out everything else.
    const revoked = await revokeSessions({ userId: user._id, _id: { $ne: sessionId } });
    res.json({ ok: true, revokedSessions: revoked });
  }),
);

export default router;
