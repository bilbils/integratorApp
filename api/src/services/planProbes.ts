import { z } from 'zod';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import { pool } from '../db/pool.js';

/**
 * The probe layer: does the thing marked `chosen` in plan_options actually
 * exist and work, as OBSERVED by a machine, right now - separate from
 * `status`, which records what was DECIDED. See 013_plan_probes.sql for the
 * full argument; the short version is that this project has been bitten four
 * times in two days by checks that could not fail, and a human typing
 * "built" into a status column would be exactly that shape of check again.
 *
 * Five kinds, one honest default:
 *   - none        no check defined. Always 'unknown', never reads as passing.
 *   - http_status GET a URL, pass iff the status matches.
 *   - http_json   GET a URL, walk a dot path in the JSON body, pass iff it
 *                 equals a string. The /health -> build-stamp check.
 *   - pg_table    pass iff a table exists in `public`, in the API's own
 *                 database. The identifier is a bound parameter, never SQL.
 *   - manual      records that a HUMAN said so, not that anything was
 *                 observed - the detail is prefixed to say exactly that.
 *
 * An admin supplying a URL the server then fetches is a server-side request
 * forgery hole (on a cloud host, straight into the instance metadata
 * endpoint), so every fetching kind runs through `validateProbeUrl` first and
 * refuses anything but an explicit `ok: true`.
 */

export const PROBE_KINDS = ['none', 'http_status', 'http_json', 'pg_table', 'manual'] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

export const PROBE_STATES = ['unknown', 'passing', 'failing', 'error'] as const;
export type ProbeState = (typeof PROBE_STATES)[number];

export interface ProbeResult {
  state: ProbeState;
  detail: string;
}

// ---------------------------------------------------------------------------
// Per-kind config shapes, and the discriminated union the route validates
// a PUT body against.
// ---------------------------------------------------------------------------

const NoneProbeConfig = z.object({}).strict();
const HttpStatusProbeConfig = z.object({
  url: z.string().url().max(2000),
  expect_status: z.number().int().min(100).max(599),
});
const HttpJsonProbeConfig = z.object({
  url: z.string().url().max(2000),
  path: z.string().min(1).max(200),
  equals: z.string().max(2000),
});
// Same identifier rule the runner enforces again immediately before the
// catalogue query - see runPgTableProbe. Belt and braces, not either/or.
const TABLE_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const PgTableProbeConfig = z.object({
  table: z.string().regex(TABLE_IDENT_RE, 'table must match ^[a-z_][a-z0-9_]{0,62}$'),
});
const ManualProbeConfig = z.object({
  note: z.string().max(2000).default(''),
});

export const ProbeConfigInput = z.discriminatedUnion('probe_kind', [
  z.object({ probe_kind: z.literal('none'), probe_config: NoneProbeConfig.default({}) }),
  z.object({ probe_kind: z.literal('http_status'), probe_config: HttpStatusProbeConfig }),
  z.object({ probe_kind: z.literal('http_json'), probe_config: HttpJsonProbeConfig }),
  z.object({ probe_kind: z.literal('pg_table'), probe_config: PgTableProbeConfig }),
  z.object({ probe_kind: z.literal('manual'), probe_config: ManualProbeConfig }),
]);
export type ProbeConfigInput = z.infer<typeof ProbeConfigInput>;

// ---------------------------------------------------------------------------
// SSRF guard.
// ---------------------------------------------------------------------------
// An admin-authenticated caller supplying a URL the server then fetches is a
// server-side request forgery hole. On a cloud host that reaches the
// instance metadata endpoint (169.254.169.254) with the instance's own
// credentials. Exported standalone, not folded into the fetch helper, so it
// can be tested address-by-address without ever making a network call.

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// 0.0.0.0/8 also catches the bare unspecified address; 169.254.0.0/16 is the
// cloud metadata range this whole guard exists for.
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['0.0.0.0', 8],
];

/** Refuses loopback, private, link-local, unique-local and unspecified
 *  addresses in both families. This is the guard's actual decision. */
function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return BLOCKED_V4_RANGES.some(([base, bits]) => inCidr4(address, base, bits));
  }
  if (family === 6) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isBlockedAddress(mapped[1]);
    const firstWord = parseInt(a.split(':')[0] || '0', 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true; // fc00::/7 - unique local
    if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10 - link-local
    return false;
  }
  // Not a recognisable IP literal. Fail closed - never fail open on a family
  // this guard doesn't know how to reason about.
  return true;
}

export interface ProbeUrlCheck {
  ok: boolean;
  reason?: string;
}

