import { Router } from 'express';
import {
  listPlanOptions,
  upsertPlanOption,
  deletePlanOption,
  bulkUpsertPlanOptions,
  countPlanOptions,
  PlanOptionInput,
} from '../../services/planOptions.js';
import { requireAdmin } from '../middleware.js';
import { wrap } from '../async.js';

export const planOptionsRouter = Router();

/**
 * The plan's options catalogue - the vendors on the table per option set.
 *
 * ADMIN ONLY, every route, no exceptions, same rule as plan.ts and for the
 * same reason: this is not a consumer-app surface, there is no key that
 * should reach it, and `requireReader` would have admitted one.
 *
 * Writes are PER ROW, same as plan.ts. Two people editing options in
 * different sets never collide.
 */

planOptionsRouter.get(
  '/',
  requireAdmin,
  wrap(async (_req, res) => {
    res.json({ options: await listPlanOptions() });
  }),
);

/**
 * Upsert one option. The slug in the path wins over anything in the body - a
 * body that disagrees with its own URL is a caller bug, and silently trusting
 * the body would let one request rewrite a different row than the one
 * addressed.
 */
planOptionsRouter.put(
  '/:slug',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = PlanOptionInput.safeParse({ ...req.body, slug: req.params.slug });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const row = await upsertPlanOption(parsed.data, req.admin!.email);
    res.json(row);
  }),
);

planOptionsRouter.delete(
  '/:slug',
  requireAdmin,
  wrap(async (req, res) => {
    const gone = await deletePlanOption(req.params.slug);
    if (!gone) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);

/**
 * Load the researched catalogue - but ONLY into an empty table.
 *
 * Refusing when rows already exist is the point, same rule as plan.ts's
 * `/seed`. The failure it prevents is someone re-seeding mid-session and
 * flattening what was agreed in the room. `npm run seed` rotating the
 * consumer key unconditionally on every run is the same shape of mistake, and
 * it has already cost this project a key.
 */
planOptionsRouter.post(
  '/seed',
  requireAdmin,
  wrap(async (req, res) => {
    const existing = await countPlanOptions();
    if (existing > 0) {
      res.status(409).json({
        error: 'plan_options is not empty',
        detail: `${existing} option(s) already stored. Seeding would overwrite work done in a session. Delete them first if that is really what you want.`,
      });
      return;
    }
    const options = Array.isArray(req.body?.options) ? req.body.options : null;
    if (!options || options.length === 0) {
      res.status(400).json({ error: 'body must be { options: [...] }' });
      return;
    }
    if (options.length > 500) {
      res.status(400).json({ error: 'refusing to seed more than 500 options at once' });
      return;
    }
    for (const [i, raw] of options.entries()) {
      const parsed = PlanOptionInput.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({ error: `option ${i} invalid`, detail: parsed.error.flatten() });
        return;
      }
    }
    const inserted = await bulkUpsertPlanOptions(options, req.admin!.email);
    res.status(201).json({ inserted });
  }),
);
