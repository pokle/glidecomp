/**
 * The nightly purge behind the retention promises in the privacy policy
 * (/legal, "How Long We Keep Data").
 *
 * Better Auth writes three tables that hold personal data and never clears
 * them: an expired session keeps its IP address and user agent, an expired
 * sign-in code keeps the email address it was sent to, and a `rateLimit` row
 * keeps the IP address in its key. Each stops meaning anything at a known
 * moment, so each is deleted soon after it:
 *
 * - `session` — past `expiresAt` (60 days without use, auth.ts).
 * - `verification` — past `expiresAt` (a sign-in code lives 10 minutes).
 * - `rateLimit` — untouched for RATE_LIMIT_RETENTION_MS. The longest window
 *   any budget counts is one day (rate-limit.ts here, and auth-api's), so a
 *   row older than two days can no longer affect a verdict.
 *
 * The auth tables live in this worker's D1 database (the same binding as
 * everything else), and this worker already runs the nightly cron — hence
 * here rather than in auth-api.
 */

export const RATE_LIMIT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

export interface PurgeCounts {
  sessions: number;
  verifications: number;
  rateLimits: number;
}

export async function purgeExpiredAuthData(
  db: D1Database,
  now: Date = new Date()
): Promise<PurgeCounts> {
  // Better Auth stores these timestamps as ISO-8601 UTC text, so a string
  // comparison against the same shape orders them correctly.
  const nowIso = now.toISOString();
  const [sessions, verifications, rateLimits] = await db.batch([
    db.prepare(`DELETE FROM "session" WHERE "expiresAt" < ?`).bind(nowIso),
    db.prepare(`DELETE FROM "verification" WHERE "expiresAt" < ?`).bind(nowIso),
    db
      .prepare(`DELETE FROM "rateLimit" WHERE "lastRequest" < ?`)
      .bind(now.getTime() - RATE_LIMIT_RETENTION_MS),
  ]);
  return {
    sessions: sessions.meta.changes ?? 0,
    verifications: verifications.meta.changes ?? 0,
    rateLimits: rateLimits.meta.changes ?? 0,
  };
}
