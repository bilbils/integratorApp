import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';
import { config } from '../config.js';

export interface ConsumerIdentity { id: string; name: string; }
export interface AdminIdentity { sub: string; email: string; }

/** Capture auth for v1: a single shared ingest token (env). Per-source keys come later. */
export function checkIngestToken(token: string | undefined): boolean {
  return !!token && token === config.ingestToken;
}

/**
 * Consumer keys look like `int_<key_id>_<secret>`.
 *
 * key_id is public (it's an identifier, not a credential) and is what makes the
 * lookup a single indexed row read. Only the secret half is bcrypt-hashed and
 * stored. See migration 004 for why.
 */
const KEYED = /^int_([0-9a-f]{12})_([0-9a-f]{32})$/;

interface ConsumerRow { id: string; name: string; api_key_hash: string; }

/** Fire-and-forget: "last seen" is for the admin screen, never on the hot path. */
function touch(id: string): void {
  pool
    .query(`update consumer_apps set last_used_at = now() where id = $1`, [id])
    .catch((err) => console.error('last_used_at update failed:', err));
}

/**
 * Consumer read auth.
 *
 * Keyed path: one indexed lookup + one bcrypt compare.
 * Legacy path: keys minted before migration 004 have no key_id, so they still
 * fall back to the old scan-and-compare. Rotating a key moves it to the fast
 * path; the fallback can be deleted once no unkeyed rows remain.
 */
export async function verifyConsumerKey(key: string | undefined): Promise<ConsumerIdentity | null> {
  if (!key) return null;

  const match = KEYED.exec(key);
  if (match) {
    const [, keyId, secret] = match;
    const { rows } = await pool.query<ConsumerRow>(
      `select id, name, api_key_hash from consumer_apps where key_id = $1 and active = true`,
      [keyId],
    );
    const app = rows[0];
    if (!app) return null;
    if (!(await bcrypt.compare(secret, app.api_key_hash))) return null;
    touch(app.id);
    return { id: app.id, name: app.name };
  }

  const { rows } = await pool.query<ConsumerRow>(
    `select id, name, api_key_hash from consumer_apps where active = true and key_id is null`,
  );
  for (const r of rows) {
    if (await bcrypt.compare(key, r.api_key_hash)) {
      touch(r.id);
      return { id: r.id, name: r.name };
    }
  }
  return null;
}

/** Admin UI login. App-level email/password + JWT (NOT Supabase Auth) - portable to Entra later. */
export async function adminLogin(email: string, password: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string; password_hash: string }>(
    `select id, password_hash from admin_users where email = $1`,
    [email],
  );
  const user = rows[0];
  if (!user) return null;
  if (!(await bcrypt.compare(password, user.password_hash))) return null;
  return jwt.sign({ sub: user.id, email }, config.jwtSecret, { expiresIn: '12h' });
}

export function verifyAdminJwt(token: string | undefined): AdminIdentity | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (typeof payload === 'string') return null;
    return { sub: String(payload.sub), email: String((payload as { email?: unknown }).email ?? '') };
  } catch {
    return null;
  }
}
