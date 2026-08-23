-- Integrator App - migration 013: does the chosen thing actually exist.
--
-- plan_options.status already answers "what did we decide" - candidate,
-- shortlist, chosen, rejected. This migration adds a second, separate axis:
-- does the thing marked chosen actually EXIST and WORK, as observed by a
-- machine, not asserted by a person typing a status.
--
-- WHY OBSERVED, NOT A FIFTH STATUS. This project has been bitten four times in
-- two days (2026-08-23, this file's own changelog) by checks that could not
-- fail: a 401 from a password gate mistaken for a successful auth chain, a
-- seed that silently 413'd while the page reported success, a trigger test
-- that read now() from inside its own transaction, a hash comparison that
-- compared a file to itself. "Built" typed into `status` would be exactly
-- that shape of check again - a claim that reads as proof and can never come
-- back to bite anyone, because nothing ever re-runs it. A probe is a
-- SEPARATE row of columns, run on demand, that produces evidence which can
-- go BACK to failing the moment the real thing breaks. That is the entire
-- point of not folding this into `status`.
--
-- WHY probe_state IS A DIFFERENT COLUMN FROM status, not a replacement for
-- it. `status` records the DECISION - Bill and Josh agreed to use this
-- vendor. `probe_state` records REALITY - as of the last check, the thing is
-- there or it is not. Collapsing them would mean the moment a probe fails,
-- the row would have to either lie (stay "chosen") or forget the decision
-- (revert to "candidate") - and the second one is worse, because "we decided
-- this and it broke" and "we never decided this" are different facts that a
-- team needs to be able to tell apart. Keeping the columns separate means a
-- chosen option can be observed failing without un-choosing it.
--
-- Every kind below defaults to the same honest floor: 'none' / 'unknown' /
-- "no proof defined". Most rows will sit there, forever, and that is
-- correct - a row nobody has wired a check for has NOT been shown to work,
-- and the schema must not be able to say otherwise by accident.
--
-- Idempotent, like every migration here: migrate.ts replays the whole folder
-- on every run and there is no applied-migrations ledger. Nothing below may
-- assume it is running for the first time.

-- ---------------------------------------------------------------------------
-- plan_options: add the probe columns.
-- ---------------------------------------------------------------------------
alter table plan_options add column if not exists probe_kind    text        not null default 'none';
alter table plan_options add column if not exists probe_config  jsonb       not null default '{}'::jsonb;
alter table plan_options add column if not exists probe_state   text        not null default 'unknown';
alter table plan_options add column if not exists probe_detail  text        not null default '';
alter table plan_options add column if not exists probe_at      timestamptz;
alter table plan_options add column if not exists probe_by      text;

-- CHECKs, dropped-then-added so a replay of this file is clean - `add
-- constraint` alone is not idempotent, `drop ... if exists` first is what
-- makes it safe to run twice.
alter table plan_options drop constraint if exists plan_options_probe_kind_chk;
alter table plan_options add constraint plan_options_probe_kind_chk
  check (probe_kind in ('none', 'http_status', 'http_json', 'pg_table', 'manual'));

alter table plan_options drop constraint if exists plan_options_probe_state_chk;
alter table plan_options add constraint plan_options_probe_state_chk
  check (probe_state in ('unknown', 'passing', 'failing', 'error'));

alter table plan_options drop constraint if exists plan_options_probe_config_obj_chk;
alter table plan_options add constraint plan_options_probe_config_obj_chk
  check (jsonb_typeof(probe_config) = 'object');

-- run-all reads "every option whose probe_kind <> 'none'"; the shortlist-style
-- probe board reads across all options by probe_state. Both are real queries.
create index if not exists plan_options_probe_state_idx on plan_options (probe_state);
