import { Router } from 'express';
import {
  createHighlight,
  listHighlights,
  getHighlight,
  HighlightInput,
  HighlightQuery,
} from '../../services/highlights.js';
import { checkIngestToken } from '../../services/auth.js';
import { requireConsumer, bearer } from '../middleware.js';

export const highlightsRouter = Router();

// Capture (push) - ingest token auth.
highlightsRouter.post('/', async (req, res) => {
  if (!checkIngestToken(bearer(req))) {
    res.status(401).json({ error: 'invalid ingest token' });
    return;
  }
  const parsed = HighlightInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const row = await createHighlight(parsed.data);
  res.status(201).json(row);
});

// Read (list) - consumer key auth.
highlightsRouter.get('/', requireConsumer, async (req, res) => {
  const parsed = HighlightQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  res.json(await listHighlights(parsed.data));
});

// Read (single) - consumer key auth.
highlightsRouter.get('/:id', requireConsumer, async (req, res) => {
  const row = await getHighlight(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(row);
});
