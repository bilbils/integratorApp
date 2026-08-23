import { z } from 'zod';
import { pool } from '../db/pool.js';

/**
 * The plan service - the Staffility job list and the answers to the open calls,
 * as they are being worked out with Josh.
 *
 * One row per job, one row per answer. Deliberately NOT one JSON document:
 * two people editing one blob is last-write-wins, and someone loses work in the
 * middle of a meeting. Per-row writes mean Bill editing submission-QA and Josh
 * editing the pay/bill audit never collide at all, so there is no merge to get
 * wrong and no conflict dialog to design.
 *
 * `updated_by` carries the admin's email off the JWT rather than a caller-
 * supplied field. The tenant comes from the environment, never from the request
 * body - the same rule the ingest paths follow, for the same reason.
 */

/* ── jobs ─────────────────────────────────────────────────────────────── */

export const PlanJobInput = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/,
    'slug must be lowercase letters, digits and hyphens'),
  name: z.string().min(1).max(200),
  one_liner: z.string().max(2000).default(''),
  trigger_kind: z.enum(['recruiter', 'webhook', 'batch', 'schedule', 'event']).default('recruiter'),
  reads: z.string().max(500).default(''),
  consumer: z.enum(['human', 'machine']).default('human'),
  failure_cost: z.enum(['low', 'medium', 'high']).default('low'),
  influence: z.enum(['none', 'facilitates', 'decides']).default('none'),
  human_review: z.boolean().default(false),
  pii_class: z.enum(['none', 'contact', 'resume', 'third_party', 'biometric']).default('none'),
  mechanism: z.enum(['free', 'json_object', 'json_schema', 'forced_tool']).default('free'),
  vendor: z.string().max(120).default(''),
  notes: z.string().max(4000).default(''),
  status: z.enum(['candidate', 'shortlist', 'rejected']).default('candidate'),
  origin: z.enum(['catalogue', 'added']).default('added'),
  sort_order: z.number().int().min(0).max(9999).default(0),
});
export type PlanJobInput = z.infer<typeof PlanJobInput>;

