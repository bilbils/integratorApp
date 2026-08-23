import { z } from 'zod';
import { pool } from '../db/pool.js';

/**
 * Reconciling the plan against Josh's ADRs.
 *
 * plan_adrs indexes the other team's decision records. plan_reconcile is one
 * row per decision SET (matching plan_options.set_key) recording how it
 * reconciles against those ADRs - settled, open, additive, a deliberate
 * difference, out of our scope, or nobody has looked yet. plan_issues is the
 * separate list of things two people still need to talk about.
 *
 * Rows, not one document, for the same reason as 010 and 011: two people
 * arguing over the same reconciliation in the same meeting must never
 * silently overwrite each other, and a tool that argues a job is a row cannot
 * store its own reconciliation as a blob.
 *
 * `updated_by` carries the admin's email off the JWT rather than a caller-
 * supplied field, the same rule planOptions.ts follows, for the same reason.
 */

const adrRefs = z.array(z.number().int().positive()).max(50).default([]);
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/* ── adrs ─────────────────────────────────────────────────────────────── */

export const PlanAdrInput = z.object({
  number: z.number().int().positive(),
  slug: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9-]*$/,
    'slug must be lowercase letters, digits and hyphens'),
  title: z.string().min(1).max(300),
  adr_status: z.enum(['accepted', 'proposed', 'superseded', 'withdrawn']).default('accepted'),
  decided_on: z.union([z.string().regex(isoDate, 'decided_on must be YYYY-MM-DD'), z.null()]).default(null),
  deciders: z.string().max(500).default(''),
  summary: z.string().max(4000).default(''),
  url: z.string().max(2000).default(''),
  read_in_full: z.boolean().default(false),
});
export type PlanAdrInput = z.infer<typeof PlanAdrInput>;

