import express, { type Request, type Response, type NextFunction } from 'express';
import { highlightsRouter } from './routes/highlights.js';
import { authRouter } from './routes/auth.js';

// Dev CORS: allow the Angular dev server (localhost:4200) to call the API
// cross-origin. For production, drive the allowed origin(s) from env config.
const allowedOrigins = new Set<string>([
  'http://localhost:4200',
  'http://127.0.0.1:4200',
]);

export function createServer(): express.Express {
  const app = express();

  // CORS + preflight (runs before body parsing so OPTIONS returns immediately).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
