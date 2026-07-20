-- Integrator App - v1 migration (AI-highlights vertical)
-- Portable Postgres only. No Supabase-specific features.

-- outcome + significance are FIRST-CLASS: wins AND failures both matter.
create table if not exists session_highlights (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,                          -- 'claude'|'chatgpt'|'cursor'|...
  project       text,                                   -- 'Integrator App', 'Failing Daily', ...
  outcome       text not null check (outcome in ('win','loss','lesson')),
  significance  smallint not null default 3 check (significance between 1 and 5),
  title         text not null,
  highlight     text not null,                          -- curated summary, Bill Speak
  detail        text,                                   -- optional, richer when significance is high
  tags          text[] not null default '{}',
  metadata      jsonb  not null default '{}',
  captured_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists session_highlights_captured_at_idx on session_highlights (captured_at desc);
create index if not exists session_highlights_project_outcome_idx on session_highlights (project, outcome);

create table if not exists connectors (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,                      -- 'ai-capture'|'plaid'|'nango'
  kind       text not null check (kind in ('inbound','outbound')),
  config     jsonb not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists consumer_apps (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,                    -- 'Bills-Master-Plan'
  api_key_hash text not null,                           -- store hash only
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists access_grants (
  id              uuid primary key default gen_random_uuid(),
  consumer_app_id uuid not null references consumer_apps(id) on delete cascade,
  connector_id    uuid not null references connectors(id)    on delete cascade,
  permission      text not null check (permission in ('read','sync')),
  created_at      timestamptz not null default now(),
  unique (consumer_app_id, connector_id)
);

create table if not exists sync_logs (
  id           uuid primary key default gen_random_uuid(),
  connector_id uuid references connectors(id) on delete set null,
  direction    text not null check (direction in ('in','out')),
  status       text not null check (status in ('ok','error')),
  detail       text,
  occurred_at  timestamptz not null default now()
);

create table if not exists admin_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- Seed the inbound AI-capture connector.
insert into connectors (key, kind)
values ('ai-capture', 'inbound')
on conflict (key) do nothing;
