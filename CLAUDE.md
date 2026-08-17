# CLAUDE.md — Integrator App

## What this is

An integration hub for LFODIE's companies: integrations are configured here and the app feeds data
out to consumer apps (Bills-Master-Plan, Staffility, IPTA tools, Blue Orbit). v1 is the AI-highlights
vertical, proving every layer end to end —
`capture (MCP push) -> store (session_highlights) -> REST -> MCP read -> consumer`.

Two hosts, one repo, both auto-deploying from `main`. The **Angular admin** goes to Netlify:
`netlify.toml` builds `web/` and publishes `web/dist/web/browser`, so `api/`, `render.yaml`,
`mockups/` and the SQL are **not served**. The **Express + TypeScript API and MCP server** go to
Render (`render.yaml`, `rootDir: api`, health check at `/health`).

Netlify **proxies** `/api/*` and `/health` to Render at `status = 200` — a proxy, not a redirect —
so the browser only ever talks to one hostname and CORS never runs. Data is plain Postgres
(dev-hosted on Supabase); the code is standard SQL and `pg`, so the host is a connection string, not
an architecture.

**This is the best-configured repo in this org. Match its conventions rather than importing habits
from the others** — the reasoning behind every choice is already written into the config files. Read
those comments before changing anything they cover.

## Build & run

**API (`api/`)**, after copying `.env.example` to `.env`: `npm run dev` (tsx watch) ·
`npm run build` (`tsc -p .`) · `npm start` · `npm run mcp` (stdio MCP server) · `npm run migrate` ·
`npm run seed`.

**Web (`web/`):** `npm start` (ng serve :4200, expects the API on :3000) · `npm run build`, which
defaults to the `production` configuration and file-replaces `environment.ts` with
`environment.production.ts`.

**Netlify:** `npm --prefix web ci` + `npm --prefix web run build`, then copies `mockups/index.html`
in at `/mockup`. Node 22 on both hosts.

## Line endings

`.gitattributes` is `* text=auto eol=lf`, with a comment saying it **deviates from the org's usual
CRLF default on purpose** — Node/Angular repo, LF keeps diffs clean across machines. Write LF here;
do not "fix" it toward CRLF, and do not copy the line into a repo that is CRLF.

Either way: **a generator must take its endings from the SOURCE file it rewrites, never assert
them** — hardcoding CRLF in a build script cost this org a month in another repo. Verify in Node
(`(s.match(/(?<!\r)\n/g)||[]).length`); `grep -P` strips the newline first, so it always returns
zero and proves nothing.

## Landmines

- **`api/src/db/migrate.ts` re-runs EVERY `.sql` in `src/db/` in filename order, every time — there
  is no ledger table.** Every migration must therefore be idempotent (`if not exists`, `on conflict
  do nothing`, `create or replace`). One non-idempotent file breaks `npm run migrate` for everyone,
  permanently.
- **`DATABASE_URL` is deliberately NOT declared in `render.yaml`** — dashboard only. Declaring it
  there, even with `sync: false`, made the blueprint authoritative and silently reverted dashboard
  edits on every push to `main`: the dashboard showed the new value while the process kept the old
  one, so `/health` passed and only the first query failed. It must be the Supabase **session**
  pooler (port 5432) — not the direct `db.<ref>` host (IPv6-only, Render is IPv4, `ENETUNREACH`)
  and not 6543 (transaction mode, wrong for a long-lived `pg.Pool`).
- **The API origin is a literal in `netlify.toml` in TWO places** (`/api/*` and `/health`) —
  Netlify does not interpolate env vars into redirects. Change both together, and confirm against
  the URL Render actually assigned.
- **`/health` needs its own redirect rule.** The masthead strips `/api/v1` off `apiBaseUrl` and
  probes the site root; without it the request falls through to the SPA catch-all, gets `index.html`,
  fails to parse as JSON, and reports "API unreachable" while the API is perfectly healthy.
