/**
 * Production build (what Netlify serves).
 *
 * apiBaseUrl is same-origin on purpose, and STAYS same-origin now that the API
 * is hosted. netlify.toml proxies /api/* and /health through to the Render
 * service (status = 200, so it is a proxy rather than a redirect), which means
 * the browser only ever talks to this site's hostname.
 *
 * The payoff: no CORS, no preflight, no Authorization-header edge cases, and
 * the API's address is not baked into a compiled Angular bundle. When the API
 * moves — Render today, possibly Azure App Service if the CMMC path turns real
 * — it is two lines in netlify.toml and this file does not change at all.
 *
 * Do NOT "fix" this by putting a full https:// URL here. That would reintroduce
 * CORS for no benefit and couple the frontend build to the API's hostname.
 */
export const environment = {
  apiBaseUrl: '/api/v1',
  version: '0.3.0',
  buildStamp: '0823-1809',
};
