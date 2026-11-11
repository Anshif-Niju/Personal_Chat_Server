import type { Request, Response, NextFunction } from 'express';
import { z, ZodTypeAny } from 'zod';
import { Types } from 'mongoose';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/** Parses and replaces req.body/query/params with validated (and stripped) values. */
export const validate = (schemas: Schemas) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
    if (schemas.query) req.query = schemas.query.parse(req.query);
    if (schemas.params) req.params = schemas.params.parse(req.params);
    next();
  } catch (err) {
    next(err);
  }
};

export const objectId = z.string().refine((v) => Types.ObjectId.isValid(v) && /^[a-f0-9]{24}$/i.test(v), 'Invalid id');
export const idParam = z.object({ id: objectId });
