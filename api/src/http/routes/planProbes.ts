import { Router } from 'express';
import {
  ProbeConfigInput,
  runProbe,
  recordProbe,
  getProbeOption,
  setProbeConfig,
  runAllProbes,
} from '../../services/planProbes.js';
import { requireAdmin } from '../middleware.js';
import { wrap } from '../async.js';

export const planProbesRouter = Router();

/**
 * The "is this actually built?" probe, riding the plan_options router's own
 * path prefix (mounted separately - see server.plan-probes.patch.md - so
 * this file never has to touch planOptions.ts).
 *
 * ADMIN ONLY, every route, no exceptions, same rule as plan.ts and
 * planOptions.ts: this is not a consumer-app surface, and `requireReader`
 * would have admitted a consumer key to a write-capable path (run-all makes
 * outbound HTTP calls on the server's behalf).
 *
 * PUT sets what to check. POST runs it. Those are deliberately two different
 * requests - defining a probe never fires it, so a PUT can't be mistaken for
 * proof of anything.
 */

planProbesRouter.put(
  '/:slug/probe',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = ProbeConfigInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const row = await setProbeConfig(req.params.slug, parsed.data.probe_kind, parsed.data.probe_config);
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(row);
  }),
);

planProbesRouter.post(
  '/:slug/probe/run',
  requireAdmin,
  wrap(async (req, res) => {
    const option = await getProbeOption(req.params.slug);
    if (!option) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const result = await runProbe(option, req.admin!.email);
    const row = await recordProbe(option.slug, result, req.admin!.email);
    res.json(row);
  }),
);

planProbesRouter.post(
  '/probe/run-all',
  requireAdmin,
  wrap(async (req, res) => {
    const summary = await runAllProbes(req.admin!.email);
    res.json(summary);
  }),
);
