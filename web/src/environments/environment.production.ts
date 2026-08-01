/**
 * Production build (what Netlify serves).
 *
 * apiBaseUrl is same-origin on purpose. Today nothing answers there — netlify.toml
 * returns a 503 for /api/*, so the masthead shows "API unreachable" and sign-in
 * says so plainly instead of pretending the password was wrong.
 *
 * When the API gets hosted, this becomes either a Netlify proxy redirect
 * (/api/* -> the API host, keeping it same-origin and sidestepping CORS entirely)
 * or a full URL here. Nothing else has to change.
 */
export const environment = {
  apiBaseUrl: '/api/v1',
  version: '0.3.0',
  buildStamp: '0801-0105',
};
