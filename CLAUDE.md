# CLAUDE.md — Integrator App

## § NEVER

Rules whose violation is expensive, public, irreversible or regulatory. Not a list of everything that
would be wrong — see § Landmines for that. Append the moment you find one, in the same breath, before
the next action. Each rule carries WHY, and the date and method it was found by, because a NEVER with
no reason attached gets deleted by a future session that cannot see the reason. **Do not weaken or
remove one on your own inference — flag it for Bill instead.**

1. **NEVER treat a response from the `netlify.app` origin as evidence about the API, auth, the
   database, or a deploy.**

   > ⚠ **PREMISE CHANGED 2026-08-23 — AWAITING BILL'S AMENDMENT. Do not act on the paragraph below
   > as written, and do not delete it.** Bill asked for the Netlify visitor-access gate to be turned
   > **OFF** so Josh needs only his Integrator login. It is off — verified by reading the project
   > back from Netlify's API (`requiresPassword: false`, `requiresSSOTeamLogin: false`), not by
   > trusting the write, which returned a Cloudflare 502 while succeeding. **A 401 from that origin
   > now does mean the app's auth.** The *lesson* is permanent and must survive any rewrite: never
   > accept a status code as evidence when a total failure returns the same code. The *fact* about
   > this site is now false. Proposed replacement text is in
   > `<PROJECT DIR>\drafts\Integrator-App-Options-Catalogue-and-Pricing_0823.md`; a session may
   > not apply it without Bill saying so.

   The site has visitor-access password protection on for production *and*
   previews, which answers with its own HTML form and a **401** before the proxy rule ever runs. A
   total block and a successful-chain-with-bad-credentials return the identical status code, so any
   check whose success criterion is 401 **cannot fail**. Verify against
   `integrator-api-koyz.onrender.com` directly.
   *Why:* the 08-08 verification table celebrated `…netlify.app/api/v1/agents` → 401 as "the full
   chain in one number." It was the gate — the request never reached Express. The same check was
   re-run on 08-17 to the same wrong conclusion and cost about an hour, with Bill typing his admin
   password into Netlify's site-password box and reading "wrong password" as app auth. `/health`
   *does* pass the gate and return real JSON, which is why the masthead stayed green for nine days:
   one path passed, and only that one was ever checked.
   *Found:* 2026-08-17, by sending one identical request to both targets — Render returned a JWT,
   Netlify returned 401. Gate re-confirmed still ON that day from Netlify's API
   (`requiresPassword: true`, scope `all`).

2. **NEVER declare `DATABASE_URL` in `render.yaml`.** Dashboard only. Declaring it there — even with
   `sync: false` — makes the blueprint authoritative, and every later push to `main` silently reverts
   dashboard edits. The symptom is near-undiagnosable: the dashboard shows the new value while the
   running process keeps the old one, so `/health` passes and only the first query fails.
   The value must be the Supabase **session** pooler (port 5432) — **not** the direct
   `db.<ref>.supabase.co` host, which is IPv6-only against Render's IPv4 outbound and fails as
   `ENETUNREACH` looking like a firewall problem, and **not** 6543, which is transaction mode and
   wrong for a long-lived `pg.Pool`. As of 2026-08-08 the direct host no longer resolves at all, so
   the pooler is mandatory rather than merely preferred. A password with special characters must be
   URL-encoded; the reliable move is to reset it to something alphanumeric.
   *Found:* 2026-08-08, during the initial Render deploy.

3. **NEVER run `npm run seed` against a database anyone is using.** It rotates the consumer app's API
   key **unconditionally, on every run**, so a re-seed always invalidates the key in every caller's
   hand — and it takes the admin password from the environment, so a placeholder left inside a
   copy-pasteable command becomes the real password.
   *Found:* 2026-08-17 — both happened, in that order. The first seed set the admin password to the
   literal string `<pick an admin password>`; the re-seed that fixed it rotated the consumer key a
   second time.

   **Corollary, and it has now caught this project TWICE: never hand over a copy-pasteable command
   with a secret-shaped placeholder inside it. Prompt for the value instead.** On 2026-08-23 the
   same shape was offered again for `add-admin` and Bill pasted `'<new, 12+ chars>'` as the literal
   password. It only failed because npm was run from the wrong directory and never reached the
   database — the placeholder is 17 characters, so the 12-character floor would **not** have caught
   it. The safe shape keeps the value off the command line and out of PowerShell history:

   ```powershell
   cd C:\dev\project\integratorApp
   $s = Read-Host 'New password' -AsSecureString
   $env:ADMIN_EMAIL = 'someone@example.com'
   $env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
     [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   npm --prefix api run add-admin
   Remove-Item Env:\ADMIN_PASSWORD
   ```

   Note also that `npm --prefix api` is relative to the **current directory** — run it from the repo
   root or it looks for `<cwd>\api\package.json` and fails with ENOENT, which is what happened.

