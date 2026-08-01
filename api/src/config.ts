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

  /**
   * The AI gateway's engine. Deliberately NOT required: the API boots and
   * every other route works without it, and only agent invocation returns
   * "gateway not configured". Nobody should have to hold a model-provider key
   * to run the admin locally.
   */
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? '',
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',

  /** Sent to OpenRouter for attribution on their dashboard. Optional. */
  appUrl: process.env.APP_URL ?? 'https://github.com/bilbils/integratorApp',
  appTitle: process.env.APP_TITLE ?? 'Staffility Integrator',

  /** Hard ceiling on one model call, so a hung provider can't hold a request open. */
  gatewayTimeoutMs: Number(process.env.GATEWAY_TIMEOUT_MS ?? 60_000),
};
