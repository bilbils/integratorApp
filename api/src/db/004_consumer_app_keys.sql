-- Integrator App - migration 004: make a presented consumer key resolve in one
-- indexed lookup, and record when each app was last seen.
--
-- Why: v1 verified a consumer key by scanning every active consumer_apps row
-- and bcrypt-comparing against each hash. That was fine with one registered
-- app. Now that apps can be registered from the admin screen, it becomes one
-- bcrypt per app per request - deliberately slow work, multiplied by the size
-- of a list we're encouraging Bill to grow.
--
-- Fix: keys carry a public, non-secret id. `int_<key_id>_<secret>` - the app is
-- found by key_id (unique index), then exactly one bcrypt compare runs against
-- the secret half. Only the secret is ever hashed and stored; key_id is public
-- by design, the way an access-key id is public.
--
-- key_id is nullable so existing legacy keys keep working until rotated.

alter table consumer_apps add column if not exists key_id       text;
alter table consumer_apps add column if not exists last_used_at timestamptz;

create unique index if not exists consumer_apps_key_id_idx on consumer_apps (key_id);