export interface PlanAdr extends PlanAdrInput {
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

const ADR_COLS = `number, slug, title, adr_status, decided_on, deciders, summary, url,
  read_in_full, updated_by, updated_at, created_at`;

export async function listAdrs(): Promise<PlanAdr[]> {
  const { rows } = await pool.query<PlanAdr>(
    `select ${ADR_COLS} from plan_adrs order by number`,
  );
  return rows;
}

export async function countAdrs(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('select count(*) as n from plan_adrs');
  return Number(rows[0].n);
}

/**
 * Upsert one ADR. The whole row is written, so the client sends the row it
 * has. `created_at` is untouched on conflict; `updated_at` is left to the
 * trigger, same rule as every other upsert in this schema.
 */
export async function upsertAdr(
  input: z.input<typeof PlanAdrInput>,
  updatedBy: string,
): Promise<PlanAdr> {
  const a = PlanAdrInput.parse(input);
  const { rows } = await pool.query<PlanAdr>(
    `insert into plan_adrs
       (number, slug, title, adr_status, decided_on, deciders, summary, url,
        read_in_full, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (number) do update set
       slug         = excluded.slug,
       title        = excluded.title,
       adr_status   = excluded.adr_status,
       decided_on   = excluded.decided_on,
       deciders     = excluded.deciders,
       summary      = excluded.summary,
       url          = excluded.url,
       read_in_full = excluded.read_in_full,
       updated_by   = excluded.updated_by
     returning ${ADR_COLS}`,
    [a.number, a.slug, a.title, a.adr_status, a.decided_on, a.deciders, a.summary, a.url,
      a.read_in_full, updatedBy],
  );
  return rows[0];
}

/** Returns false when the number was not there, so the route can answer 404
 *  rather than reporting a delete that deleted nothing. */
export async function deleteAdr(number: number): Promise<boolean> {
  const { rowCount } = await pool.query('delete from plan_adrs where number = $1', [number]);
  return (rowCount ?? 0) > 0;
}

/**
 * Load many ADRs in ONE transaction. Every row is validated before anything
 * is written; the first invalid row rolls the whole batch back rather than
 * leaving a partial index of decision records, same rule as
 * bulkUpsertPlanOptions and for the same reason - a half-loaded index looks
 * complete and is silently missing entries.
 */
export async function bulkUpsertAdrs(
  inputs: Array<z.input<typeof PlanAdrInput>>,
  updatedBy: string,
): Promise<number> {
  const parsed = inputs.map((i) => PlanAdrInput.parse(i));
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const a of parsed) {
      await client.query(
        `insert into plan_adrs
           (number, slug, title, adr_status, decided_on, deciders, summary, url,
            read_in_full, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (number) do update set
           slug         = excluded.slug,
           title        = excluded.title,
           adr_status   = excluded.adr_status,
           decided_on   = excluded.decided_on,
           deciders     = excluded.deciders,
           summary      = excluded.summary,
           url          = excluded.url,
           read_in_full = excluded.read_in_full,
           updated_by   = excluded.updated_by`,
        [a.number, a.slug, a.title, a.adr_status, a.decided_on, a.deciders, a.summary, a.url,
          a.read_in_full, updatedBy],
      );
    }
    await client.query('commit');
    return parsed.length;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/* ── reconcile ────────────────────────────────────────────────────────── */

export const PlanReconcileInput = z.object({
  set_key: z.string().min(1).max(80),
  verdict: z.enum(['settled', 'open', 'additive', 'difference', 'out-of-scope', 'unreviewed'])
    .default('unreviewed'),
  adr_refs: adrRefs,
  note: z.string().max(2000).default(''),
  action: z.string().max(2000).default(''),
});
export type PlanReconcileInput = z.infer<typeof PlanReconcileInput>;

export interface PlanReconcile extends PlanReconcileInput {
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

const RECONCILE_COLS = `set_key, verdict, adr_refs, note, action, updated_by, updated_at, created_at`;

export async function listReconcile(): Promise<PlanReconcile[]> {
  const { rows } = await pool.query<PlanReconcile>(
    `select ${RECONCILE_COLS} from plan_reconcile order by set_key`,
  );
  return rows;
}

export async function countReconcile(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('select count(*) as n from plan_reconcile');
  return Number(rows[0].n);
}

/**
 * Upsert one decision set's reconciliation. Same shape as upsertAdr: whole
 * row written, `created_at` untouched on conflict, `updated_at` left to the
 * trigger. There is no `deleteReconcile` - a decision set's reconciliation
 * defaulting to 'unreviewed' is the correct empty state, not a row that
 * should ever be absent once the set exists.
 */
export async function upsertReconcile(
  input: z.input<typeof PlanReconcileInput>,
  updatedBy: string,
): Promise<PlanReconcile> {
  const r = PlanReconcileInput.parse(input);
  const { rows } = await pool.query<PlanReconcile>(
    `insert into plan_reconcile (set_key, verdict, adr_refs, note, action, updated_by)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (set_key) do update set
       verdict    = excluded.verdict,
       adr_refs   = excluded.adr_refs,
       note       = excluded.note,
       action     = excluded.action,
       updated_by = excluded.updated_by
     returning ${RECONCILE_COLS}`,
    [r.set_key, r.verdict, r.adr_refs, r.note, r.action, updatedBy],
  );
  return rows[0];
}

/** Load many reconciliations in ONE transaction, same rule as bulkUpsertAdrs. */
export async function bulkUpsertReconcile(
  inputs: Array<z.input<typeof PlanReconcileInput>>,
  updatedBy: string,
): Promise<number> {
  const parsed = inputs.map((i) => PlanReconcileInput.parse(i));
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const r of parsed) {
      await client.query(
        `insert into plan_reconcile (set_key, verdict, adr_refs, note, action, updated_by)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (set_key) do update set
           verdict    = excluded.verdict,
           adr_refs   = excluded.adr_refs,
           note       = excluded.note,
           action     = excluded.action,
           updated_by = excluded.updated_by`,
        [r.set_key, r.verdict, r.adr_refs, r.note, r.action, updatedBy],
      );
    }
    await client.query('commit');
    return parsed.length;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/* ── issues ───────────────────────────────────────────────────────────── */

export const PlanIssueInput = z.object({
  slug: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9-]*$/,
    'slug must be lowercase letters, digits and hyphens'),
  title: z.string().min(1).max(300),
  question: z.string().max(2000).default(''),
  why: z.string().max(2000).default(''),
  if_undecided: z.string().max(2000).default(''),
  owner: z.string().max(200).default(''),
  issue_status: z.enum(['open', 'decided', 'parked']).default('open'),
  rank: z.number().int().min(0).max(9999).default(100),
  adr_refs: adrRefs,
  note: z.string().max(4000).default(''),
});
export type PlanIssueInput = z.infer<typeof PlanIssueInput>;

