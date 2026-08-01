import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Applies every .sql file in this folder in filename order (001, 002, 003...).
 * Each migration is written to be idempotent, so re-running is safe and cheap.
 */
async function main(): Promise<void> {
  const files = (await readdir(here)).filter((f) => f.endsWith('.sql')).sort();

  if (files.length === 0) {
    console.log('No migrations found.');
    await pool.end();
    return;
  }

  for (const file of files) {
    const sql = await readFile(join(here, file), 'utf8');
    await pool.query(sql);
    console.log(`Migration ${file} applied.`);
  }

  console.log(`Done - ${files.length} migration(s) applied.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
