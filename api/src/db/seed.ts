import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { pool } from './pool.js';

/**
 * Seeds one admin user and one consumer app, then grants the consumer read
 * access to the ai-capture connector.
 *
 * Env:
 *   SEED_ADMIN_EMAIL      (required) admin login email
 *   SEED_ADMIN_PASSWORD   (required) admin login password
 *   SEED_CONSUMER_NAME    (optional) consumer app name, default 'Bills-Master-Plan'
 *
 * The consumer API key is generated and printed ONCE (only its hash is stored).
 * Re-running rotates the key and re-prints it.
 */
async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const consumerName = process.env.SEED_CONSUMER_NAME ?? 'Bills-Master-Plan';

  if (!email || !password) {
    throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD before running seed.');
  }

  const adminHash = await bcrypt.hash(password, 10);
  await pool.query(
    `insert into admin_users (email, password_hash) values ($1, $2)
     on conflict (email) do update set password_hash = excluded.password_hash`,
    [email, adminHash],
  );
  console.log(`Admin user ready: ${email}`);

  const apiKey = randomBytes(24).toString('hex');
  const keyHash = await bcrypt.hash(apiKey, 10);
  const { rows } = await pool.query<{ id: string }>(
    `insert into consumer_apps (name, api_key_hash) values ($1, $2)
     on conflict (name) do update set api_key_hash = excluded.api_key_hash
     returning id`,
    [consumerName, keyHash],
  );
  const consumerId = rows[0].id;

  await pool.query(
    `insert into access_grants (consumer_app_id, connector_id, permission)
     select $1, c.id, 'read' from connectors c where c.key = 'ai-capture'
     on conflict (consumer_app_id, connector_id) do nothing`,
    [consumerId],
  );
  console.log(`Consumer app ready: ${consumerName}`);

  console.log('');
  console.log('  CONSUMER API KEY (save now - shown once):');
  console.log(`  ${apiKey}`);
  console.log('');

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
