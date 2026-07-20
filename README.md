# Integrator App

An integration hub for LFODIE's companies. Bill configures integrations here;
the app feeds data out to consumer apps (Bills-Master-Plan, Staffility, IPTA
tools, Blue Orbit, more later).

Full context and decisions live in
`Documents\Claude\Projects\Integrator App\CLAUDE.md` and the drafts beside it.

## What's built (v1 - the AI-highlights vertical)

The first slice proves every layer of the platform end-to-end:

```
capture (MCP push) -> store (session_highlights) -> REST API -> MCP read -> consumer
```

It replaces the manual "publish snippets to Supabase" habit: AI tools push a
curated highlight of a work session, the Integrator stores it, and consumers
(like Bills-Master-Plan) read it back for daily/weekly reviews and content.
Wins **and** failures are first-class - every highlight is tagged
`win` / `loss` / `lesson`.

Plaid and Nango come next as connectors 2 and 3.

## Stack

- **API + MCP:** Node/Express + TypeScript (`/api`). One shared service layer;
  the REST routes and the MCP tools both call it.
- **DB:** Postgres. Dev is Supabase-hosted; code is plain SQL / standard
  Postgres only, so moving to Azure Database for PostgreSQL later is a
  connection-string swap.
- **Frontend:** Angular admin UI - **next commit** (not in this one).
- **Hosting target:** Azure.

## Layout

```
api/
  src/
    config.ts            env loading
    db/
      pool.ts            pg pool
      001_init.sql       first migration (6 tables + ai-capture seed)
      migrate.ts         applies the migration
    services/
      highlights.ts      create / list / get (the single source of truth)
      auth.ts            ingest token, consumer keys, admin login
    http/
      server.ts          express app
      middleware.ts      auth guards
      routes/
        highlights.ts    POST (push) + GET (read)
        auth.ts          admin login
    mcp/
      server.ts          stdio MCP server: log_session_highlight, search_highlights
    index.ts             API entrypoint
```

## Setup

```bash
cd api
cp .env.example .env      # fill in DATABASE_URL (Supabase), INGEST_TOKEN, JWT_SECRET
npm install
npm run migrate           # applies 001_init.sql
```

Requires Postgres 13+ (for `gen_random_uuid()`); Supabase already has it.

## Run

```bash
npm run dev               # REST API on :PORT (default 3000)
npm run mcp               # MCP server on stdio
```

## REST API (v1)

| Method | Path                    | Auth              | Purpose                    |
|--------|-------------------------|-------------------|----------------------------|
| GET    | `/health`               | none              | liveness                   |
| POST   | `/api/v1/highlights`    | `Bearer <INGEST_TOKEN>` | capture a highlight  |
| GET    | `/api/v1/highlights`    | `Bearer <consumer key>` | list (filterable)    |
| GET    | `/api/v1/highlights/:id`| `Bearer <consumer key>` | single highlight     |
| POST   | `/api/v1/auth/login`    | none (email+pw)   | admin login -> JWT         |

List filters: `project`, `outcome`, `since` (ISO), `significance_min`, `limit`.

## MCP tools

The MCP server exposes the same logic as tools, for AI-tool clients:

- **`log_session_highlight`** - push a highlight (needs `ingest_token`).
- **`search_highlights`** - read highlights back (filters as above).

Connect a local client (Claude Desktop / Cursor) by pointing it at the server,
e.g.:

```json
{
  "mcpServers": {
    "integrator": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "C:/Users/WilliamWilliams/OneDrive - lfodie.com/Documents/GitHub/integratorApp/api"
    }
  }
}
```

## Auth (v1)

- **Admin UI login:** app-level email/password (hashed) + JWT. Deliberately
  **not** Supabase Auth - portable to Entra (Azure) later.
- **Machine access:** per-consumer API keys (hashed in `consumer_apps`) for
  reads; a single `INGEST_TOKEN` for capture. Per-source ingest keys come later.

## Notes / next

- Angular admin UI (login + filterable highlights list) is the next commit.
- Seed an admin user and a consumer app once the DB is up (helper scripts TBD).
- `credentials` table is deferred until the Plaid connector.

Editing workflow: staged for review, pushed via GitHub Desktop. No auto-push.
