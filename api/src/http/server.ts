import express from 'express';
import { highlightsRouter } from './routes/highlights.js';
import { authRouter } from './routes/auth.js';

export function createServer(): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/highlights', highlightsRouter);

  return app;
}
