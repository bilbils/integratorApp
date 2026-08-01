-- Integrator App - migration 002: enable row level security.
--
-- Why: Supabase exposes every public table through PostgREST using the anon
-- key. Turning RLS on with NO policies closes that door completely - nothing
-- gets through the REST/anon path. The API's own direct Postgres connection
-- (the pooled `postgres` role) bypasses RLS, so the app is unaffected.
--
-- This file was reconstructed to match the live Integrator-App dev database,
-- where RLS is already enabled on all six v1 tables. It is idempotent, so
-- re-running it against that database is a no-op.

alter table session_highlights enable row level security;
alter table connectors         enable row level security;
alter table consumer_apps      enable row level security;
alter table access_grants      enable row level security;
alter table sync_logs          enable row level security;
alter table admin_users        enable row level security;
