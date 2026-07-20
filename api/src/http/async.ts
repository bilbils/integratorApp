import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler / middleware so a rejected promise is forwarded
 * to Express's error handler instead of crashing the process.
 */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
