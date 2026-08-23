import { z } from 'zod';
import { pool } from '../db/pool.js';

/**
 * The plan's options catalogue - the vendors on the table for each option set
 * (financial aggregation, e-signature, background checks, ...), as they are
 * being worked out with Josh.
 *
 * One row per option, keyed `set_key:option_slug`. Deliberately NOT one JSON
 * blob per set: two people editing one blob is last-write-wins, and the whole
 * argument being made to Josh is that a job is a ROW - a tool that stores its
 * own catalogue as an opaque document argues against itself. `cost_model` is
 * read by the pricing math per row, so a price change is an UPDATE, not a
 * deploy.
 *
 * `updated_by` carries the admin's email off the JWT rather than a caller-
 * supplied field, the same rule plan.ts follows, for the same reason.
 */

export const PlanOptionInput = z.object({
  slug: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/,
    'slug must be set_key:option_slug, each half lowercase letters, digits and hyphens'),
  set_key: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  vendor: z.string().max(120).default(''),
  one_liner: z.string().max(2000).default(''),
  pricing: z.string().max(2000).default(''),
  good: z.array(z.string().max(500)).max(50).default([]),
  bad: z.array(z.string().max(500)).max(50).default([]),
  best: z.string().max(2000).default(''),
  fit: z.string().max(2000).default(''),
  residency: z.enum(['pass-through', 'land-in-consumer', 'pooled', 'n/a']).default('n/a'),
  maturity: z.enum(['mature','growing','new','declining','n/a']).default('growing'),
  src: z.string().max(2000).default(''),
  cost_model: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['candidate', 'shortlist', 'chosen', 'rejected']).default('candidate'),
  rationale: z.string().max(4000).default(''),
  origin: z.enum(['catalogue', 'added']).default('added'),
  sort_order: z.number().int().min(0).max(9999).default(0),
});
export type PlanOptionInput = z.infer<typeof PlanOptionInput>;

export interface PlanOption extends PlanOptionInput {
  updated_by: string | null;
  updated_at: string;
  created_at: string;
}

const OPTION_COLS = `slug, set_key, name, vendor, one_liner, pricing, good, bad, best,
  fit, residency, maturity, src, cost_model, status, rationale, origin,
  sort_order, updated_by, updated_at, created_at`;

export async function listPlanOptions(): Promise<PlanOption[]> {
  const { rows } = await pool.query<PlanOption>(
    `select ${OPTION_COLS} from plan_options order by set_key, sort_order, name`,
  );
  return rows;
}

export async function countPlanOptions(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('select count(*) as n from plan_options');
  return Number(rows[0].n);
}

/**
 * Upsert one option. The whole row is written, so the client sends the row it
 * has.
 *
 * `created_at` is untouched on conflict - an option that was added in the
 * first meeting keeps the date it was added, which is the only thing that
 * column is for. `updated_at` is left to the trigger rather than set here:
 * a derived column with no trigger behind it is a convention kept by writers,
 * and a second writer will eventually forget.
 */
export async function upsertPlanOption(
  input: z.input<typeof PlanOptionInput>,
  updatedBy: string,
): Promise<PlanOption> {
  const o = PlanOptionInput.parse(input);
  const { rows } = await pool.query<PlanOption>(
    `insert into plan_options
       (slug, set_key, name, vendor, one_liner, pricing, good, bad, best, fit,
        residency, maturity, src, cost_model, status, rationale, origin,
        sort_order, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     on conflict (slug) do update set
       set_key    = excluded.set_key,
       name       = excluded.name,
       vendor     = excluded.vendor,
       one_liner  = excluded.one_liner,
       pricing    = excluded.pricing,
       good       = excluded.good,
       bad        = excluded.bad,
       best       = excluded.best,
       fit        = excluded.fit,
       residency  = excluded.residency,
       maturity   = excluded.maturity,
       src        = excluded.src,
       cost_model = excluded.cost_model,
       status     = excluded.status,
       rationale  = excluded.rationale,
       sort_order = excluded.sort_order,
       updated_by = excluded.updated_by
     returning ${OPTION_COLS}`,
    [o.slug, o.set_key, o.name, o.vendor, o.one_liner, o.pricing,
      JSON.stringify(o.good), JSON.stringify(o.bad), o.best, o.fit,
      o.residency, o.maturity, o.src, JSON.stringify(o.cost_model),
      o.status, o.rationale, o.origin, o.sort_order, updatedBy],
  );
  return rows[0];
}

/** Returns false when the slug was not there, so the route can answer 404
 *  rather than reporting a delete that deleted nothing. */
export async function deletePlanOption(slug: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from plan_options where slug = $1', [slug]);
  return (rowCount ?? 0) > 0;
}

/**
 * Load many options in ONE transaction. This is how the catalogue gets
 * seeded - a half-seeded catalogue (some vendors in, the rest missing because
 * row 40 of 60 failed a check constraint) is worse than none, because it looks
 * complete in the picker and is silently missing options. Every row is
 * validated before anything is written; the first invalid row rolls the whole
 * batch back rather than leaving a partial write.
 *
 * A client from the pool is taken explicitly rather than using `pool.query`
 * per row, because `pool.query` checks out and returns a (possibly different)
 * connection for every call - there is no `begin`/`commit` spanning that.
 */
export async function bulkUpsertPlanOptions(
  inputs: Array<z.input<typeof PlanOptionInput>>,
  updatedBy: string,
): Promise<number> {
  const parsed = inputs.map((i) => PlanOptionInput.parse(i));
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const o of parsed) {
      await client.query(
        `insert into plan_options
           (slug, set_key, name, vendor, one_liner, pricing, good, bad, best, fit,
            residency, maturity, src, cost_model, status, rationale, origin,
            sort_order, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         on conflict (slug) do update set
           set_key    = excluded.set_key,
           name       = excluded.name,
           vendor     = excluded.vendor,
           one_liner  = excluded.one_liner,
           pricing    = excluded.pricing,
           good       = excluded.good,
           bad        = excluded.bad,
           best       = excluded.best,
           fit        = excluded.fit,
           residency  = excluded.residency,
           maturity   = excluded.maturity,
           src        = excluded.src,
           cost_model = excluded.cost_model,
           status     = excluded.status,
           rationale  = excluded.rationale,
           sort_order = excluded.sort_order,
           updated_by = excluded.updated_by`,
        [o.slug, o.set_key, o.name, o.vendor, o.one_liner, o.pricing,
          JSON.stringify(o.good), JSON.stringify(o.bad), o.best, o.fit,
          o.residency, o.maturity, o.src, JSON.stringify(o.cost_model),
          o.status, o.rationale, o.origin, o.sort_order, updatedBy],
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
