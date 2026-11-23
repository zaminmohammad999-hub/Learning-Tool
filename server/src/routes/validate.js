import { z } from 'zod';
import { HttpError } from '../services/common.js';

export { z };

/** Parse req.body (or another value) with a zod schema, raising a 400 with readable issues. */
export function parse(schema, value) {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new HttpError(400, `Invalid input — ${issues.join('; ')}`, { issues });
  }
  return r.data;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const optDate = z.union([isoDate, z.literal(''), z.null()]).optional();
export const lessonId = z.string().regex(/^L\d{2}$/);
export const exerciseId = z.string().regex(/^D\d-C\d-(E|X)\d+$/);
export const competencyId = z.string().regex(/^D\d-C\d$/);
export const actorOf = (req) => (typeof req.get('x-actor') === 'string' && req.get('x-actor').slice(0, 80)) || 'user';
