import { Router } from 'express';
import {
  listAdrs,
  upsertAdr,
  deleteAdr,
  countAdrs,
  listReconcile,
  upsertReconcile,
  countReconcile,
  listIssues,
  upsertIssue,
  deleteIssue,
  countIssues,
  seedAll,
  reconcileSummary,
  PlanAdrInput,
  PlanReconcileInput,
  PlanIssueInput,
} from '../../services/planReconcile.js';
import { requireAdmin } from '../middleware.js';
import { wrap } from '../async.js';

export const planReconcileRouter = Router();

/**
 * Reconciling the plan against Josh's ADRs.
 *
 * ADMIN ONLY, every route, no exceptions, same rule as plan.ts and
 * planOptions.ts and for the same reason: this is not a consumer-app
 * surface, there is no key that should reach it, and `requireReader` would
 * have admitted one.
 *
 * Writes are PER ROW except `/seed`, same shape as planOptions.ts.
 */

/** Everything the tool needs in one round trip, so opening it is one request. */
planReconcileRouter.get(
  '/',
  requireAdmin,
  wrap(async (_req, res) => {
    const [adrs, reconcile, issues, summary] = await Promise.all([
      listAdrs(),
      listReconcile(),
      listIssues(),
      reconcileSummary(),
    ]);
    res.json({ adrs, reconcile, issues, summary });
  }),
);

/**
 * Upsert one ADR. The number in the path wins over anything in the body - a
 * body that disagrees with its own URL is a caller bug, and silently
 * trusting the body would let one request rewrite a different row than the
 * one addressed.
 */
planReconcileRouter.put(
  '/adrs/:number',
  requireAdmin,
  wrap(async (req, res) => {
    const number = Number(req.params.number);
    const parsed = PlanAdrInput.safeParse({ ...req.body, number });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const row = await upsertAdr(parsed.data, req.admin!.email);
    res.json(row);
  }),
);

planReconcileRouter.delete(
  '/adrs/:number',
  requireAdmin,
  wrap(async (req, res) => {
    const number = Number(req.params.number);
    if (!Number.isInteger(number)) {
      res.status(400).json({ error: 'number must be an integer' });
      return;
    }
    const gone = await deleteAdr(number);
    if (!gone) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);

/**
 * Upsert one decision set's reconciliation. The setKey in the path wins over
 * anything in the body, same rule as every other upsert-by-path route.
 */
planReconcileRouter.put(
  '/sets/:setKey',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = PlanReconcileInput.safeParse({ ...req.body, set_key: req.params.setKey });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const row = await upsertReconcile(parsed.data, req.admin!.email);
    res.json(row);
  }),
);

planReconcileRouter.put(
  '/issues/:slug',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = PlanIssueInput.safeParse({ ...req.body, slug: req.params.slug });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const row = await upsertIssue(parsed.data, req.admin!.email);
    res.json(row);
  }),
);

planReconcileRouter.delete(
  '/issues/:slug',
  requireAdmin,
  wrap(async (req, res) => {
    const gone = await deleteIssue(req.params.slug);
    if (!gone) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);

/**
 * Load the ADRs, reconciliations and issues worked out ahead of time - but
 * ONLY into empty tables.
 *
 * Refusing when any of the three already has rows is the point, same rule as
 * plan.ts's and planOptions.ts's `/seed`. The failure it prevents is someone
 * re-seeding mid-session and flattening a reconciliation that was argued out
 * in the room. All three tables are written in one transaction (`seedAll`),
 * so a bad row anywhere in the batch leaves none of the three touched, not a
 * catalogue that is half ADRs and half not.
 */
planReconcileRouter.post(
  '/seed',
  requireAdmin,
  wrap(async (req, res) => {
    const [adrCount, reconcileCount, issueCount] = await Promise.all([
      countAdrs(),
      countReconcile(),
      countIssues(),
    ]);
    if (adrCount > 0 || reconcileCount > 0 || issueCount > 0) {
      res.status(409).json({
        error: 'plan_adrs, plan_reconcile or plan_issues is not empty',
        detail: `${adrCount} adr(s), ${reconcileCount} reconciliation(s), ${issueCount} issue(s) already stored. Seeding would overwrite work done in a session. Delete them first if that is really what you want.`,
      });
      return;
    }

    const adrs = Array.isArray(req.body?.adrs) ? req.body.adrs : [];
    const reconcile = Array.isArray(req.body?.reconcile) ? req.body.reconcile : [];
    const issues = Array.isArray(req.body?.issues) ? req.body.issues : [];
    if (adrs.length === 0 && reconcile.length === 0 && issues.length === 0) {
      res.status(400).json({ error: 'body must include at least one of { adrs, reconcile, issues }' });
      return;
    }
    if (adrs.length > 500 || reconcile.length > 500 || issues.length > 500) {
      res.status(400).json({ error: 'refusing to seed more than 500 rows in one table at once' });
      return;
    }

    for (const [i, raw] of adrs.entries()) {
      const parsed = PlanAdrInput.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({ error: `adrs[${i}] invalid`, detail: parsed.error.flatten() });
        return;
      }
    }
    for (const [i, raw] of reconcile.entries()) {
      const parsed = PlanReconcileInput.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({ error: `reconcile[${i}] invalid`, detail: parsed.error.flatten() });
        return;
      }
    }
    for (const [i, raw] of issues.entries()) {
      const parsed = PlanIssueInput.safeParse(raw);
      if (!parsed.success) {
        res.status(400).json({ error: `issues[${i}] invalid`, detail: parsed.error.flatten() });
        return;
      }
    }

    const counts = await seedAll({ adrs, reconcile, issues }, req.admin!.email);
    res.status(201).json(counts);
  }),
);
