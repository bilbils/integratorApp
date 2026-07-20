import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  ingestToken: required('INGEST_TOKEN'),
  jwtSecret: required('JWT_SECRET'),
  port: Number(process.env.PORT ?? 3000),
};
