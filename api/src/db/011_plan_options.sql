-- Integrator App - migration 011: the plan's OPTIONS catalogue.
--
-- plan_jobs (010) is one row per candidate JOB. This is the sibling table for
-- the other axis of the same conversation: for a job that needs a connector -
-- financial aggregation, e-signature, background checks, whatever the set is -
-- which vendors are actually on the table, and what is known about each one.
-- `slug` is `set_key:option_slug` (e.g. 'financial-aggregation:plaid') so one
-- catalogue table serves every option set without a second foreign key table
-- to keep in sync.
--
-- WHY ROWS AND NOT ONE JSON BLOB, per set. Same two reasons as 010, plus a
-- third that is specific to this table.
--   1. Two people editing one blob is last-write-wins. Bill editing the
--      background-check vendors while Josh edits the e-signature ones must
--      never collide, for the same reason plan_jobs is rows and not a blob.
--   2. The tool's whole pitch to Josh is that a job is a ROW. A catalogue of
--      the options that feed those jobs cannot be the one place that argues
--      against its own pitch by being a document.
--   3. NEW HERE: `cost_model` is read by the pricing math per row, at read
--      time. A vendor's price changing is an UPDATE to one row's `cost_model`,
--      not a deploy that touches a constant baked into a TypeScript file. The
--      whole reason to give cost_model its own jsonb column instead of folding
--      it into `pricing` (free text, for the human-readable blurb) is so the
--      computed side of the tool never needs a code change to reprice.
--
-- Idempotent, like every migration here: migrate.ts replays the whole folder
-- on every run and there is no applied-migrations ledger. Nothing below may
-- assume it is running for the first time.

-- ---------------------------------------------------------------------------
-- plan_options - one row per vendor/option, scoped to a set_key.
-- ---------------------------------------------------------------------------
-- `good` and `bad` are jsonb ARRAYS of short strings (bullet points), not text,
-- so the UI can render a list without splitting on newlines. `cost_model` is a
-- jsonb OBJECT - shape is deliberately not fixed by a column-per-field here,
-- because pricing shapes differ by vendor (per-seat vs. per-call vs. tiered)
-- and a schema migration every time a vendor's pricing model changes is
-- exactly the "everything variable is a row" rule this table exists to serve.
-- The jsonb_typeof checks exist because a jsonb column with no type check
-- silently accepts a string where an array or object was meant, and that bug
-- surfaces two layers away, in whatever reads `good[0]` or `cost_model.unit`.
create table if not exists plan_options (
  slug        text primary key,                  -- 'set_key:option_slug'
  set_key     text        not null,
  name        text        not null,
  vendor      text        not null default '',
  one_liner   text        not null default '',
  pricing     text        not null default '',    -- free-text blurb for humans
  good        jsonb       not null default '[]'::jsonb,
  bad         jsonb       not null default '[]'::jsonb,
  best        text        not null default '',
  fit         text        not null default '',
  residency   text        not null default 'n/a',
  maturity    text        not null default 'growing',
  src         text        not null default '',
  cost_model  jsonb       not null default '{}'::jsonb,   -- machine-readable pricing, read by the pricing math
  status      text        not null default 'candidate',
  rationale   text        not null default '',
  origin      text        not null default 'catalogue',
  sort_order  integer     not null default 0,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint plan_options_status_chk    check (status    in ('candidate','shortlist','chosen','rejected')),
  constraint plan_options_residency_chk check (residency in ('pass-through','land-in-consumer','pooled','n/a')),
  constraint plan_options_maturity_chk  check (maturity  in ('mature','growing','new','declining','n/a')),
  constraint plan_options_origin_chk    check (origin    in ('catalogue','added')),
  constraint plan_options_good_arr_chk       check (jsonb_typeof(good) = 'array'),
  constraint plan_options_bad_arr_chk        check (jsonb_typeof(bad) = 'array'),
  constraint plan_options_cost_model_obj_chk check (jsonb_typeof(cost_model) = 'object')
);

-- The picker lists options within one set, in order; the shortlist board reads
-- across sets by status. Both are real queries, so both get an index.
create index if not exists plan_options_set_sort_idx on plan_options (set_key, sort_order);
create index if not exists plan_options_status_idx    on plan_options (status);

-- ---------------------------------------------------------------------------
-- updated_at, enforced by the database rather than by convention.
-- ---------------------------------------------------------------------------
-- set_updated_at() is created by 003. Migrations run in filename order, so it
-- exists by the time this file runs - it is not redefined here.
drop trigger if exists plan_options_set_updated_at on plan_options;
create trigger plan_options_set_updated_at
  before update on plan_options
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS, matching 002 and 010: on, with no policies.
-- ---------------------------------------------------------------------------
-- Supabase exposes every public table through PostgREST on the anon key.
-- Enabling RLS with zero policies closes that door completely. The API's own
-- pooled connection is the table owner and bypasses RLS, so the app is
-- unaffected. Any new table in this schema gets this treatment or it is
-- readable by anyone holding the publishable key.
alter table plan_options enable row level security;
