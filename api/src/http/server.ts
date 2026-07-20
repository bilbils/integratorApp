import express, { type Request, type Response, type NextFunction } from 'express';
import { highlightsRouter } from './routes/highlights.js';
import { authRouter } from './routes/auth.js';

export function createServer(): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/highlights', highlightsRouter);

  // Central error handler: log the real error, return a clean 500 (never crash).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return app;
}
