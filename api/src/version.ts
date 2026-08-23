/**
 * The API's build marker.
 *
 * Bump BUILD_STAMP on every deploy. It is shown in the admin's masthead next to
 * the UI's own stamp, so "did my change actually land?" is answered by looking
 * at the screen instead of guessing. Kept as a literal rather than read from
 * package.json because tsc's rootDir is src/ - a constant is also easier to
 * grep for and harder to forget.
 *
 * This must stay in lockstep with web/src/environments/environment*.ts. A
 * mismatch is not cosmetic: the masthead turns amber and says so, which is the
 * signal that one half of the deploy (Render or Netlify) went out and the other
 * did not.
 *
 * Format: MMDD-HHMM (Eastern), matching the outputs bundle naming.
 */
export const VERSION = '0.3.0';
export const BUILD_STAMP = '0823-1502';
