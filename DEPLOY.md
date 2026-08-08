# Deploying the Integrator

Two hosts, one repo, both auto-deploying from `main`:

| Piece | Host | Config | URL |
|---|---|---|---|
| Angular admin | Netlify (`staffility-integrator-mockup`) | `netlify.toml` | https://staffility-integrator-mockup.netlify.app |
| API + gateway | Render (`integrator-api`) | `render.yaml` | https://integrator-api-koyz.onrender.com |

The admin does **not** call the API cross-origin. Netlify proxies `/api/*` and
`/health` through to Render, so the browser only ever sees one hostname and CORS
never runs. That is why `environment.production.ts` still says `/api/v1`.

---

## Why Render and not Azure

Short version: the API is plain Express + `pg`. There is no Render-specific code
anywhere in this repo, so this is a reversible choice, not an architecture.
Moving to Azure App Service later is a Dockerfile and a connection string.

The one thing Render genuinely cannot do is FedRAMP / Azure Gov. If the
DFARS-CMMC path with IPTA turns real, that becomes a **separate deployment**,
not a migration of this one.

Note that the data does not live in Render either way — it is in Supabase
(`Integrator-App`, `qlckjrkvmtdhfypsxpqv`, `us-east-1`). Client questions about
residency are Supabase questions.

---

## First-time setup

### 0 · Generate the two secrets you own

`JWT_SECRET` and `INGEST_TOKEN` are yours to invent. Do not reuse anything.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Run it twice. Keep both somewhere you'll still have next month — Render's env
store is write-only, so once pasted you cannot read them back out.

### 1 · Get the DATABASE_URL — read this part, it is the trap

**Do not use the direct connection string** (`db.<ref>.supabase.co`). It resolves
to IPv6 only, and Render's outbound network is IPv4. You will get a connection
timeout that looks like a firewall problem and isn't.

Use the **Supavisor session pooler** instead:

- Supabase dashboard → project `Integrator-App` → **Connect**
- Choose **Session pooler** (port **5432**), not Transaction pooler (6543).
  Session mode is the right one for a long-lived Node server holding a `pg.Pool`;
  transaction mode disables prepared statements and is meant for serverless.
- Copy the string it gives you verbatim. The username will look like
  `postgres.qlckjrkvmtdhfypsxpqv` and the host like
  `aws-<n>-us-east-1.pooler.supabase.com`.

If the password contains anything outside `[A-Za-z0-9]`, URL-encode it or reset
it to an alphanumeric password. An unencoded `#`, `@`, `/` or `:` truncates the
connection string and surfaces as a bewildering auth error rather than a parse
error. (This has already cost us one session — see the `db-connection-strings`
note.)

### 2 · Push this branch

Review the diff in GitHub Desktop and push to `main`.

Netlify redeploys immediately. For the next few minutes `/api/*` will proxy to a
Render service that does not exist yet and return **502**. That is expected and
temporary — it replaces the old deliberate 503.

### 3 · Create the Render service

- Render Dashboard → **New** → **Blueprint**
- Connect the `bilbils/integratorApp` repo
- Render reads `render.yaml`, shows you the `integrator-api` service, and
  prompts for the four `sync: false` values:
  `DATABASE_URL`, `JWT_SECRET`, `INGEST_TOKEN`, `OPENROUTER_API_KEY`
- Apply. First build takes ~3-5 minutes (`npm ci --include=dev && npm run build`).

### 4 · Confirm the hostname matches

Render assigns the URL. If `integrator-api` was already taken globally it will
have picked something else.

If the assigned URL is **not** `https://integrator-api-koyz.onrender.com`, edit the
**two** `to =` lines in `netlify.toml` to match and push again. They are flagged
with a banner comment; there are exactly two.

### 5 · Run the migrations

The DB may already have 001-004 applied from local work — the migrate script is
folder-driven and idempotent, so running it is safe either way. From the Render
service's **Shell** tab:

```bash
npm run migrate
```

---

## Verifying it actually worked

Do all four. The first two can pass while the app is still broken.

**1 · The API answers directly**

```bash
curl -s https://integrator-api-koyz.onrender.com/health
```

Expect `{"ok":true,"version":"0.3.0","build":"0808-1816"}`.

**2 · The proxy answers**

```bash
curl -s https://staffility-integrator-mockup.netlify.app/health
curl -s -o /dev/null -w '%{http_code}\n' \
  https://staffility-integrator-mockup.netlify.app/api/v1/agents
```

`/health` must return the same JSON as step 1 — **not** HTML. If you get
`<!doctype html>`, the `/health` redirect rule is missing or ordered after the
SPA catch-all, and the masthead will lie about the API being down.

`/api/v1/agents` should return **401** (unauthenticated), not 502 and not 200.
A 401 proves the request reached Express and was rejected by auth — that is the
whole chain working.

**3 · The masthead goes green**

Open the admin, hard-refresh (`Ctrl+Shift+R`). The build marker should read
`v0.3.0 · 0808-1816` with **no amber flag**. Amber means one of:

- "API unreachable" → the proxy or the service is down
- `API 0801-0105` → Render deployed but Netlify didn't, or vice versa. One half
  of the deploy landed. That is exactly what this marker is for.

**4 · Sign in and load a real page**

Log in, open **AI Agents**. If the list renders, the JWT round-trip and the DB
connection are both good. This is the check that proves the pooler string works
— steps 1-3 all pass without the database.

---

## Deploying afterwards

Push to `main`. Both hosts rebuild.

**Bump the build stamp on every deploy**, in both places, to the same value:

- `api/src/version.ts` → `BUILD_STAMP`
- `web/src/environments/environment.production.ts` → `buildStamp`
  (and `environment.ts` to keep dev consistent)

Format `MMDD-HHMM` Eastern. If they disagree, the masthead turns amber and tells
you which half is stale — that is a feature, don't silence it.

---

## Known ceilings

- **Netlify proxy responses cut off around 30s.** The API's own
  `GATEWAY_TIMEOUT_MS` is 60s. A slow agent invoke launched from the admin screen
  can therefore be killed by the proxy before the API gives up. Server-to-server
  callers (Master-Plan's edge function) hit Render directly and get the full 60s.
  This only degrades interactive testing.
- **Render Starter is 512MB / 0.5 CPU.** Fine for a control plane. If the cost
  ledger or a highlights backfill starts pushing memory, Standard is $25/mo.
- **Secrets in Render's env store are write-only.** You cannot read them back.
  Keep your own copy of `JWT_SECRET` and `INGEST_TOKEN` — rotating `JWT_SECRET`
  invalidates every admin session, and rotating `INGEST_TOKEN` breaks every
  configured pusher.

## What does NOT belong in Render's env store

Per-tenant and per-client credentials — each M365 tenant's client secret, each
consumer app's key, each future connection's token. Those scale with customers;
you cannot redeploy to onboard a client.

They belong in Postgres, encrypted at the application layer, keyed by
`tenant_id`, with the single master encryption key in Render's env store. That
is migration 005 (the connections layer) and it is not built yet.
