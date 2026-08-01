import { Router } from 'express';
import {
  listConsumerApps,
  getConsumerApp,
  createConsumerApp,
  updateConsumerApp,
  rotateConsumerAppKey,
  deleteConsumerApp,
  listConnectors,
  ConsumerAppInput,
  ConsumerAppPatch,
} from '../../services/consumerApps.js';
import { requireAdmin } from '../middleware.js';
import { wrap } from '../async.js';

export const consumerAppsRouter = Router();

/**
 * Admin only, all of it. These routes hand out credentials and decide who can
 * reach what - there is no read-only audience for them.
 */

/** Postgres unique-violation: the name is the only unique thing a caller sets. */
function isDuplicateName(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// The connector list that powers the access picker.
consumerAppsRouter.get(
  '/connectors',
  requireAdmin,
  wrap(async (_req, res) => {
    res.json(await listConnectors());
  }),
);

consumerAppsRouter.get(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await listConsumerApps(req.query.include_inactive !== 'false'));
  }),
);

consumerAppsRouter.get(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const app = await getConsumerApp(req.params.id);
    if (!app) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(app);
  }),
);

// Create. The response carries the API key - the only time it ever exists
// outside the caller's hands.
consumerAppsRouter.post(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = ConsumerAppInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      res.status(201).json(await createConsumerApp(parsed.data));
    } catch (err) {
      if (isDuplicateName(err)) {
        res.status(409).json({ error: 'an app with that name already exists' });
        return;
      }
      throw err;
    }
  }),
);

consumerAppsRouter.patch(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    const parsed = ConsumerAppPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    try {
      const app = await updateConsumerApp(req.params.id, parsed.data);
      if (!app) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(app);
    } catch (err) {
      if (isDuplicateName(err)) {
        res.status(409).json({ error: 'an app with that name already exists' });
        return;
      }
      throw err;
    }
  }),
);

// Rotate. Invalidates the old key immediately and returns the new one once.
consumerAppsRouter.post(
  '/:id/rotate-key',
  requireAdmin,
  wrap(async (req, res) => {
    const minted = await rotateConsumerAppKey(req.params.id);
    if (!minted) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(minted);
  }),
);

/**
 * Delete takes ?confirm=true. Removing an app also removes every connector and
 * agent grant attached to it, and deactivating is usually what's actually
 * wanted - so this makes the destructive read of the request explicit.
 */
consumerAppsRouter.delete(
  '/:id',
  requireAdmin,
  wrap(async (req, res) => {
    if (req.query.confirm !== 'true') {
      res.status(400).json({
        error: 'deleting an app also drops its connector and agent grants; ' +
          'pass ?confirm=true, or set active=false to just stop the key working',
      });
      return;
    }
    const removed = await deleteConsumerApp(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  }),
);
