import { z } from 'zod';
import { pool } from '../db/pool.js';

/**
 * The AI gateway's agent registry.
 *
 * An "agent" is a saved job, not code: name, purpose, prompt, model, knobs,
 * and the list of consumer apps allowed to call it. Adding a capability means
 * adding a row here - no deploy.
 *
 * This module owns the registry (config + access + the cost/outcome log).
 * It deliberately does NOT talk to any model provider: the decision on record
 * is to put LiteLLM or OpenRouter underneath rather than hand-build provider
 * plumbing, and that piece is not chosen yet.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentStats {
  calls: number;
  cost_usd: number;
  ok_rate: number;      // percent, 0-100; 100 when there are no calls yet
  hard_fails: number;   // calls the cheapest model genuinely could not handle
}

export interface AgentApp {
  id: string;
  name: string;
}

export interface Agent {
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  prompt: string;
  model: string;
  fallback_model: string | null;
  temperature: number;
  max_tokens: number;
  json_output: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  allowed_apps: AgentApp[];
  stats: AgentStats;
}

/** Who is asking. Admins see every agent; a consumer app sees only its own. */
export type Viewer = { kind: 'admin' } | { kind: 'consumer'; consumerAppId: string };

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 'Field Extractor' -> 'field-extractor' */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const AgentFields = {
  slug: z.string().regex(SLUG, 'slug must be lowercase words separated by hyphens').optional(),
  name: z.string().min(1).max(120),
  purpose: z.string().max(400).optional(),
  prompt: z.string().default(''),
  model: z.string().min(1),
  fallback_model: z.string().min(1).nullable().optional(),
  temperature: z.number().min(0).max(2).default(0.3),
  max_tokens: z.number().int().min(1).max(200000).default(400),
  json_output: z.boolean().default(false),
  enabled: z.boolean().default(false),
  /** Consumer app ids allowed to call this agent. Replaces the whole set. */
  allowed_app_ids: z.array(z.string().uuid()).default([]),
};

export const AgentInput = z.object(AgentFields);
export type AgentInput = z.infer<typeof AgentInput>;