export async function validateProbeUrl(raw: string): Promise<ProbeUrlCheck> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme must be https:, got '${parsed.protocol}'` };
  }
  // Node's URL.hostname keeps the brackets around an IPv6 literal
  // (`[::1]`), unlike the plain address dns.lookup and net.isIP expect -
  // strip them before either sees the string.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `hostname '${hostname}' is blocked` };
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    return { ok: false, reason: `could not resolve host: ${(err as Error).message}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: 'host resolved to no addresses' };
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return { ok: false, reason: `resolved address ${address} is private/loopback/link-local/reserved` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The fetch itself, once a URL has cleared the guard.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;

type FetchOutcome =
  | { kind: 'response'; status: number; bodyText: string }
  | { kind: 'redirected'; status: number }
  | { kind: 'network_error'; message: string };

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, MAX_BODY_BYTES).toString('utf8');
}

/**
 * `redirect: 'manual'` so a redirect is never followed - a public URL that
 * 302s to 169.254.169.254 must not reach a second hop this guard never saw.
 * Hard 5s timeout via AbortSignal.timeout; body capped at 64KB and never
 * handed back to the caller, only a short derived detail string is.
 */
async function fetchProbeUrl(url: string): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      return { kind: 'redirected', status: res.status };
    }
    const bodyText = await readCapped(res);
    return { kind: 'response', status: res.status, bodyText };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return {
      kind: 'network_error',
      message: timedOut ? `timed out after ${FETCH_TIMEOUT_MS}ms` : `could not reach host: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// http_json's comparison logic, split out from the fetch so it can be proven
// correct without a network call - the container this runs in has none.
// ---------------------------------------------------------------------------

function walkDotPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function matchJsonPath(parsed: unknown, path: string, equals: string): ProbeResult {
  const actual = walkDotPath(parsed, path);
  if (actual === undefined) {
    return { state: 'failing', detail: `path '${path}' not found in response` };
  }
  const actualStr = typeof actual === 'string' ? actual : JSON.stringify(actual);
  return {
    state: actualStr === equals ? 'passing' : 'failing',
    detail: `path '${path}' = ${actualStr.slice(0, 200)} (expected ${equals})`,
  };
}

// ---------------------------------------------------------------------------
// The five runners.
// ---------------------------------------------------------------------------

async function runHttpStatusProbe(url: string, expectStatus: number): Promise<ProbeResult> {
  const check = await validateProbeUrl(url);
  if (!check.ok) return { state: 'error', detail: `refused: ${check.reason}` };

  const outcome = await fetchProbeUrl(url);
  if (outcome.kind === 'network_error') {
    // "we could not tell" and "we looked and it is broken" are different
    // answers and must not be merged.
    return { state: 'error', detail: outcome.message };
  }
  if (outcome.kind === 'redirected') {
    return { state: 'failing', detail: `server redirected (HTTP ${outcome.status}) - redirects are not followed` };
  }
  return {
    state: outcome.status === expectStatus ? 'passing' : 'failing',
    detail: `HTTP ${outcome.status} (expected ${expectStatus})`,
  };
}

async function runHttpJsonProbe(url: string, path: string, equals: string): Promise<ProbeResult> {
  const check = await validateProbeUrl(url);
  if (!check.ok) return { state: 'error', detail: `refused: ${check.reason}` };

  const outcome = await fetchProbeUrl(url);
  if (outcome.kind === 'network_error') {
    return { state: 'error', detail: outcome.message };
  }
  if (outcome.kind === 'redirected') {
    return { state: 'failing', detail: `server redirected (HTTP ${outcome.status}) - redirects are not followed` };
  }
  if (outcome.status !== 200) {
    return { state: 'failing', detail: `HTTP ${outcome.status}, expected 200` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bodyText);
  } catch {
    return { state: 'error', detail: 'response body was not valid JSON' };
  }
  return matchJsonPath(parsed, path, equals);
}

async function runPgTableProbe(table: string): Promise<ProbeResult> {
  // The CHECK constraint and the zod schema both already shape this value,
  // but it is about to reach raw SQL, so it gets validated again right here,
  // immediately before the query - never trust that validation happened
  // earlier in the call chain. Bound as a parameter either way; this re-check
  // exists so a caller who somehow bypassed the schema still can't turn
  // `table` into anything but a catalogue lookup.
  if (!TABLE_IDENT_RE.test(table)) {
    return { state: 'error', detail: `refused: '${table}' is not a valid identifier` };
  }
  try {
    const { rows } = await pool.query<{ exists: boolean }>(
      `select exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = $1
       ) as exists`,
      [table],
    );
    const exists = rows[0]?.exists ?? false;
    return exists
      ? { state: 'passing', detail: `table 'public.${table}' exists` }
      : { state: 'failing', detail: `table 'public.${table}' does not exist` };
  } catch (err) {
    return { state: 'error', detail: `catalogue query failed: ${(err as Error).message}`.slice(0, 500) };
  }
}

export interface ProbeOptionRow {
  slug: string;
  probe_kind: ProbeKind;
  probe_config: Record<string, unknown>;
}

/**
 * Run one option's probe. Never throws on a bad/stale config - a config that
 * fails its own kind's schema (e.g. hand-edited in the database, bypassing
 * the PUT route's validation) comes back as `error`, same as any other thing
 * this function could not complete.
 */
export async function runProbe(option: ProbeOptionRow, actorEmail: string): Promise<ProbeResult> {
  try {
    switch (option.probe_kind) {
      case 'none':
        return { state: 'unknown', detail: 'no proof defined' };

      case 'manual': {
        const cfg = ManualProbeConfig.parse(option.probe_config);
        const note = cfg.note.trim();
        // The whole point of this kind: the detail records that a HUMAN said
        // so, never that anything was observed.
        return { state: 'passing', detail: `asserted by ${actorEmail} — ${note || '(no note given)'}` };
      }

      case 'pg_table': {
        const cfg = PgTableProbeConfig.parse(option.probe_config);
        return await runPgTableProbe(cfg.table);
      }

      case 'http_status': {
        const cfg = HttpStatusProbeConfig.parse(option.probe_config);
        return await runHttpStatusProbe(cfg.url, cfg.expect_status);
      }

      case 'http_json': {
        const cfg = HttpJsonProbeConfig.parse(option.probe_config);
        return await runHttpJsonProbe(cfg.url, cfg.path, cfg.equals);
      }

      default:
        return { state: 'error', detail: `unknown probe_kind '${option.probe_kind}'` };
    }
  } catch (err) {
    return { state: 'error', detail: `probe config invalid: ${(err as Error).message}`.slice(0, 500) };
  }
}

/** Writes the observed result and returns the full row, so a route handler
 *  has something to send back without a second query. Null when the slug
 *  doesn't exist, so the route can answer 404 rather than a silent no-op. */
export async function recordProbe(
  slug: string,
  result: ProbeResult,
  actorEmail: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `update plan_options
       set probe_state  = $2,
           probe_detail  = $3,
           probe_at      = now(),
           probe_by      = $4
     where slug = $1
     returning *`,
    [slug, result.state, result.detail.slice(0, 4000), actorEmail],
  );
  return rows[0] ?? null;
}

export async function getProbeOption(slug: string): Promise<ProbeOptionRow | null> {
  const { rows } = await pool.query<ProbeOptionRow>(
    `select slug, probe_kind, probe_config from plan_options where slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