4. **NEVER add a non-idempotent `.sql` to `api/src/db/`.** `migrate.ts` re-runs **every** file in
   that folder, in filename order, on every invocation — there is no ledger table. One
   non-idempotent file breaks `npm run migrate` for everyone, permanently. Use `if not exists`,
   `on conflict do nothing`, `create or replace`, and test from an empty database.

5. **NEVER create a public table without RLS on and no policies.** That exact combination closes the
   PostgREST/anon door completely, and the API is unaffected because its pooled Postgres role
   bypasses RLS. It is the only thing standing between the anon key and every row. Migration `002`
   set the shape — match it, and let the STATE PROBE confirm coverage rather than assuming. (EGRESS)

6. **NEVER push or deploy on your own initiative, and never let a secret reach the repo.** Push to
   `main` **is** the deploy, to two hosts at once. Commit to a branch and stop; Bill reviews and
   pushes in GitHub Desktop. And never paste a live secret into chat, a document, or a commit — and
   never "redact" one, because a redaction that matches the label instead of the value reads as proof
   it worked. Select a boolean or a length instead. The fix for a disclosure is **rotation**, not
   deletion. Render's env store is write-only, so keep your own copy of anything minted there,
   somewhere that is not this repo. Before any push, ask: if this repo went public tomorrow, what
   would have to be rotated? The only correct answer is nothing.
   *Found:* 2026-08-08 — a live DB password was pasted into chat and had to be rotated (it needed
   resetting anyway). 2026-07-22 — a `.env` reached version control; all three secrets were rotated
   and `.env*` gitignored.

7. **NEVER route IPTA client-adjacent content through an agent** until residency is decided and
   written down. Every invoke leaves this system for OpenRouter, a third party. For LFODIE's own
   content that is a cost question; for client content it is a data-residency and possibly a
   contractual one, and the DFARS scanner exists precisely because those obligations are real here.
   Render is also **not** FedRAMP / Azure Gov capable, so a real CMMC path is a separate deployment,
   not a migration. (EGRESS / REGULATORY)

8. **NEVER run `git` through `device_bash`.** It leaves a `.git/index.lock` that cannot be deleted
   from that side and blocks Bill's next push. Cowork may read and write files in the clone; git is
   Bill's, in GitHub Desktop.

9. **NEVER read `ai_agent_runs.cost_usd` as literal dollars.** OpenRouter returns account **credits**.
   Confirm the credit-to-USD rate before quoting spend. (COST — Render Starter at $7/mo is the other
   live cost here.)

## § CARD

