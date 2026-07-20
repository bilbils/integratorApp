import type { Request, Response, NextFunction } from 'express';
import { verifyConsumerKey, verifyAdminJwt, type ConsumerIdentity, type AdminIdentity } from '../services/auth.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      consumer?: ConsumerIdentity;
      admin?: AdminIdentity;
    }
  }
}

export function bearer(req: Request): string | undefined {
  const h = req.header('authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7) : undefined;
}

export async function requireConsumer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const consumer = await verifyConsumerKey(bearer(req));
  if (!consumer) { res.status(401).json({ error: 'invalid consumer key' }); return; }
  req.consumer = consumer;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const admin = verifyAdminJwt(bearer(req));
  if (!admin) { res.status(401).json({ error: 'unauthorized' }); return; }
  req.admin = admin;
  next();
}

/** Read access: a valid admin session OR a valid consumer key. */
export async function requireReader(req: Request, res: Response, next: NextFunction): Promise<void> {
  const admin = verifyAdminJwt(bearer(req));
  if (admin) { req.admin = admin; next(); return; }
  const consumer = await verifyConsumerKey(bearer(req));
  if (consumer) { req.consumer = consumer; next(); return; }
  res.status(401).json({ error: 'unauthorized' });
}
