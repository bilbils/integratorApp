import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// Supabase (and any remote Postgres) requires SSL; local dev does not.
const isLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});
