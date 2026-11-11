import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

/** Removes keys starting with "$" or containing "." (MongoDB operator injection). */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  if (req.body) req.body = scrub(req.body);
  if (req.query) req.query = scrub(req.query) as Request['query'];
  next();
}

const skip = () => env.isTest;

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  message: { error: { code: 'rate_limited', message: 'Too many requests, slow down.' } },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  skipSuccessfulRequests: true,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' } },
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip,
  message: { error: { code: 'rate_limited', message: 'Too many uploads, slow down.' } },
});
