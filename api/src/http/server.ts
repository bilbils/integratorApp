import express, { type Request, type Response, type NextFunction } from 'express';
import { highlightsRouter } from './routes/highlights.js';
import { agentsRouter } from './routes/agents.js';
import { consumerAppsRouter } from './routes/consumerApps.js';
import { authRouter } from './routes/auth.js';
import { planRouter } from './routes/plan.js';
import { VERSION, BUILD_STAMP } from '../version.js';
import { config } from '../config.js';

// Allowed browser origins come from config (CORS_ORIGINS), defaulting to the
// local Angular dev server. Adding a hosted admin is an env change, not a code
// change - and if the admin is proxied onto the same origin, none of this runs.
const allowedOrigins = new Set<string>(config.corsOrigins);

export function createServer(): express.Express {
  const app = express();

  // CORS + preflight (runs before body parsing so OPTIONS returns immediately).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json());

  // Health doubles as the version probe the admin masthead reads, so a UI/API
  // mismatch after a partial deploy is visible instead of mysterious.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, version: VERSION, build: BUILD_STAMP });
  });

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/highlights', highlightsRouter);
  app.use('/api/v1/agents', agentsRouter);
  app.use('/api/v1/consumer-apps', consumerAppsRouter);
  // The architecture workbench's own storage. Admin-only on every route -
  // there is no consumer key that should reach the plan.
  app.use('/api/v1/plan', planRouter);

  // Central error handler: log the real error, return a clean 500 (never crash).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return app;
}
