import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';

/**
 * Consumer apps and what they're allowed to reach.
 *
 * A consumer app is any LFODIE app that pulls from the Integrator
 * (Bills-Master-Plan, Staffility, IPTA tools, Blue Orbit). It authenticates
 * with an API key and sees only what it has been granted:
 *   - connector access, via `access_grants` (this file), and
 *   - individual agents, via `ai_agent_grants` (services/agents.ts).
 *
 * Keys are shown exactly once, at mint or rotation. Only the hash is stored,
 * so a lost key is rotated, never recovered.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Permission = 'read' | 'sync';

export interface ConnectorGrant {
  connector_id: string;
  connector_key: string;
  kind: 'inbound' | 'outbound';
  permission: Permission;
}

export interface ConsumerApp {
  id: string;
  name: string;
  active: boolean;
  key_id: string | null;
  last_used_at: string | null;
  created_at: string;
  grants: ConnectorGrant[];
  agent_count: number;
}

export interface Connector {
  id: string;
  key: string;
  kind: 'inbound' | 'outbound';
  active: boolean;
}

/** Returned only at mint/rotate. Never stored, never retrievable again. */
export interface MintedKey {
  app: ConsumerApp;
  api_key: string;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const GrantInput = z.object({
  connector_id: z.string().uuid(),
  permission: z.enum(['read', 'sync']),
});

export const ConsumerAppInput = z.object({
  name: z.string().min(1).max(120),
  active: z.boolean().default(true),
  grants: z.array(GrantInput).default([]),
});
export type ConsumerAppInput = z.infer<typeof ConsumerAppInput>;

export const ConsumerAppPatch = z
  .object({
    name: z.string().min(1).max(120).optional(),
    active: z.boolean().optional(),
    grants: z.array(GrantInput).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
export type ConsumerAppPatch = z.infer<typeof ConsumerAppPatch>;

// ---------------------------------------------------------------------------
// Key minting
// ---------------------------------------------------------------------------

/**
 * `int_<12 hex key_id>_<32 hex secret>`. The id half is public and indexed;
 * only the secret half is hashed. See migration 004.
 */
function mintKey(): { keyId: string; secret: string; full: string } {
  const keyId = randomBytes(6).toString('hex');
  const secret = randomBytes(16).toString('hex');
  return { keyId, secret, full: `int_${keyId}_${secret}` };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Never selects api_key_hash. The admin screen shows connections, not secrets -
 * that rule is easier to keep when the secret never leaves the database.
 */
const SELECT_APP = `
  select
    ca.id, ca.name, ca.active, ca.key_id, ca.last_used_at, ca.created_at,
    coalesce(g.grants, '[]'::json)                                     as grants,
    coalesce((select count(*) from ai_agent_grants ag
               where ag.consumer_app_id = ca.id), 0)::int              as agent_count
  from consumer_apps ca
  left join lateral (
    select json_agg(json_build_object(
             'connector_id', c.id,
             'connector_key', c.key,
             'kind', c.kind,
             'permission', ag.permission
           ) order by c.key) as grants
    from access_grants ag
    join connectors c on c.id = ag.connector_id
    where ag.consumer_app_id = ca.id
  ) g on true
`;

export async function listConsumerApps(includeInactive = true): Promise<ConsumerApp[]> {
  const { rows } = await pool.query<ConsumerApp>(
    `${SELECT_APP} ${includeInactive ? '' : 'where ca.active = true'} order by ca.name asc`,
  );
  return rows;
}

export async function getConsumerApp(id: string): Promise<ConsumerApp | null> {
  const { rows } = await pool.query<ConsumerApp>(`${SELECT_APP} where ca.id = $1`, [id]);
  return rows[0] ?? null;
}

/** The connector list, for the access picker. */
export async function listConnectors(): Promise<Connector[]> {
  const { rows } = await pool.query<Connector>(
    `select id, key, kind, active from connectors order by kind, key`,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function replaceGrants(appId: string, grants: z.infer<typeof GrantInput>[]): Promise<void> {
  await pool.query(`delete from access_grants where consumer_app_id = $1`, [appId]);
  for (const g of grants) {
    await pool.query(
      `insert into access_grants (consumer_app_id, connector_id, permission)
       values ($1, $2, $3)
       on conflict (consumer_app_id, connector_id) do update set permission = excluded.permission`,
      [appId, g.connector_id, g.permission],
    );
  }
}

/** Registers an app and mints its first key. The key is returned once. */
export async function createConsumerApp(input: z.input<typeof ConsumerAppInput>): Promise<MintedKey> {
  const a = ConsumerAppInput.parse(input);
  const key = mintKey();
  const hash = await bcrypt.hash(key.secret, 10);

  const { rows } = await pool.query<{ id: string }>(
    `insert into consumer_apps (name, api_key_hash, key_id, active)
     values ($1, $2, $3, $4)
     returning id`,
    [a.name, hash, key.keyId, a.active],
  );

  await replaceGrants(rows[0].id, a.grants);
  const app = await getConsumerApp(rows[0].id);
  if (!app) throw new Error('consumer app vanished immediately after insert');
  return { app, api_key: key.full };
}

export async function updateConsumerApp(
  id: string,
  patch: z.input<typeof ConsumerAppPatch>,
): Promise<ConsumerApp | null> {
  const p = ConsumerAppPatch.parse(patch);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (p.name !== undefined) { params.push(p.name); sets.push(`name = $${params.length}`); }
  if (p.active !== undefined) { params.push(p.active); sets.push(`active = $${params.length}`); }

  if (sets.length > 0) {
    params.push(id);
    const { rowCount } = await pool.query(
      `update consumer_apps set ${sets.join(', ')} where id = $${params.length}`,
      params,
    );
    if (rowCount === 0) return null;
  } else {
    const { rows } = await pool.query(`select 1 from consumer_apps where id = $1`, [id]);
    if (rows.length === 0) return null;
  }

  if (p.grants !== undefined) await replaceGrants(id, p.grants);
  return getConsumerApp(id);
}

/**
 * Issues a new key and invalidates the old one in the same statement. Also the
 * upgrade path off a legacy unkeyed key onto the fast lookup.
 */
export async function rotateConsumerAppKey(id: string): Promise<MintedKey | null> {
  const key = mintKey();
  const hash = await bcrypt.hash(key.secret, 10);

  const { rowCount } = await pool.query(
    `update consumer_apps set api_key_hash = $1, key_id = $2 where id = $3`,
    [hash, key.keyId, id],
  );
  if (rowCount === 0) return null;

  const app = await getConsumerApp(id);
  if (!app) return null;
  return { app, api_key: key.full };
}

/**
 * Deleting an app cascades away its connector grants and its agent grants.
 * Deactivating is usually the better move - it stops the key working while
 * keeping the audit trail - so the route makes the caller be explicit.
 */
export async function deleteConsumerApp(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`delete from consumer_apps where id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
