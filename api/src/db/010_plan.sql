-- Integrator App - migration 010: the plan tables.
--
-- Numbered 010 on purpose. 005-009 are RESERVED for the connection layer
-- (connections / connection_credentials / connection_state / tenants /
-- tenant_keys), which is designed and not yet applied. Taking 005 here would
-- either collide with that design or force it to renumber, and migrate.ts
-- applies files in filename order, so the gap is the whole point.
--
-- What this is for: the Integrator architecture workbench. Bill and Josh work
-- the Staffility plan in a browser, together, and it has to survive the tab
-- being closed. Until now that state lived in localStorage, which means it was
-- per-browser, invisible to the other person, and gone on a cache clear.
--
-- WHY ROWS AND NOT ONE JSON BLOB. Two reasons, and the second is the real one.
--   1. Two people editing one blob is last-write-wins. Bill edits submission-QA
--      while Josh edits the pay/bill audit and one of them silently loses the
--      work. One row per job means those two edits never touch each other.
--   2. The entire argument being made to Josh is that a job is a ROW. A tool
--      that makes that argument while storing its own plan as an opaque blob is
--      arguing against itself. When a job is agreed, promoting a plan_jobs row
--      into an ai_agents row is a copy, not a translation.
--
-- Idempotent, like every migration here: migrate.ts replays the whole folder on
-- every run and there is no applied-migrations ledger. Nothing below may assume
-- it is running for the first time.

-- ------------------------------------------------------------------------------
-- plan_jobs - one row per candidate job, whatever its status.
-- ------------------------------------------------------------------------------
-- The CHECK vocabularies below are deliberate and are NOT the mistake the house
-- rule warns about. The rule ("an enum means a migration every time a client is
-- in a new country") is about OPEN sets. These are closed by design: three
-- decision-influence levels because that is what California's ADS definition
-- and the CPPA carve-out between them describe, five PII classes because each
-- one triggers a different obligation. `vendor` and `reads` are free text
-- precisely because those ARE open sets.
create table if not exists plan_jobs (
  slug          text primary key,
  name          text        not null,
  one_liner     text        not null default '',
  trigger_kind  text        not null default 'recruiter',
  reads         text        not null default '',
  consumer      text        not null default 'human',
  failure_cost  text        not null default 'low',
  influence     text        not null default 'none',
  human_review  boolean     not null default false,
  pii_class     text        not null default 'none',
  mechanism     text        not null default 'free',
  vendor        text        not null default '',
  notes         text        not null default '',
  status        text        not null default 'candidate',
  origin        text        not null default 'catalogue',
  sort_order    integer     not null default 0,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  constraint plan_jobs_trigger_chk   check (trigger_kind in ('recruiter','webhook','batch','schedule','event')),
  constraint plan_jobs_consumer_chk  check (consumer     in ('human','machine')),
  constraint plan_jobs_failure_chk   check (failure_cost in ('low','medium','high')),
  constraint plan_jobs_influence_chk check (influence    in ('none','facilitates','decides')),
  constraint plan_jobs_pii_chk       check (pii_class    in ('none','contact','resume','third_party','biometric')),
  constraint plan_jobs_mech_chk      check (mechanism    in ('free','json_object','json_schema','forced_tool')),
  constraint plan_jobs_status_chk    check (status       in ('candidate','shortlist','rejected')),
  constraint plan_jobs_origin_chk    check (origin       in ('catalogue','added'))
);

-- The shortlist is the only query this table gets asked in anger.
create index if not exists plan_jobs_status_idx on plan_jobs (status, sort_order);

-- ------------------------------------------------------------------------------
-- plan_answers - one row per open call. Keyed by the decision id the tool uses.
-- ------------------------------------------------------------------------------
create table if not exists plan_answers (
  key        text primary key,
  answer     text        not null default '',
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------------------
-- updated_at, enforced by the database rather than by convention.
-- ------------------------------------------------------------------------------
-- set_updated_at() is created by 003. Migrations run in filename order, so it
-- exists by the time this file runs. A trigger rather than "every writer
-- remembers to set it", because a derived column with no trigger behind it is a
-- convention kept by writers, and the third writer always breaks it.
drop trigger if exists plan_jobs_set_updated_at on plan_jobs;
create trigger plan_jobs_set_updated_at
  before update on plan_jobs
  for each row execute function set_updated_at();

drop trigger if exists plan_answers_set_updated_at on plan_answers;
create trigger plan_answers_set_updated_at
  before update on plan_answers
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------------------
-- RLS, matching 002: on, with no policies.
-- ------------------------------------------------------------------------------
-- Supabase exposes every public table through PostgREST on the anon key.
-- Enabling RLS with zero policies closes that door completely. The API's own
-- pooled connection is the table owner and bypasses RLS, so the app is
-- unaffected. Any new table in this schema gets this treatment or it is
-- readable by anyone holding the publishable key.
alter table plan_jobs    enable row level security;
alter table plan_answers enable row level security;
