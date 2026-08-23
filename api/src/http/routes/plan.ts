import { Router } from 'express';
import {
  listPlanJobs,
  upsertPlanJob,
  deletePlanJob,
  listPlanAnswers,
  upsertPlanAnswer,
  planProbe,
  PlanJobInput,
  PlanAnswerInput,
} from '../../services/plan.js';
import { requireAdmin } from '../middleware.js';
import { wrap } from '../async.js';

export const planRouter = Router();

/**
 * The architecture workbench's storage.
 *
 * ADMIN ONLY, every route, no exceptions. This is not a consumer-app surface:
 * there is no key that should reach it, and `requireReader` would have admitted
 * one. Read routes elsewhere use requireReader on purpose; this one does not,
 * and the difference is deliberate rather than an oversight.
 *
 * Writes are PER ROW. Two people editing different jobs never collide, so
 * there is no revision counter, no conflict response and no merge to get wrong.
 * The cost of that choice, stated plainly: two people editing the SAME job in
 * the same few seconds is still last-write-wins. The UI shows who touched a row
 * and when, which is the honest amount of protection for a two-person tool.
 */

/** Everything the tool needs in one round trip, so opening it is one request. */
planRouter.get(
  '/',
  requireAdmin,
  wrap(async (_req, res) => {
    const [jobs, answers, probe] = await Promise.all([
      listPlanJobs(),
      listPlanAnswers(),
      planProbe(),
    ]);
    res.json({ jobs, answers, probe });
  }),
);

/** Live counts on their own, for the poll that keeps the header honest. */
planRouter.get(
  '/probe',
  requireAdmin,
  wrap(async (_req, res) => {
    res.json(await planProbe());
  }),
);

/**
 * Upsert one job. The slug in the path wins over anything in the body - a body
 * that disagrees with its own URL is a caller bug, and silently trusting the
 * body would let one request rewrite a different row than the one addressed.
 */
planRouter.put(
  '/jobs/:slug',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = PlanJobInput.safeParse({ ...req.body, slug: req.params.slug });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const row = await upsertPlanJob(parsed.data, req.admin!.email);
    res.json(row);
  }),
);

planRouter.delete(
  '/jobs/:slug',
  requireAdmin,
  wrap(async (req, res) => {
    const gone = await deletePlanJob(req.params.slug);
    if (!gone) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);

planRouter.put(
  '/answers/:key',
  requireAdmin,
  wrap(async (req, res) => {
    const key = req.params.key;
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key)) {
      res.status(400).json({ error: 'invalid key' });
      return;
    }
    const parsed = PlanAnswerInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    res.json(await upsertPlanAnswer(key, parsed.data.answer, req.admin!.email));
  }),
);

/**
 * Load the researched catalogue - but ONLY into an empty table.
 *
 * Refusing when rows already exist is the point. This is the one endpoint that
 * writes many rows at once, and the failure it is designed to prevent is
 * someone re-seeding mid-session and flattening edits that were made in the
 * room. `npm run seed` rotating the consumer key unconditionally on every run
 * is the same shape of mistake, and it has already cost this project a key.
 */
planRouter.post(
  '/seed',
  requireAdmin,
  wrap(async (req, res) => {
    const existing = await listPlanJobs();
    if (existing.length > 0) {
      res.status(409).json({
        error: 'plan_jobs is not empty',
        detail: `${existing.length} job(s) already stored. Seeding would overwrite work done in a session. Delete them first if that is really what you want.`,
      });
      return;
    }
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : null;
    if (!jobs || jobs.length === 0) {
      res.status(400).json({ error: 'body must be { jobs: [...] }' });
      return;
    }
    if (jobs.length > 200) {
      res.status(400).json({ error: 'refusing to seed more than 200 jobs at once' });
      return;
    }
    const written = [];
    for (const [i, raw] of jobs.entries()) {
      const parsed = PlanJobInput.safeParse({ ...raw, origin: 'catalogue', sort_order: i });
      if (!parsed.success) {
        res.status(400).json({ error: `job ${i} invalid`, detail: parsed.error.flatten() });
        return;
      }
      written.push(await upsertPlanJob(parsed.data, req.admin!.email));
    }
    res.status(201).json({ seeded: written.length, jobs: written });
  }),
);