export const AgentPatch = z
  .object({
    slug: AgentFields.slug,
    name: z.string().min(1).max(120).optional(),
    purpose: z.string().max(400).nullable().optional(),
    prompt: z.string().optional(),
    model: z.string().min(1).optional(),
    fallback_model: z.string().min(1).nullable().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(200000).optional(),
    json_output: z.boolean().optional(),
    enabled: z.boolean().optional(),
    allowed_app_ids: z.array(z.string().uuid()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
export type AgentPatch = z.infer<typeof AgentPatch>;

export const AgentQuery = z.object({
  enabled: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  q: z.string().max(120).optional(),                     // matches name or purpose
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type AgentQuery = z.infer<typeof AgentQuery>;

export const RunInput = z.object({
  agent_id: z.string().uuid(),
  consumer_app_id: z.string().uuid().nullable().optional(),
  model: z.string().min(1),
  used_fallback: z.boolean().default(false),
  status: z.enum(['ok', 'error']),
  hard_fail: z.boolean().default(false),
  prompt_tokens: z.number().int().min(0).nullable().optional(),
  completion_tokens: z.number().int().min(0).nullable().optional(),
  cost_usd: z.number().min(0).default(0),
  latency_ms: z.number().int().min(0).nullable().optional(),
  detail: z.string().max(2000).nullable().optional(),
});
export type RunInput = z.infer<typeof RunInput>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * One row per agent, with its granted apps and its 30-day cost/outcome stats
 * already rolled up. Postgres does the aggregation so the UI never has to.
 */
const SELECT_AGENT = `
  select
    a.*,
    coalesce(g.apps, '[]'::json)                          as allowed_apps,
    coalesce(s.calls, 0)::int                             as calls,
    coalesce(s.cost_usd, 0)::float8                       as cost_usd,
    coalesce(s.ok_rate, 100)::float8                      as ok_rate,
    coalesce(s.hard_fails, 0)::int                        as hard_fails
  from ai_agents a
  left join lateral (
    select json_agg(json_build_object('id', ca.id, 'name', ca.name) order by ca.name) as apps
    from ai_agent_grants ag
    join consumer_apps ca on ca.id = ag.consumer_app_id
    where ag.agent_id = a.id
  ) g on true
  left join lateral (
    select
      count(*)                                            as calls,
      sum(r.cost_usd)                                     as cost_usd,
      -- nullif keeps a zero-call agent from dividing by zero; it falls through
      -- to the coalesce above and reports 100% rather than blowing up.
      round(100.0 * count(*) filter (where r.status = 'ok')
            / nullif(count(*), 0), 1)                     as ok_rate,
      count(*) filter (where r.hard_fail)                 as hard_fails
    from ai_agent_runs r
    where r.agent_id = a.id
      and r.occurred_at >= now() - interval '30 days'
  ) s on true
`;

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  purpose: string | null;
  prompt: string;
  model: string;
  fallback_model: string | null;
  temperature: string | number;
  max_tokens: number;
  json_output: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  allowed_apps: AgentApp[];
  calls: number;
  cost_usd: number;
  ok_rate: number;
  hard_fails: number;
}

function toAgent(row: AgentRow): Agent {
  const { calls, cost_usd, ok_rate, hard_fails, temperature, ...rest } = row;
  return {
    ...rest,
    temperature: Number(temperature),
    stats: { calls, cost_usd: Number(cost_usd), ok_rate: Number(ok_rate), hard_fails },
  };
}

/** Admins see everything. A consumer app sees only enabled agents granted to it. */
function viewerFilter(viewer: Viewer, params: unknown[]): string {
  if (viewer.kind === 'admin') return '';
  params.push(viewer.consumerAppId);
  return `and a.enabled = true
          and exists (select 1 from ai_agent_grants ag
                      where ag.agent_id = a.id and ag.consumer_app_id = $${params.length})`;
}

export async function listAgents(query: z.input<typeof AgentQuery>, viewer: Viewer): Promise<Agent[]> {
  const q = AgentQuery.parse(query);
  const params: unknown[] = [];
  const filters: string[] = [];

  if (q.enabled !== undefined) {
    params.push(q.enabled);
    filters.push(`a.enabled = $${params.length}`);
  }
  if (q.q) {
    params.push(`%${q.q}%`);
    filters.push(`(a.name ilike $${params.length} or a.purpose ilike $${params.length})`);
  }

  const where = filters.length ? `where ${filters.join(' and ')}` : 'where true';
  const scoped = viewerFilter(viewer, params);
  params.push(q.limit);

  const { rows } = await pool.query<AgentRow>(
    `${SELECT_AGENT} ${where} ${scoped} order by a.name asc limit $${params.length}`,
    params,
  );
  return rows.map(toAgent);
}

/** Look up by uuid or by slug - both are stable handles callers may hold. */
export async function getAgent(idOrSlug: string, viewer: Viewer): Promise<Agent | null> {
  const params: unknown[] = [idOrSlug];
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const match = isUuid ? `a.id = $1` : `a.slug = $1`;
  const scoped = viewerFilter(viewer, params);

  const { rows } = await pool.query<AgentRow>(`${SELECT_AGENT} where ${match} ${scoped} limit 1`, params);
  return rows[0] ? toAgent(rows[0]) : null;
}

/** The enforcement point the invoke path will use once a provider is chosen. */
export async function canConsumerCallAgent(consumerAppId: string, agentId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from ai_agent_grants ag
      join ai_agents a on a.id = ag.agent_id
     where ag.agent_id = $1 and ag.consumer_app_id = $2 and a.enabled = true`,
    [agentId, consumerAppId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Writes (admin only - enforced at the route)
// ---------------------------------------------------------------------------

async function replaceGrants(agentId: string, appIds: string[]): Promise<void> {
  await pool.query(`delete from ai_agent_grants where agent_id = $1`, [agentId]);
  if (appIds.length === 0) return;
  await pool.query(
    `insert into ai_agent_grants (agent_id, consumer_app_id)
     select $1, unnest($2::uuid[])
     on conflict do nothing`,
    [agentId, appIds],
  );
}

export async function createAgent(input: z.input<typeof AgentInput>): Promise<Agent> {
  const a = AgentInput.parse(input);
  const slug = a.slug ?? slugify(a.name);
  if (!SLUG.test(slug)) throw new BadRequest('could not build a slug from that name - set slug explicitly');

  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_agents
       (slug, name, purpose, prompt, model, fallback_model, temperature, max_tokens, json_output, enabled)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [slug, a.name, a.purpose ?? null, a.prompt, a.model, a.fallback_model ?? null,
      a.temperature, a.max_tokens, a.json_output, a.enabled],
  );

  await replaceGrants(rows[0].id, a.allowed_app_ids);
  const created = await getAgent(rows[0].id, { kind: 'admin' });
  if (!created) throw new Error('agent vanished immediately after insert');
  return created;
}

const COLUMNS: Record<string, string> = {
  slug: 'slug',
  name: 'name',
  purpose: 'purpose',
  prompt: 'prompt',
  model: 'model',
  fallback_model: 'fallback_model',
  temperature: 'temperature',
  max_tokens: 'max_tokens',
  json_output: 'json_output',
  enabled: 'enabled',
};

export async function updateAgent(id: string, patch: z.input<typeof AgentPatch>): Promise<Agent | null> {
  const p = AgentPatch.parse(patch);

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = (p as Record<string, unknown>)[key];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  if (sets.length > 0) {
    params.push(id);
    const { rowCount } = await pool.query(
      `update ai_agents set ${sets.join(', ')} where id = $${params.length}`,
      params,
    );
    if (rowCount === 0) return null;
  } else {
    const { rows } = await pool.query(`select 1 from ai_agents where id = $1`, [id]);
    if (rows.length === 0) return null;
  }

  if (p.allowed_app_ids !== undefined) await replaceGrants(id, p.allowed_app_ids);
  return getAgent(id, { kind: 'admin' });
}

export async function deleteAgent(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`delete from ai_agents where id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Cost / outcome log
// ---------------------------------------------------------------------------

/**
 * Record one call against an agent. This is what makes "escalate on evidence"
 * possible, and it is the per-consumer-app spend attribution.
 */
export async function recordRun(input: z.input<typeof RunInput>): Promise<{ id: string }> {
  const r = RunInput.parse(input);
  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_agent_runs
       (agent_id, consumer_app_id, model, used_fallback, status, hard_fail,
        prompt_tokens, completion_tokens, cost_usd, latency_ms, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [r.agent_id, r.consumer_app_id ?? null, r.model, r.used_fallback, r.status, r.hard_fail,
      r.prompt_tokens ?? null, r.completion_tokens ?? null, r.cost_usd, r.latency_ms ?? null,
      r.detail ?? null],
  );
  return rows[0];
}

/** Spend broken out per consumer app - the report behind per-company chargeback. */
export async function spendByApp(days = 30): Promise<
  Array<{ consumer_app: string | null; calls: number; cost_usd: number }>
> {
  const window = Math.min(Math.max(Math.trunc(days), 1), 365);
  const { rows } = await pool.query<{ consumer_app: string | null; calls: number; cost_usd: number }>(
    `select ca.name as consumer_app,
            count(*)::int as calls,
            coalesce(sum(r.cost_usd), 0)::float8 as cost_usd
       from ai_agent_runs r
       left join consumer_apps ca on ca.id = r.consumer_app_id
      where r.occurred_at >= now() - make_interval(days => $1)
      group by ca.name
      order by cost_usd desc`,
    [window],
  );
  return rows;
}

/** Thrown for caller mistakes the route should turn into a 400. */
export class BadRequest extends Error {}
