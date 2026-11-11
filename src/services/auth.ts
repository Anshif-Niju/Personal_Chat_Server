import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { UserSession, IUserSession } from '../models/UserSession';
import { generateRefreshToken, parseRefreshToken, sha256, signAccessToken, safeEqual } from '../utils/tokens';
import { ApiError } from '../utils/errors';
import { revokeSessionSockets } from './realtime';

export const REFRESH_COOKIE = 'pc_rt';
const REFRESH_REUSE_GRACE_MS = 15_000;
const BCRYPT_COST = 12;

export const hashPassword = (pw: string) => bcrypt.hash(pw, BCRYPT_COST);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

type Platform = IUserSession['platform'];

export function clientPlatform(req: Request): Platform {
  const p = String(req.headers['x-client-platform'] ?? '').toLowerCase();
  return p === 'web' || p === 'ios' || p === 'android' ? p : 'unknown';
}

export function deviceNameFrom(req: Request): string {
  const explicit = req.headers['x-device-name'];
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().slice(0, 100);
  const ua = req.headers['user-agent'] ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

export async function createSession(userId: Types.ObjectId | string, req: Request) {
  const session = new UserSession({
    userId,
    deviceName: deviceNameFrom(req),
    platform: clientPlatform(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
    ip: req.ip,
    refreshTokenHash: 'pending',
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000),
  });
  const refreshToken = generateRefreshToken(String(session._id));
  session.refreshTokenHash = sha256(refreshToken);
  await session.save();
  return { session, refreshToken, accessToken: signAccessToken(String(userId), String(session._id)) };
}

/** Rotates a refresh token. Detects re-use of an old token and revokes the session if so. */
export async function rotateRefreshToken(token: string) {
  const parsed = parseRefreshToken(token);
  if (!parsed) throw ApiError.unauthorized('Invalid refresh token');
  const session = await UserSession.findById(parsed.sessionId);
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw ApiError.unauthorized('Session expired');

  const hash = sha256(token);
  const isCurrent = safeEqual(hash, session.refreshTokenHash);
  const isRecentPrevious =
    !!session.previousTokenHash &&
    safeEqual(hash, session.previousTokenHash) &&
    !!session.rotatedAt &&
    Date.now() - session.rotatedAt.getTime() < REFRESH_REUSE_GRACE_MS;

  if (!isCurrent && !isRecentPrevious) {
    // Token re-use → likely stolen. Kill the session.
    session.revokedAt = new Date();
    await session.save();
    revokeSessionSockets(String(session._id));
    throw ApiError.unauthorized('Session revoked');
  }

  const next = generateRefreshToken(String(session._id));
  session.previousTokenHash = session.refreshTokenHash;
  session.refreshTokenHash = sha256(next);
  session.rotatedAt = new Date();
  session.lastActive = new Date();
  session.expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000);
  await session.save();

  return {
    userId: String(session.userId),
    sessionId: String(session._id),
    refreshToken: next,
    accessToken: signAccessToken(String(session.userId), String(session._id)),
  };
}

export async function revokeSessions(filter: Record<string, unknown>) {
  const sessions = await UserSession.find({ ...filter, revokedAt: null }).select('_id').lean();
  if (sessions.length === 0) return 0;
  const ids = sessions.map((s) => s._id);
  await UserSession.updateMany({ _id: { $in: ids } }, { revokedAt: new Date(), expoPushToken: null, webPush: null });
  revokeSessionSockets(ids.map(String));
  return ids.length;
}

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400_000,
  });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/api/auth' });
}

/** Web clients get the refresh token as an httpOnly cookie; native clients get it in the body. */
export function sendAuthResponse(
  req: Request,
  res: Response,
  status: number,
  data: { user: unknown; accessToken: string; refreshToken: string },
) {
  if (clientPlatform(req) === 'web') {
    setRefreshCookie(res, data.refreshToken);
    return res.status(status).json({ user: data.user, accessToken: data.accessToken });
  }
  return res.status(status).json(data);
}