export interface PlanJob extends PlanJobInput {
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

const JOB_COLS = `slug, name, one_liner, trigger_kind, reads, consumer, failure_cost,
  influence, human_review, pii_class, mechanism, vendor, notes, status, origin,
  sort_order, updated_by, updated_at, created_at`;

export async function listPlanJobs(): Promise<PlanJob[]> {
  const { rows } = await pool.query<PlanJob>(
    `select ${JOB_COLS} from plan_jobs order by sort_order, name`,
  );
  return rows;
}

/**
 * Upsert one job. The whole row is written, so the client sends the row it has.
 *
 * `created_at` is untouched on conflict - a job that was added in the first
 * meeting keeps the date it was added, which is the only thing that column is
 * for. `updated_at` is left to the trigger rather than set here: a derived
 * column with no trigger behind it is a convention kept by writers, and a
 * second writer will eventually forget.
 */
export async function upsertPlanJob(
  input: z.input<typeof PlanJobInput>,
  updatedBy: string,
): Promise<PlanJob> {
  const j = PlanJobInput.parse(input);
  const { rows } = await pool.query<PlanJob>(
    `insert into plan_jobs
       (slug, name, one_liner, trigger_kind, reads, consumer, failure_cost,
        influence, human_review, pii_class, mechanism, vendor, notes, status,
        origin, sort_order, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     on conflict (slug) do update set
       name         = excluded.name,
       one_liner    = excluded.one_liner,
       trigger_kind = excluded.trigger_kind,
       reads        = excluded.reads,
       consumer     = excluded.consumer,
       failure_cost = excluded.failure_cost,
       influence    = excluded.influence,
       human_review = excluded.human_review,
       pii_class    = excluded.pii_class,
       mechanism    = excluded.mechanism,
       vendor       = excluded.vendor,
       notes        = excluded.notes,
       status       = excluded.status,
       sort_order   = excluded.sort_order,
       updated_by   = excluded.updated_by
     returning ${JOB_COLS}`,
    [j.slug, j.name, j.one_liner, j.trigger_kind, j.reads, j.consumer, j.failure_cost,
      j.influence, j.human_review, j.pii_class, j.mechanism, j.vendor, j.notes,
      j.status, j.origin, j.sort_order, updatedBy],
  );
  return rows[0];
}

/** Returns false when the slug was not there, so the route can answer 404
 *  rather than reporting a delete that deleted nothing. */
export async function deletePlanJob(slug: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from plan_jobs where slug = $1', [slug]);
  return (rowCount ?? 0) > 0;
}

/* ── answers ──────────────────────────────────────────────────────────── */

export const PlanAnswerInput = z.object({
  answer: z.string().max(20000).default(''),
});

export interface PlanAnswer {
  key: string;
  answer: string;
  updated_by: string | null;
  updated_at: string;
}

export async function listPlanAnswers(): Promise<PlanAnswer[]> {
  const { rows } = await pool.query<PlanAnswer>(
    'select key, answer, updated_by, updated_at from plan_answers order by key',
  );
  return rows;
}

export async function upsertPlanAnswer(
  key: string,
  answer: string,
  updatedBy: string,
): Promise<PlanAnswer> {
  const parsed = PlanAnswerInput.parse({ answer });
  const { rows } = await pool.query<PlanAnswer>(
    `insert into plan_answers (key, answer, updated_by)
     values ($1, $2, $3)
     on conflict (key) do update set
       answer     = excluded.answer,
       updated_by = excluded.updated_by
     returning key, answer, updated_by, updated_at`,
    [key, parsed.answer, updatedBy],
  );
  return rows[0];
}

/* ── the probe ────────────────────────────────────────────────────────── */

export interface PlanProbe {
  ai_agents: number;
  ai_agents_enabled: number;
  ai_agent_runs: number;
  ai_agent_grants: number;
  consumer_apps: number;
  apps_on_legacy_key: number;
  connectors: number;
  access_grants: number;
  session_highlights: number;
  sync_logs: number;
  public_tables: number;
  tables_without_rls: number;
  migration_005_tables: number;
  plan_jobs: number;
  plan_shortlisted: number;
  read_at: string;
}

/**
 * The same counts `npm run probe` prints, served to the browser so the tool
 * never quotes a number from prose.
 *
 * What it deliberately CANNOT see, and the UI says so: the working tree, the
 * three build stamps, and whether the deployed commit is the one in the clone.
 * A stamp that was never bumped makes the /health comparison agree vacuously -
 * identical whether the deploy landed or not - so this endpoint does not
 * pretend to answer that question at all.
 */
export async function planProbe(): Promise<PlanProbe> {
  const { rows } = await pool.query<PlanProbe>(`
    select
      (select count(*) from ai_agents)::int                                       as ai_agents,
      (select count(*) from ai_agents where enabled)::int                         as ai_agents_enabled,
      (select count(*) from ai_agent_runs)::int                                   as ai_agent_runs,
      (select count(*) from ai_agent_grants)::int                                 as ai_agent_grants,
      (select count(*) from consumer_apps)::int                                   as consumer_apps,
      (select count(*) from consumer_apps where key_id is null)::int              as apps_on_legacy_key,
      (select count(*) from connectors)::int                                      as connectors,
      (select count(*) from access_grants)::int                                   as access_grants,
      (select count(*) from session_highlights)::int                              as session_highlights,
      (select count(*) from sync_logs)::int                                       as sync_logs,
      (select count(*) from pg_tables where schemaname = 'public')::int           as public_tables,
      (select count(*) from pg_tables
         where schemaname = 'public' and not rowsecurity)::int                    as tables_without_rls,
      (select count(*) from information_schema.tables
         where table_schema = 'public'
           and table_name in ('connections','tenants','connection_credentials',
                              'connection_state','tenant_keys'))::int             as migration_005_tables,
      (select count(*) from plan_jobs)::int                                       as plan_jobs,
      (select count(*) from plan_jobs where status = 'shortlist')::int            as plan_shortlisted,
      now()::text                                                                 as read_at
  `);
  return rows[0];
}
