/**
 * The API's build marker.
 *
 * Bump BUILD_STAMP on every deploy. It is shown in the admin's masthead next to
 * the UI's own stamp, so "did my change actually land?" is answered by looking
 * at the screen instead of guessing. Kept as a literal rather than read from
 * package.json because tsc's rootDir is src/ - a constant is also easier to
 * grep for and harder to forget.
 *
 * Format: MMDD-HHMM (Eastern), matching the outputs bundle naming.
 */
export const VERSION = '0.3.0';
export const BUILD_STAMP = '0801-0035';
