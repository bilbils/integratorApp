import { Router } from 'express';
import { listConsumerApps } from '../../services/consumerApps.js';
import { requireAdmin } from '../middleware.js';
import { wrap } from '../async.js';

export const consumerAppsRouter = Router();

// Admin only. Powers the "which apps can call this agent" picker.
consumerAppsRouter.get(
  '/',
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await listConsumerApps(req.query.include_inactive === 'true'));
  }),
);