/** Sets probe_kind/probe_config without running anything - PUT is a
 *  definition, not an execution. Null when the slug doesn't exist. */
export async function setProbeConfig(
  slug: string,
  probeKind: ProbeKind,
  probeConfig: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `update plan_options
       set probe_kind   = $2,
           probe_config = $3
     where slug = $1
     returning *`,
    [slug, probeKind, JSON.stringify(probeConfig)],
  );
  return rows[0] ?? null;
}

async function listProbeableOptions(limit: number): Promise<ProbeOptionRow[]> {
  const { rows } = await pool.query<ProbeOptionRow>(
    `select slug, probe_kind, probe_config from plan_options
       where probe_kind <> 'none'
       order by set_key, sort_order
       limit $1`,
    [limit],
  );
  return rows;
}

async function countProbeableOptions(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from plan_options where probe_kind <> 'none'`,
  );
  return Number(rows[0].n);
}

const RUN_ALL_MAX = 100;
const RUN_ALL_CONCURRENCY = 6;

export interface RunAllSummary {
  ran: number;
  passing: number;
  failing: number;
  error: number;
  truncated: boolean;
}

/**
 * Runs every option with a probe defined, at most 6 concurrently so this
 * can't hammer whatever hosts those URLs happen to point at. Capped at 100
 * total; `truncated` tells the caller some options were skipped rather than
 * silently dropping them.
 */
export async function runAllProbes(actorEmail: string): Promise<RunAllSummary> {
  const total = await countProbeableOptions();
  const options = await listProbeableOptions(RUN_ALL_MAX);
  const summary: RunAllSummary = { ran: 0, passing: 0, failing: 0, error: 0, truncated: total > RUN_ALL_MAX };

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < options.length) {
      const option = options[cursor++];
      const result = await runProbe(option, actorEmail);
      await recordProbe(option.slug, result, actorEmail);
      summary.ran += 1;
      if (result.state === 'passing') summary.passing += 1;
      else if (result.state === 'failing') summary.failing += 1;
      else if (result.state === 'error') summary.error += 1;
    }
  }

  const workerCount = Math.min(RUN_ALL_CONCURRENCY, options.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}
