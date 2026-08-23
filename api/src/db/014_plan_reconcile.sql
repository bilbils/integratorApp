-- Integrator App - migration 014: reconciling the plan against Josh's ADRs.
--
-- The workbench holds 16 architecture decisions with 140 researched vendor
-- options (011). The chief engineer's own repo (dev.azure.com/ipt/Staffility)
-- holds 12 Architecture Decision Records that already settle several of those
-- same questions. Presenting a settled question as open is worse than not
-- asking it. So the workbench now records, per decision, how it reconciles
-- against those ADRs - and does it as rows, because the reconciliation is a
-- live judgement two people will argue with and revise, not a fact baked into
-- a page. Same rule as 010 and 011: two people editing one blob is
-- last-write-wins, and a tool that argues a job is a row cannot store its own
-- reconciliation as a document.
--
-- Idempotent, like every migration here: migrate.ts replays the whole folder
-- on every run and there is no applied-migrations ledger. Nothing below may
-- assume it is running for the first time.

-- ---------------------------------------------------------------------------
-- plan_adrs - the index of the other team's decision records.
-- ---------------------------------------------------------------------------
-- `number` is THEIR permanent numbering, kept as the primary key on purpose:
-- an ADR is referred to by number in conversation ("ADR-7 covers this"), and
-- giving it a surrogate id here would mean every reference elsewhere in this
-- schema has to carry a second, meaningless key.
--
-- `read_in_full` is not decoration. It records whether a human or agent
-- actually read the document or only its title, so a reconciliation built
-- partly from titles cannot silently present itself as complete. A verdict of
-- `settled` resting on a title alone is exactly the "check that could not
-- fail" shape 013's header warns about - it reads as proof and nothing ever
-- re-runs it. This column is how that gap stays visible instead of getting
-- rounded up to "reviewed" the moment someone glances at a filename.
create table if not exists plan_adrs (
  number       integer     primary key,
  slug         text        not null,
  title        text        not null,
  adr_status   text        not null default 'accepted',
  decided_on   date,
  deciders     text        not null default '',
  summary      text        not null default '',   -- one paragraph, our words
  url          text        not null default '',
  read_in_full boolean     not null default false,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint plan_adrs_status_chk check (adr_status in ('accepted','proposed','superseded','withdrawn')),
  constraint plan_adrs_slug_uniq  unique (slug)
);

-- ---------------------------------------------------------------------------
-- plan_reconcile - one row per decision set: how it reconciles against the
-- ADRs above.
-- ---------------------------------------------------------------------------
-- `set_key` matches the option-set keys plan_options already uses, so one
-- lookup joins a decision to both its vendor options and its reconciliation -
-- no second slug scheme to keep in step with the first.
--
-- `verdict` vocabulary, and why each one exists:
--   settled       - an accepted ADR decides it; adopt, do not re-litigate.
--   open          - no ADR, or an ADR that is still Proposed; this is where
--                   the option research in 011 earns its keep.
--   additive      - they explicitly deferred it and we are building it.
--   difference    - both systems decided, differently, on purpose; recorded
--                   so it is not mistaken for drift.
--   out-of-scope  - outside their product's focus test; ours alone.
--   unreviewed    - nobody has judged it yet. This is the default, and it
--                   must never read as agreement - a set sitting at
--                   `unreviewed` is a set nobody has looked at, not a set
--                   that was checked and found fine. Same shape as 013's
--                   'unknown' probe_state floor, for the same reason.
create table if not exists plan_reconcile (
  set_key    text        primary key,
  verdict    text        not null default 'unreviewed',
  adr_refs   integer[]   not null default '{}',   -- ADR numbers that bear on it
  note       text        not null default '',     -- why this verdict, one or two sentences
  action     text        not null default '',     -- what we do about it
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint plan_reconcile_verdict_chk
    check (verdict in ('settled','open','additive','difference','out-of-scope','unreviewed'))
);

-- ---------------------------------------------------------------------------
-- plan_issues - the things two people need to talk about.
-- ---------------------------------------------------------------------------
-- Separate from plan_reconcile on purpose: a reconciliation verdict is a
-- judgement about a decision SET, an issue is a specific open question that
-- may cut across sets, may not map to a set at all, and carries its own
-- lifecycle (open -> decided or parked) independent of any verdict changing.
create table if not exists plan_issues (
  slug         text        primary key,
  title        text        not null,
  question     text        not null default '',   -- the actual question, one line
  why          text        not null default '',   -- why it matters
  if_undecided text        not null default '',   -- what happens if it is not decided
  owner        text        not null default '',   -- who decides
  issue_status text        not null default 'open',
  rank         integer     not null default 100,
  adr_refs     integer[]   not null default '{}',
  note         text        not null default '',   -- notes taken in the room
  updated_by   text,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint plan_issues_status_chk check (issue_status in ('open','decided','parked'))
);

-- The issues board reads "open issues, in rank order" - a real query, so it
-- gets an index, same rule as 011 and 013.
create index if not exists plan_issues_status_rank_idx on plan_issues (issue_status, rank);

-- ---------------------------------------------------------------------------
-- updated_at, enforced by the database rather than by convention.
-- ---------------------------------------------------------------------------
-- set_updated_at() is created by 003. Migrations run in filename order, so it
-- exists by the time this file runs - it is not redefined here.
drop trigger if exists plan_adrs_set_updated_at on plan_adrs;
create trigger plan_adrs_set_updated_at
  before update on plan_adrs
  for each row execute function set_updated_at();

drop trigger if exists plan_reconcile_set_updated_at on plan_reconcile;
create trigger plan_reconcile_set_updated_at
  before update on plan_reconcile
  for each row execute function set_updated_at();

drop trigger if exists plan_issues_set_updated_at on plan_issues;
create trigger plan_issues_set_updated_at
  before update on plan_issues
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS, matching 002/010/011: on, with no policies.
-- ---------------------------------------------------------------------------
-- Supabase exposes every public table through PostgREST on the anon key.
-- Enabling RLS with zero policies closes that door completely. The API's own
-- pooled connection is the table owner and bypasses RLS, so the app is
-- unaffected. Any new table in this schema gets this treatment or it is
-- readable by anyone holding the publishable key.
alter table plan_adrs      enable row level security;
alter table plan_reconcile enable row level security;
alter table plan_issues    enable row level security;
