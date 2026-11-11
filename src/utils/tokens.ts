import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AccessPayload {
  userId: string;
  sessionId: string;
}

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sid: sessionId }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'privatechat',
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'privatechat' }) as jwt.JwtPayload;
  if (!decoded.sub || typeof decoded.sid !== 'string') throw new Error('Malformed token');
  return { userId: decoded.sub, sessionId: decoded.sid };
}

/** Opaque refresh token: "<sessionId>.<random>". Only its SHA-256 is stored. */
export function generateRefreshToken(sessionId: string): string {
  return `${sessionId}.${crypto.randomBytes(48).toString('base64url')}`;
}

export function parseRefreshToken(token: string): { sessionId: string } | null {
  const [sessionId, secret] = token.split('.');
  if (!sessionId || !secret || !/^[a-f0-9]{24}$/.test(sessionId)) return null;
  return { sessionId };
}

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** HMAC-signed, expiring payloads (upload tokens, local media URLs). */
export function signPayload(payload: object, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', env.MEDIA_SIGNING_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPayload<T>(token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', env.MEDIA_SIGNING_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp: number };
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}
