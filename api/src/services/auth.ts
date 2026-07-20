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
 * Consumer read auth. v1 scans active consumer_apps and bcrypt-compares.
 * Fine for a handful of consumers; swap to a keyed lookup if the list grows.
 */
export async function verifyConsumerKey(key: string | undefined): Promise<ConsumerIdentity | null> {
  if (!key) return null;
  const { rows } = await pool.query<{ id: string; name: string; api_key_hash: string }>(
    `select id, name, api_key_hash from consumer_apps where active = true`,
  );
  for (const r of rows) {
    if (await bcrypt.compare(key, r.api_key_hash)) return { id: r.id, name: r.name };
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