| slot | value |
|---|---|
| **PROJECT** | Integrator App — the single controlled doorway between LFODIE's apps (Bills-Master-Plan, Staffility, IPTA, Blue Orbit) and the outside services they need. A **control plane**, not a database. |
| **REPO** | `https://github.com/bilbils/integratorApp` (**public**) · clone at **`C:\dev\project\integratorApp`**. Moved out of OneDrive 2026-08-16, because OneDrive sync and `.git` fight each other. `Documents\GitHub\integratorApp` **does not exist**, and `Documents\GitHub\Archive\integratorApp` is stale — never read either, and never fall back to them. |
| **LIVE SITE** | `https://staffility-integrator-mockup.netlify.app` — Netlify project `staffility-integrator-mockup`, site id `b17fc0bb-9ef8-4e72-905e-143a7cba8639`. Serves the real Angular admin; the original design sketch is at `/mockup`; the **architecture workbench is at `/workbench`** (a static page, not part of the Angular bundle, with its own redirect above the SPA catch-all in `netlify.toml`). Admin and workbench **share one session** — both read `localStorage['integrator_token']`. **Visitor-access password protection was turned OFF 2026-08-23 at Bill's request — see the flag on § NEVER #1, whose premise that change invalidates.** The name still says "mockup"; rename it in Netlify when convenient. |
| **BACKEND** | `https://integrator-api-koyz.onrender.com` — Render web service `integrator-api`, plan `starter`, region `virginia`, health at `/health`. The `-koyz` is Render's, not a typo: the plain name was taken globally. **This is the authoritative target for every API check.** |
| **ENVIRONMENT** | **One environment, and it is a hybrid — say so rather than calling it either.** The hosts are production-facing (public URLs, Bill signs in, Master-Plan is being pointed at it) while the data store is the *dev* Supabase project `Integrator-App` (`qlckjrkvmtdhfypsxpqv`, us-east-1). There is no staging, no second database, no separate production credentials. A destructive mistake here has no upstream copy to restore from. |
| **PROJECT DIR** | `C:\Users\WilliamWilliams\OneDrive - lfodie.com\Documents\Claude\Projects\Integrator App` — planning and context, with `context\`, `drafts\`, `outputs\`. It holds a **second, much larger `CLAUDE.md`**: current state, decisions, changelog. Different document, different job. This file is the repo's rules; that one is the project's state. |
| **STATE PROBE** | **`npm --prefix api run probe`** → `api/src/ops/probe.ts`. Returns branch / HEAD / dirty / unpushed, the three build-stamp literals and whether they agree, live `/health` from Render, whether Netlify's visitor gate is answering, every row count in the database, RLS coverage, and the migration file list. Run it before quoting any number, and read its own caveats — it refuses to print a verdict it cannot observe. |
| **PLAN TABLES** | `plan_jobs`, `plan_answers`, `plan_options` (migrations **010**, **011**, **012**, probe columns in **013**) plus `plan_adrs`, `plan_reconcile`, `plan_issues` (**014** schema, **015** seed) — the workbench's own storage, served by `/api/v1/plan`, `/api/v1/plan-options`, `/api/v1/plan-probes` and `/api/v1/plan-reconcile`, **`requireAdmin` on every route** (`requireReader` would admit a consumer key). 012 and 015 are `on conflict (slug) do nothing` **on purpose**: migrate.ts replays every file, so `do update` would reset every human pick, rationale and verdict. A research refresh is a NEW migration naming only the descriptive columns. **Naming, because it has already cost two failed queries: `plan_adrs`, `plan_issues` and `plan_options` are PLURAL; `plan_reconcile` is singular because one row IS one option set. Status columns carry the table prefix — `adr_status`, `issue_status`, never bare `status` (except `plan_options.status`, which is the pick state).** |
| **BACKLOG** | **`public.tasks` in the Bills-Master-Plan Supabase project (`acwnpnrjlzhkvqmvotvn`)** — the native backlog that already exists. Do not stand up a second one. Integrator rows: `where title ilike '%integrator%' or ctx ilike '%integrator%'`. Columns that matter: `status`, `priority`, `due`, `world`, `origin`, `needs_decision`. Never write an id into a document before the insert returns it. |
| **DECISION INDEX** | Cowork **project memory** `MEMORY.md` for the "Integrator App" project — one line per decision, pointing at the dated deep-dives in `<PROJECT DIR>\drafts\*_MMDD.md`. Not a file in this repo and not a file in the project folder. An unindexed draft is an invisible draft. |
| **BUILD** | `0.x.y` plus a `MMDD-HHMM` Eastern stamp, in **three literals that must move together**: `api/src/version.ts`, `web/src/environments/environment.ts`, `web/src/environments/environment.production.ts`. **The current value is deliberately not written here** — read it from `/health` and the masthead, or run the STATE PROBE. The masthead shows the API's and the UI's side by side and turns amber on a mismatch; that amber means only half the deploy landed, so fix the deploy rather than silencing the flag. Corollary worth remembering: a commit that changes code **without** bumping the stamp is invisible to `/health`, which will keep reporting the previous value whether or not the deploy landed. |
| **IaC** | `render.yaml` (Render blueprint — service, plan, region, build command, non-secret env) and `netlify.toml` (Netlify build plus the two proxy rules). No Terraform, no Bicep. Secrets are declared `sync: false` with no values; `DATABASE_URL` is dashboard-only on purpose (§ NEVER #2). |

**The card is a claim, not a fact.** Any session where something does not match reality, check every
slot: does the clone path exist, does the probe run, does the backlog return rows, does this file
describe the system actually there. A slot that is filled but WRONG is worse than one marked NONE,
because NONE gets fixed.

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

The two most expensive rules that used to live here — `DATABASE_URL` in `render.yaml`, and
`migrate.ts` having no ledger table — are now § NEVER #2 and #4. They were moved, not copied: a rule
with two homes has one that rots.

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
- **Every `npm --prefix api …` command must be given WITH the `cd`.** `--prefix` resolves
  `api/` against the CURRENT DIRECTORY, so run from anywhere else and it fails `ENOENT -4058`
  looking for `<cwd>\api\package.json` — which reads as a broken repo, not a wrong folder.
  *Found:* twice — 2026-08-23 on `add-admin`, then again the same day on `migrate`, both times
  because the command was handed over without the `cd` in front of it. Lead with the `cd`.

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

## Run agents in parallel

**Standing instruction from Bill, 2026-08-23:** *"always run multiple agents where you can."*

Two mechanics make the difference, and getting either wrong wastes an hour:

- **Multiple `Agent` calls must go in ONE message.** A call issued in its own message blocks until
  it returns, so six research passes written one per message run *sequentially* — about fourteen
  minutes each. That is exactly what happened on 2026-08-23 and Bill was right to call it out.
- **Have each agent WRITE its result to a file and reply with a short summary.** An agent that
  returns 50 KB of JSON spends it out of the orchestrating context, which is the scarce resource.
  `research/set-*.json` is the pattern: the agent writes, then replies with the path, the byte
  count, and up to three findings that would change a decision.

Partition so agents never touch the same file. Backend, generator and page can be three agents;
two agents editing one HTML file cannot.

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
