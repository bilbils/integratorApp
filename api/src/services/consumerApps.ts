import { pool } from '../db/pool.js';

export interface ConsumerAppSummary {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
}

/**
 * Registered consumer apps, for pickers like "which apps can call this agent".
 * Never returns api_key_hash - the admin UI shows connections, not secrets.
 */
export async function listConsumerApps(includeInactive = false): Promise<ConsumerAppSummary[]> {
  const { rows } = await pool.query<ConsumerAppSummary>(
    `select id, name, active, created_at
       from consumer_apps
      ${includeInactive ? '' : 'where active = true'}
      order by name asc`,
  );
  return rows;
}
