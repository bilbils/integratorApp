import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const sql = await readFile(join(here, '001_init.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migration 001_init applied.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
