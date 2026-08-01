import { Router } from 'express';
import type { Request } from 'express';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  recordRun,
  spendByApp,
  AgentInput,
  AgentPatch,
  AgentQuery,
  RunInput,
  BadRequest,
  type Viewer,
} from '../../services/agents.js';
import {
  invokeAgent,
  listModels,
  GatewayNotConfigured,
  GatewayError,
} from '../../services/gateway.js';
import { requireAdmin, requireReader, bearer } from '../middleware.js';
import { checkIngestToken } from '../../services/auth.js';
import { wrap } from '../async.js';
import { z } from 'zod';

export const agentsRouter = Router();

/**
 * Reads are scoped: an admin session sees every agent, a consumer key sees
 * only the enabled agents it has been granted. Writes are admin-only.
 */
function viewerFor(req: Request): Viewer {
  return req.admin ? { kind: 'admin' } : { kind: 'consumer', consumerAppId: req.consumer!.id };
}

/** Postgres unique-violation - the only write error worth a specific message. */
function isDuplicateSlug(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// --- Reads -----------------------------------------------------------------

// List. Admin session OR consumer key.
agentsRouter.get(
  '/',
  wrap(requireReader),
  wrap(async (req, res) => {
    const parsed = AgentQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    res.json(await listAgents(parsed.data, viewerFor(req)));
  }),
);

// Spend per consumer app. Admin only - this is the money view.
agentsRouter.get(
  '/spend',
  requireAdmin,
  wrap(async (req, res) => {
    const days = Number(req.query.days ?? 30);
    res.json(await spendByApp(Number.isFinite(days) ? days : 30));
  }),
);

// The live model catalogue from the gateway, for the model picker.
// Empty array when the gateway isn't configured - the screen degrades to a
// plain text field rather than breaking.
agentsRouter.get(
  '/models',
  requireAdmin,
  wrap(async (_req, res) => {
    res.json(await listModels());
  }),
);

// Single, by uuid or slug. Admin session OR consumer key.
agentsRouter.get(
  '/:idOrSlug',
  wrap(requireReader),
  wrap(async (req, res) => {
    const agent = await getAgent(req.params.idOrSlug, viewerFor(req));
    if (!agent) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(agent);
  }),
);

// --- Writes (admin only) ---------------------------------------------------

agentsRouter.post(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = AgentInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      res.status(201).json(await createAgent(parsed.data));
    } catch (err) {
      if (isDuplicateSlug(err)) {
        res.status(409).json({ error: 'an agent with that slug already exists' });
        return;
      }
      if (err instanceof BadRequest) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

agentsRouter.patch(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = AgentPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const agent = await updateAgent(req.params.id, parsed.data);
      if (!agent) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(agent);
    } catch (err) {
      if (isDuplicateSlug(err)) {
        res.status(409).json({ error: 'an agent with that slug already exists' });
        return;
      }
      throw err;
    }
  }),
);

agentsRouter.delete(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const removed = await deleteAgent(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);

// --- Invoke ----------------------------------------------------------------

const InvokeBody = z.object({
  input: z.string().min(1).max(200_000),
});

/**
 * Run an agent. This is the gateway's whole point: one door, and the caller
 * never picks a model or holds a provider key.
 *
 * Reader auth, then the same scoping as every other read - `getAgent` with the
 * caller's viewer returns null unless the agent is enabled AND granted to that
 * consumer app, so a consumer cannot invoke something it can't see. Every
 * attempt, including failures, lands in the cost/outcome log.
 */
agentsRouter.post(
  '/:idOrSlug/invoke',
  wrap(requireReader),
  wrap(async (req, res) => {
    const parsed = InvokeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const viewer = viewerFor(req);
    const agent = await getAgent(req.params.idOrSlug, viewer);
    if (!agent) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Admins can see disabled agents; nobody gets to run one.
    if (!agent.enabled) {
      res.status(409).json({ error: 'that agent is switched off' });
      return;
    }

    const consumerAppId = viewer.kind === 'consumer' ? viewer.consumerAppId : null;
    try {
      res.json(await invokeAgent(agent, parsed.data.input, consumerAppId));
    } catch (err) {
      if (err instanceof GatewayNotConfigured) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof GatewayError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

// --- Cost / outcome log ----------------------------------------------------

/**
 * Record one call. Ingest-token auth, same as highlights capture: whatever
 * actually runs the model reports back here, and that is what makes the
 * "escalate on evidence" panel real rather than decorative.
 */
agentsRouter.post(
  '/runs',
  wrap(async (req, res) => {
    if (!checkIngestToken(bearer(req))) {
      res.status(401).json({ error: 'invalid ingest token' });
      return;
    }
    const parsed = RunInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    res.status(201).json(await recordRun(parsed.data));
  }),
);
