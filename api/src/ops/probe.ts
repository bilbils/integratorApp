/**
 * THE STATE PROBE.  `npm --prefix api run probe`
 *
 * One command that returns every number anyone might otherwise quote from prose.
 * If you are about to write a count, a version or a build stamp into a document,
 * you are about to create a second home for a value that will rot. Run this
 * instead, and put the COMMAND in the document.
 *
 * Deliberate design choices:
 *
 * - It does NOT import config.ts. That module's required() throws on a missing
 *   INGEST_TOKEN or JWT_SECRET, and the probe must still be able to tell you
 *   "DATABASE_URL is missing" rather than dying on an unrelated var. A probe that
 *   cannot run in a broken environment is useless precisely when you need it.
 *
 * - It hits RENDER directly for /health, and treats the netlify.app origin as a
 *   separate, explicitly-labelled question. See the note printed under NETLIFY:
 *   that origin sits behind Netlify's visitor-access password gate, which answers
 *   401 before the proxy ever runs. On 2026-08-17 that cost about an hour, after
 *   nine days of a green-looking verification table that could not have failed.
 *
 * - Every line is either an observed value or the word UNKNOWN. It never infers.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const RENDER = 'https://integrator-api-koyz.onrender.com';
const NETLIFY = 'https://staffility-integrator-mockup.netlify.app';
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const out: string[] = [];
const say = (s = '') => out.push(s);

/** Pull `export const X = '...'` / `X: '...'` out of a source file without importing it. */
function literal(file: string, key: string): string {
  try {
    const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    const m = src.match(new RegExp(`${key}\\s*[:=]\\s*['"\`]([^'"\`]+)`));
    return m ? m[1] : 'NOT FOUND';
  } catch {
    return 'FILE MISSING';
  }
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'UNKNOWN';
  }
}

async function probeUrl(url: string) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const body = (await r.text()).slice(0, 400);
    return { status: r.status, ms: Date.now() - t0, body, ctype: r.headers.get('content-type') ?? '' };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: `FETCH FAILED: ${(e as Error).message}`, ctype: '' };
  }
}

// ---------------------------------------------------------------- repo & build
say('=== REPO =======================================================');
say(`root          ${REPO_ROOT}`);
say(`branch        ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`);
say(`HEAD          ${git(['log', '-1', '--format=%h %ad %s', '--date=short'])}`);
const dirty = git(['status', '--porcelain']);
say(`working tree  ${dirty === '' ? 'clean' : `${dirty.split('\n').length} uncommitted path(s):`}`);
if (dirty && dirty !== 'UNKNOWN') dirty.split('\n').forEach((l) => say(`              ${l}`));
say(`unpushed      ${git(['log', '--oneline', '@{u}..HEAD']) || 'none'}`);
say();

say('=== BUILD MARKER (three literals that must agree) ==============');
const stamps = {
  'api/src/version.ts': [literal('api/src/version.ts', 'VERSION'), literal('api/src/version.ts', 'BUILD_STAMP')],
  'web/.../environment.ts': [
    literal('web/src/environments/environment.ts', 'version'),
    literal('web/src/environments/environment.ts', 'buildStamp'),
  ],
  'web/.../environment.production.ts': [
    literal('web/src/environments/environment.production.ts', 'version'),
    literal('web/src/environments/environment.production.ts', 'buildStamp'),
  ],
};
for (const [f, [v, b]] of Object.entries(stamps)) say(`${f.padEnd(34)} ${v} · ${b}`);
const distinct = new Set(Object.values(stamps).map(([v, b]) => `${v}|${b}`));
say(`agreement     ${distinct.size === 1 ? 'OK — all three agree' : `*** MISMATCH — ${distinct.size} distinct values ***`}`);
say();

// ---------------------------------------------------------------- live hosts
say('=== LIVE API (Render — the authoritative target) ===============');
const health = await probeUrl(`${RENDER}/health`);
say(`GET ${RENDER}/health`);
say(`  status      ${health.status} in ${health.ms}ms`);
say(`  body        ${health.body}`);
let liveBuild = 'UNKNOWN';
try {
  liveBuild = `${JSON.parse(health.body).version} · ${JSON.parse(health.body).build}`;
} catch { /* leave UNKNOWN */ }
say(`  live build  ${liveBuild}`);
const localStamp = Object.values(stamps)[0].join(' · ');
if (liveBuild === 'UNKNOWN') {
  // Do NOT render a verdict here. An unanswered request is not evidence of a
  // failed deploy, and printing one would be the same class of error as the
  // 08-08 verification table: a conclusion the observation cannot support.
  say('  vs repo     CANNOT COMPARE — the API did not return parseable JSON.');
  say(`              repo says ${localStamp}. Read the status and body above and`);
  say('              find out WHY before concluding anything about the deploy.');
  if (/allowlist/i.test(health.body)) {
    say('              (This body is a sandbox egress block, not the API. You are');
    say('              running the probe somewhere without network access to Render.)');
  }
} else {
  say(`  vs repo     ${liveBuild === localStamp ? 'MATCHES the repo' : `*** DIFFERS — repo says ${localStamp}. One half of the deploy did not land. ***`}`);
}
say();
say('  NOTE: /health returning the repo stamp does NOT prove the newest commit');
say('  deployed. A commit that changes code without bumping BUILD_STAMP is');
say('  invisible here. Bump the stamp or this check cannot see the thing it');
say('  exists to see.');
say();

