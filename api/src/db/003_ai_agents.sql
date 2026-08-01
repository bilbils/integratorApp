-- Integrator App - migration 003: the AI gateway's "AI Agents" registry.
-- Portable Postgres only. No Supabase-specific features.
--
-- The gateway is NOT hardcoded routing rules. Every capability is a row here:
-- a name, a purpose, a prompt, a model, some knobs, and the list of consumer
-- apps allowed to call it. New capability = new row, not a deploy.

-- --------------------------------------------------------------------------
-- ai_agents - one row per saved job.
-- --------------------------------------------------------------------------
create table if not exists ai_agents (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,                  -- stable handle callers use, e.g. 'summarizer'
  name            text not null,                         -- human label, e.g. 'Summarizer'
  purpose         text,                                  -- one line: what job this does
  prompt          text not null default '',              -- the agent's instructions - tuned here, no deploy
  model           text not null,                         -- cheapest model that can do the job
  fallback_model  text,                                  -- optional stronger model; escalate ON EVIDENCE
  temperature     numeric(3,2) not null default 0.30 check (temperature >= 0 and temperature <= 2),
  max_tokens      integer not null default 400 check (max_tokens > 0 and max_tokens <= 200000),
  json_output     boolean not null default false,        -- true when a machine reads the result
  enabled         boolean not null default false,        -- new agents start off
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ai_agents_enabled_idx on ai_agents (enabled);

-- Keep updated_at honest without the app having to remember.
create or replace function set_updated_at() returns trigger language plpgsql as $fn$
begin
  new.updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists ai_agents_set_updated_at on ai_agents;
create trigger ai_agents_set_updated_at
  before update on ai_agents
  for each row execute function set_updated_at();

-- --------------------------------------------------------------------------
-- ai_agent_grants - which consumer apps may call which agent.
--
-- Deliberately a real foreign key to consumer_apps, not a list of loose names:
-- a caller presents a consumer key, that key resolves to a consumer_app row,
-- and this table is what makes "which apps can call this agent" enforceable
-- at request time instead of decorative.
-- --------------------------------------------------------------------------
create table if not exists ai_agent_grants (
  agent_id        uuid not null references ai_agents(id)     on delete cascade,
  consumer_app_id uuid not null references consumer_apps(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (agent_id, consumer_app_id)
);
create index if not exists ai_agent_grants_app_idx on ai_agent_grants (consumer_app_id);

-- --------------------------------------------------------------------------
-- ai_agent_runs - the cost/outcome log.
--
-- This is the evidence behind "escalate on evidence, not by guess", and it is
-- also the per-consumer-app attribution for model spend (central keys, LFODIE
-- pays, usage tracked per app). Per-company chargeback later is a reporting
-- view over this table, not a second build.
--
-- hard_fail = the cheapest model was genuinely not good enough for this call
-- (rejected/unusable output), as opposed to a transient error. That is the
-- signal that should promote an agent's fallback to its default.
-- --------------------------------------------------------------------------
create table if not exists ai_agent_runs (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references ai_agents(id)     on delete cascade,
  consumer_app_id   uuid          references consumer_apps(id) on delete set null,
  model             text not null,                       -- the model actually used
  used_fallback     boolean not null default false,
  status            text not null check (status in ('ok','error')),
  hard_fail         boolean not null default false,
  prompt_tokens     integer,
  completion_tokens integer,
  cost_usd          numeric(12,6) not null default 0,
  latency_ms        integer,
  detail            text,
  occurred_at       timestamptz not null default now()
);
create index if not exists ai_agent_runs_agent_time_idx on ai_agent_runs (agent_id, occurred_at desc);
create index if not exists ai_agent_runs_app_time_idx   on ai_agent_runs (consumer_app_id, occurred_at desc);

-- Same anon/PostgREST door-closing as migration 002.
alter table ai_agents       enable row level security;
alter table ai_agent_grants enable row level security;
alter table ai_agent_runs   enable row level security;

-- Register the gateway itself as an outbound connector, alongside ai-capture.
insert into connectors (key, kind)
values ('ai-gateway', 'outbound')
on conflict (key) do nothing;