- **The Netlify proxy times out around 30s; `GATEWAY_TIMEOUT_MS` is 60s.** A slow agent invoke from
  the admin UI can be cut off at the proxy while a server-to-server caller hitting Render directly
  gets the full 60. If a long invoke fails only in the browser, that is why.
- **`BUILD_STAMP` lives in three files that must move together:** `api/src/version.ts`,
  `web/src/environments/environment.ts` and `environment.production.ts`. The masthead shows the API's
  and the UI's side by side and turns amber on a mismatch — that amber is the "only half the deploy
  landed" signal, so fix the deploy, don't silence the flag.
- **`environment.production.ts` says `/api/v1` on purpose.** Putting a full `https://` URL there
  reintroduces CORS for no benefit and couples the frontend build to the API's hostname.
- **`api/src/http/server.ts.bak.pre-cors` is tracked.** There are no secrets in it — but a `.bak` in
  version control is exactly the shape that carries one next time, and `.gitignore` covers `.env`,
  `*.local` and `*.broken-backup` but **not `*.bak*`**. Delete the file or extend the ignore; either
  way, don't add another.
- **`--include=dev` in the Render build command is not optional.** Render sets
  `NODE_ENV=production`, so a bare `npm ci` skips devDependencies — and `typescript` is one.

## Data / services

- **Postgres, dev-hosted on Supabase.** Migration `002` enables RLS with **no policies** on the v1
  tables: that closes the PostgREST/anon door completely, and the API is unaffected because its
  pooled Postgres role bypasses RLS. Keep the shape — a new table gets RLS on and no policies.
- **Secrets live in env vars and never in the repo.** `render.yaml` declares `JWT_SECRET`,
  `INGEST_TOKEN` and `OPENROUTER_API_KEY` with `sync: false` and **no values**; non-secret config
  (base URL, timeout, app URL/title, CORS origins) has its source of truth in that file. Render's
  env store is **write-only** — keep your own copy of anything you mint there.
- **`api/src/config.ts`'s `required()` throws `Missing required env var: <name>` at boot.** Loud is
  the correct failure; never give a secret a default to quiet it. `OPENROUTER_API_KEY` is
  deliberately optional — only agent invocation degrades, so nobody needs a model key to run the
  admin locally.
- **Auth:** admin email + password (bcrypt) exchanged for a JWT — deliberately **not** Supabase Auth,
  so it ports to Entra later. Machine access is per-consumer hashed API keys for reads plus one
  `INGEST_TOKEN` for capture; `requireReader` accepts either. Seeding hardcodes nothing — `npm run
  seed` requires its admin credentials from the environment and throws without them.

## Before every push

1. **Who else implements this?** One service layer feeds both the REST routes and the MCP tools — one route is rarely the whole change.
2. **Who else *reads* what I started writing?** A new column is invisible to every `select` and DTO that does not name it.
3. **Where does this deliberately NOT belong?** Write the reason into the file, as `render.yaml` and `environment.production.ts` already do.
4. **What one command proves it landed everywhere?** Run it afterwards.
5. **What now contradicts what I shipped?** `README.md`, `DEPLOY.md`, `render.yaml` and `.env.example` all document behaviour — chase the reversal into each.

Commit to a branch and let Bill merge. The README's own rule: staged for review, pushed via GitHub
Desktop, **no auto-push.**

## Verification

- **Ask what a green check is physically incapable of seeing, then watch it go red against the
  broken version. A suite that has never failed is not evidence.**
- **`/health` returns `{ok, version, build}`.** Compare that `build` against the UI's stamp in the
  masthead — agreement is the only proof *both* halves of the deploy went out. A green Render deploy
  proves the API booted and says nothing at all about the frontend.
- **Anything positional gets opened in a real browser.** Headless cannot see "collapsed,"
  "overlapping" or "off-screen" — each returns a perfectly sensible height. And test through the
  Netlify proxy, not `localhost:3000`: CORS, header forwarding and the 30s ceiling only exist there.
- The Angular **production** build enforces bundle budgets, so a build that passes locally in
  `development` can still fail on Netlify.