say('=== NETLIFY ORIGIN (diagnostic only — NEVER a source of truth) =');
const nl = await probeUrl(`${NETLIFY}/health`);
say(`GET ${NETLIFY}/health`);
say(`  status      ${nl.status} in ${nl.ms}ms`);
const gated = nl.status === 401 || /password|content-type: text\/html/i.test(nl.body + nl.ctype);
say(`  verdict     ${
  nl.status === 200 && nl.ctype.includes('json')
    ? 'proxy is reachable and returning API JSON'
    : gated
      ? '*** VISITOR-ACCESS GATE APPEARS TO BE ON *** — every request to this'
      : 'unexpected; read the body'
}`);
if (gated) {
  say('              origin answers before the proxy runs, so a 401 here says');
  say('              NOTHING about the API, auth, the database, or the deploy.');
  say('              Do not use this origin to verify anything. Ever.');
}
say();

// ---------------------------------------------------------------- database
say('=== DATABASE (Supabase Integrator-App) =========================');
if (!process.env.DATABASE_URL) {
  say('DATABASE_URL not set — create api/.env from api/.env.example.');
  say('It must be the Supabase SESSION pooler (port 5432).');
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(`
      select
        current_setting('server_version')                                    as pg_version,
        inet_server_addr()::text                                             as server_addr,
        (select count(*) from information_schema.tables
           where table_schema='public')                                      as public_tables,
        (select count(*) from admin_users)                                   as admin_users,
        (select count(*) from connectors)                                    as connectors,
        (select count(*) from consumer_apps)                                 as consumer_apps,
        (select count(*) from consumer_apps where key_id is null)            as apps_on_legacy_key,
        (select count(*) from access_grants)                                 as access_grants,
        (select count(*) from session_highlights)                            as highlights,
        (select count(*) from ai_agents)                                     as ai_agents,
        (select count(*) from ai_agents where enabled)                       as ai_agents_enabled,
        (select count(*) from ai_agent_grants)                               as ai_agent_grants,
        (select count(*) from ai_agent_runs)                                 as ai_agent_runs,
        (select count(*) from ai_agent_runs where hard_fail)                as agent_hard_fails,
        (select count(*) from sync_logs)                                     as sync_logs,
        (select count(*) from pg_tables t where t.schemaname='public'
           and not t.rowsecurity)                                            as tables_without_rls
    `);
    const r = rows[0] as Record<string, string>;
    for (const [k, v] of Object.entries(r)) say(`${k.padEnd(20)} ${v}`);
    say();
    if (Number(r.tables_without_rls) > 0) {
      say('*** A public table has RLS OFF. Migration 002 s rule is: RLS on, no');
      say('    policies. Fix before anything reaches PostgREST. ***');
    }
    if (Number(r.ai_agent_runs) === 0) {
      say('ai_agent_runs = 0 — the AI gateway has still never actually run.');
      say('Any claim that the invoke path "works in production" is untested.');
    }
    if (Number(r.apps_on_legacy_key) > 0) {
      say(`${r.apps_on_legacy_key} consumer app(s) still on a pre-004 key (key_id IS NULL),`);
      say('served by the slow bcrypt-scan fallback. Rotate to move them across.');
    }
  } catch (e) {
    say(`QUERY FAILED: ${(e as Error).message}`);
    say('If this is ENETUNREACH, DATABASE_URL is the IPv6-only direct host');
    say('instead of the session pooler.');
  } finally {
    await pool.end();
  }
}
say();

// ---------------------------------------------------------------- migrations
say('=== MIGRATIONS (no ledger table — every file re-runs every time) ');
try {
  const files = execFileSync('git', ['ls-files', 'api/src/db/*.sql'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  files.forEach((f) => say(`  ${f}`));
  say(`  ${files.length} file(s). migrate.ts runs ALL of them, in filename order,`);
  say('  on every invocation. Each one must be idempotent.');
} catch {
  say('  UNKNOWN — git unavailable.');
}

console.log(out.join('\n'));
