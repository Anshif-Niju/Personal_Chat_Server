import type { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { UserSession } from '../models/UserSession';
import { ApiError } from '../utils/errors';
import { verifyAccessToken, AccessPayload } from '../utils/tokens';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessPayload;
    }
  }
}

const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/** Verifies the JWT and that the session still exists and is not revoked. */
export async function authenticateToken(token: string): Promise<AccessPayload> {
  let payload: AccessPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired token');
  }
  if (!Types.ObjectId.isValid(payload.sessionId)) throw ApiError.unauthorized();
  const session = await UserSession.findById(payload.sessionId).select('userId revokedAt expiresAt lastActive').lean();
  if (!session || session.revokedAt || session.expiresAt < new Date() || String(session.userId) !== payload.userId) {
    throw ApiError.unauthorized('Session expired');
  }
  if (Date.now() - new Date(session.lastActive).getTime() > ACTIVITY_WRITE_INTERVAL_MS) {
    UserSession.updateOne({ _id: session._id }, { lastActive: new Date() }).catch(() => undefined);
  }
  return payload;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw ApiError.unauthorized('Missing access token');
    req.auth = await authenticateToken(header.slice(7));
    next();
  } catch (err) {
    next(err);
  }
}

export function getAuth(req: Request): AccessPayload {
  if (!req.auth) throw ApiError.unauthorized();
  return req.auth;
}
