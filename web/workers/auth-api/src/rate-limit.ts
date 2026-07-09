/**
 * API-key rate limit — single source of truth.
 *
 * The Better Auth `apiKey` plugin config in auth.ts enforces these values, and
 * the public API doc (docs/api.md) quotes them. e2e/api-doc.spec.ts asserts the
 * doc's stated limit against this constant, so the number in the doc can't
 * silently drift from what the worker actually enforces. Change it here and the
 * doc test tells you if the doc is now lying.
 */
export const API_KEY_RATE_LIMIT = {
  maxRequests: 60,
  timeWindowMs: 60_000,
} as const;