export interface PlanIssue extends PlanIssueInput {
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

const ISSUE_COLS = `slug, title, question, why, if_undecided, owner, issue_status, rank,
  adr_refs, note, updated_by, updated_at, created_at`;

export async function listIssues(): Promise<PlanIssue[]> {
  const { rows } = await pool.query<PlanIssue>(
    `select ${ISSUE_COLS} from plan_issues order by issue_status, rank, title`,
  );
  return rows;
}

export async function countIssues(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('select count(*) as n from plan_issues');
  return Number(rows[0].n);
}

/** Upsert one issue. Same shape as upsertAdr. */
export async function upsertIssue(
  input: z.input<typeof PlanIssueInput>,
  updatedBy: string,
): Promise<PlanIssue> {
  const i = PlanIssueInput.parse(input);
  const { rows } = await pool.query<PlanIssue>(
    `insert into plan_issues
       (slug, title, question, why, if_undecided, owner, issue_status, rank,
        adr_refs, note, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (slug) do update set
       title        = excluded.title,
       question     = excluded.question,
       why          = excluded.why,
       if_undecided = excluded.if_undecided,
       owner        = excluded.owner,
       issue_status = excluded.issue_status,
       rank         = excluded.rank,
       adr_refs     = excluded.adr_refs,
       note         = excluded.note,
       updated_by   = excluded.updated_by
     returning ${ISSUE_COLS}`,
    [i.slug, i.title, i.question, i.why, i.if_undecided, i.owner, i.issue_status, i.rank,
      i.adr_refs, i.note, updatedBy],
  );
  return rows[0];
}

/** Returns false when the slug was not there, so the route can answer 404
 *  rather than reporting a delete that deleted nothing. */
export async function deleteIssue(slug: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from plan_issues where slug = $1', [slug]);
  return (rowCount ?? 0) > 0;
}

/** Load many issues in ONE transaction, same rule as bulkUpsertAdrs. */
export async function bulkUpsertIssues(
  inputs: Array<z.input<typeof PlanIssueInput>>,
  updatedBy: string,
): Promise<number> {
  const parsed = inputs.map((i) => PlanIssueInput.parse(i));
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const i of parsed) {
      await client.query(
        `insert into plan_issues
           (slug, title, question, why, if_undecided, owner, issue_status, rank,
            adr_refs, note, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (slug) do update set
           title        = excluded.title,
           question     = excluded.question,
           why          = excluded.why,
           if_undecided = excluded.if_undecided,
           owner        = excluded.owner,
           issue_status = excluded.issue_status,
           rank         = excluded.rank,
           adr_refs     = excluded.adr_refs,
           note         = excluded.note,
           updated_by   = excluded.updated_by`,
        [i.slug, i.title, i.question, i.why, i.if_undecided, i.owner, i.issue_status, i.rank,
          i.adr_refs, i.note, updatedBy],
      );
    }
    await client.query('commit');
    return parsed.length;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/* ── seed ─────────────────────────────────────────────────────────────── */

export interface SeedCounts {
  adrs: number;
  reconcile: number;
  issues: number;
}

/**
 * Load ADRs, reconciliations and issues together in ONE transaction. This is
 * the one place all three tables are written as a single unit rather than
 * through their own bulkUpsert* functions - the route's 409-if-not-empty
 * guard only means anything if the write it guards cannot land half-done.
 * Every row across all three inputs is validated by the caller before this
 * runs; the first failure inside the transaction still rolls everything back.
 */
export async function seedAll(
  input: {
    adrs?: Array<z.input<typeof PlanAdrInput>>;
    reconcile?: Array<z.input<typeof PlanReconcileInput>>;
    issues?: Array<z.input<typeof PlanIssueInput>>;
  },
  updatedBy: string,
): Promise<SeedCounts> {
  const adrs = (input.adrs ?? []).map((i) => PlanAdrInput.parse(i));
  const reconcile = (input.reconcile ?? []).map((i) => PlanReconcileInput.parse(i));
  const issues = (input.issues ?? []).map((i) => PlanIssueInput.parse(i));

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const a of adrs) {
      await client.query(
        `insert into plan_adrs
           (number, slug, title, adr_status, decided_on, deciders, summary, url,
            read_in_full, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (number) do update set
           slug         = excluded.slug,
           title        = excluded.title,
           adr_status   = excluded.adr_status,
           decided_on   = excluded.decided_on,
           deciders     = excluded.deciders,
           summary      = excluded.summary,
           url          = excluded.url,
           read_in_full = excluded.read_in_full,
           updated_by   = excluded.updated_by`,
        [a.number, a.slug, a.title, a.adr_status, a.decided_on, a.deciders, a.summary, a.url,
          a.read_in_full, updatedBy],
      );
    }
    for (const r of reconcile) {
      await client.query(
        `insert into plan_reconcile (set_key, verdict, adr_refs, note, action, updated_by)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (set_key) do update set
           verdict    = excluded.verdict,
           adr_refs   = excluded.adr_refs,
           note       = excluded.note,
           action     = excluded.action,
           updated_by = excluded.updated_by`,
        [r.set_key, r.verdict, r.adr_refs, r.note, r.action, updatedBy],
      );
    }
    for (const i of issues) {
      await client.query(
        `insert into plan_issues
           (slug, title, question, why, if_undecided, owner, issue_status, rank,
            adr_refs, note, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (slug) do update set
           title        = excluded.title,
           question     = excluded.question,
           why          = excluded.why,
           if_undecided = excluded.if_undecided,
           owner        = excluded.owner,
           issue_status = excluded.issue_status,
           rank         = excluded.rank,
           adr_refs     = excluded.adr_refs,
           note         = excluded.note,
           updated_by   = excluded.updated_by`,
        [i.slug, i.title, i.question, i.why, i.if_undecided, i.owner, i.issue_status, i.rank,
          i.adr_refs, i.note, updatedBy],
      );
    }
    await client.query('commit');
    return { adrs: adrs.length, reconcile: reconcile.length, issues: issues.length };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/* ── summary ──────────────────────────────────────────────────────────── */

export interface ReconcileSummary {
  verdicts: {
    settled: number;
    open: number;
    additive: number;
    difference: number;
    'out-of-scope': number;
    unreviewed: number;
  };
  issue_statuses: {
    open: number;
    decided: number;
    parked: number;
  };
}

/**
 * Counts per verdict and per issue_status, so the workbench can show "9
 * unreviewed, 3 open issues" without pulling every row to count client-side.
 */
export async function reconcileSummary(): Promise<ReconcileSummary> {
  const { rows: v } = await pool.query<{
    settled: string; open: string; additive: string; difference: string;
    out_of_scope: string; unreviewed: string;
  }>(`
    select
      count(*) filter (where verdict = 'settled')      as settled,
      count(*) filter (where verdict = 'open')         as open,
      count(*) filter (where verdict = 'additive')     as additive,
      count(*) filter (where verdict = 'difference')   as difference,
      count(*) filter (where verdict = 'out-of-scope') as out_of_scope,
      count(*) filter (where verdict = 'unreviewed')   as unreviewed
    from plan_reconcile
  `);
  const { rows: s } = await pool.query<{ open: string; decided: string; parked: string }>(`
    select
      count(*) filter (where issue_status = 'open')    as open,
      count(*) filter (where issue_status = 'decided') as decided,
      count(*) filter (where issue_status = 'parked')  as parked
    from plan_issues
  `);
  return {
    verdicts: {
      settled: Number(v[0].settled),
      open: Number(v[0].open),
      additive: Number(v[0].additive),
      difference: Number(v[0].difference),
      'out-of-scope': Number(v[0].out_of_scope),
      unreviewed: Number(v[0].unreviewed),
    },
    issue_statuses: {
      open: Number(s[0].open),
      decided: Number(s[0].decided),
      parked: Number(s[0].parked),
    },
  };
}
