import type { Request, Response, NextFunction, RequestHandler } from 'express';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public details?: unknown,
  ) {
    super(message);
  }
  static badRequest(msg = 'Bad request', details?: unknown) {
    return new ApiError(400, msg, 'bad_request', details);
  }
  static unauthorized(msg = 'Unauthorized') {
    return new ApiError(401, msg, 'unauthorized');
  }
  static forbidden(msg = 'Forbidden') {
    return new ApiError(403, msg, 'forbidden');
  }
  static notFound(msg = 'Not found') {
    return new ApiError(404, msg, 'not_found');
  }
  static conflict(msg = 'Conflict') {
    return new ApiError(409, msg, 'conflict');
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
