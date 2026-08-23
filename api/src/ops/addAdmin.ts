/**
 * Add or re-password one admin user.  `npm --prefix api run add-admin`
 *
 * WHY THIS EXISTS INSTEAD OF `npm run seed`. The seed script rotates the
 * consumer app's API key unconditionally on every run. That has already cost
 * this project a live key once - a re-seed invalidated the key that was in
 * Bill's hand. Adding a second admin must not be able to do that, so it is its
 * own script that touches exactly one table.
 *
 * Usage:
 *   ADMIN_EMAIL=josh@example.com ADMIN_PASSWORD='...' npm --prefix api run add-admin
 *
 * Reads from the environment rather than argv on purpose: a password in argv
 * lands in the shell history file and in `ps` output for every user on the box.
 * The environment is not perfect either, but it does not persist to disk.
 *
 * The password itself is never printed, never logged, and never echoed back -
 * not even redacted. A redaction that matches the label instead of the value
 * reads as proof it worked. What IS printed is the email, the row id, and the
 * hash LENGTH, which is enough to confirm the write landed and useless to
 * anyone reading over a shoulder.
 *
 * Deliberately does NOT import config.ts: that module throws on a missing
 * INGEST_TOKEN or JWT_SECRET, and this script must still be able to say
 * "DATABASE_URL is missing" rather than dying on an unrelated variable.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';

function die(msg: string): never {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

if (!DATABASE_URL) {
  die('DATABASE_URL is not set. It must be the Supavisor SESSION pooler string (port 5432).');
}
if (!email || !email.includes('@')) {
  die("ADMIN_EMAIL is missing or is not an email address.\n  e.g. ADMIN_EMAIL=josh@example.com ADMIN_PASSWORD='...' npm --prefix api run add-admin");
}
if (password.length < 12) {
  die('ADMIN_PASSWORD must be at least 12 characters. This account can read every table the admin API exposes.');
}

const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

async function main(): Promise<void> {
  const existing = await pool.query<{ id: string }>(
    'select id from admin_users where email = $1',
    [email],
  );
  const isUpdate = existing.rowCount === 1;

  const hash = await bcrypt.hash(password, 12);

  // Read the row back rather than trusting the statement. `returning` gives the
  // stored value, so what is printed below is what the database actually holds.
  const { rows } = await pool.query<{ id: string; email: string; hash_len: number; created_at: string }>(
    `insert into admin_users (email, password_hash)
     values ($1, $2)
     on conflict (email) do update set password_hash = excluded.password_hash
     returning id, email, length(password_hash) as hash_len, created_at::text`,
    [email, hash],
  );

  const row = rows[0];
  const total = await pool.query<{ n: string }>('select count(*) as n from admin_users');

  console.log('');
  console.log(`  ${isUpdate ? 'PASSWORD RESET' : 'ADMIN CREATED'}`);
  console.log(`  email        ${row.email}`);
  console.log(`  id           ${row.id}`);
  console.log(`  hash length  ${row.hash_len}   (the password itself is not printed, by design)`);
  console.log(`  created      ${row.created_at}`);
  console.log(`  admin_users  ${total.rows[0].n} row(s) total`);
  console.log('');
  console.log('  Send the password over something that is not email or chat.');
  console.log('');

  await pool.end();
}

main().catch(async (err) => {
  console.error('\n  Failed:', err instanceof Error ? err.message : err, '\n');
  await pool.end().catch(() => {});
  process.exit(1);
});
