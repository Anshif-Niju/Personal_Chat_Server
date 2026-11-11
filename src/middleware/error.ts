import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { ApiError } from '../utils/errors';
import { env } from '../config/env';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input',
        details: err.flatten(),
      },
    });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${env.MAX_UPLOAD_MB} MB)` : err.message;
    return res.status(400).json({ error: { code: 'upload_error', message } });
  }
  const e = err as { code?: number; keyValue?: Record<string, unknown>; name?: string; message?: string };
  if (e?.code === 11000) {
    const field = Object.keys(e.keyValue ?? {})[0] ?? 'value';
    return res.status(409).json({ error: { code: 'conflict', message: `That ${field} is already taken` } });
  }
  if (e?.name === 'CastError') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Invalid identifier' } });
  }
  // eslint-disable-next-line no-console
  console.error('[error]', err);
  return res.status(500).json({
    error: { code: 'internal', message: env.isProd ? 'Something went wrong' : e?.message ?? 'Internal error' },
  });
}
