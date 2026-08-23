export const environment = {
  // Base URL of the Integrator API. Change for other environments.
  apiBaseUrl: 'http://localhost:3000/api/v1',

  /**
   * Build marker shown in the masthead. BUMP BUILD_STAMP ON EVERY DEPLOY -
   * it is how you confirm a hard refresh actually picked up the new build
   * instead of quietly serving you a cached one.
   *
   * Format: MMDD-HHMM (Eastern), matching the outputs bundle naming.
   * The API carries its own copy in api/src/version.ts; the masthead shows
   * both and flags them when they disagree.
   */
  version: '0.3.0',
  buildStamp: '0823-1802',
};
