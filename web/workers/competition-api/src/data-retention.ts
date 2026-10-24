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
 * And the MCP OAuth provider's tables (docs/2026-10-24-mcp-oauth-plan.md):
 *
 * - `oauthRefreshToken` — past `expiresAt`, or revoked (Disconnect revokes
 *   them) more than a day ago. Each names the user it was issued for.
 * - `oauthClient` — a client that registered itself (no `userId`) more than
 *   UNUSED_CLIENT_GRACE_MS ago and that nobody consented to, with no live
 *   refresh token. Registration is open by design, because MCP clients
 *   register themselves, so this is what keeps those rows from piling up.
 *
 * The auth tables live in this worker's D1 database (the same binding as
 * everything else), and this worker already runs the nightly cron — hence
 * here rather than in auth-api.
 */

export const RATE_LIMIT_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

/** How long a registered MCP client may wait for its first consent. */
export const UNUSED_CLIENT_GRACE_MS = 24 * 60 * 60 * 1000;

/** How long a revoked refresh token is kept, for tracing a Disconnect. */
export const REVOKED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PurgeCounts {
  sessions: number;
  verifications: number;
  rateLimits: number;
  refreshTokens: number;
  oauthClients: number;
}

export async function purgeExpiredAuthData(
  db: D1Database,
  now: Date = new Date()
): Promise<PurgeCounts> {
  // Better Auth stores these timestamps as ISO-8601 UTC text, so a string
  // comparison against the same shape orders them correctly.
  const nowIso = now.toISOString();
  const revokedBefore = new Date(now.getTime() - REVOKED_TOKEN_RETENTION_MS).toISOString();
  const registeredBefore = new Date(now.getTime() - UNUSED_CLIENT_GRACE_MS).toISOString();
  const deadRefreshTokens = `SELECT "id" FROM "oauthRefreshToken" WHERE "expiresAt" < ? OR "revoked" < ?`;
  const [sessions, verifications, rateLimits, , refreshTokens, oauthClients] = await db.batch([
    db.prepare(`DELETE FROM "session" WHERE "expiresAt" < ?`).bind(nowIso),
    db.prepare(`DELETE FROM "verification" WHERE "expiresAt" < ?`).bind(nowIso),
    db
      .prepare(`DELETE FROM "rateLimit" WHERE "lastRequest" < ?`)
      .bind(now.getTime() - RATE_LIMIT_RETENTION_MS),
    // An access token row can point at its refresh token (no ON DELETE in the
    // provider's schema), so those go first. JWT access tokens are not stored,
    // so this is normally a no-op.
    db
      .prepare(`DELETE FROM "oauthAccessToken" WHERE "refreshId" IN (${deadRefreshTokens})`)
      .bind(nowIso, revokedBefore),
    db.prepare(`DELETE FROM "oauthRefreshToken" WHERE "id" IN (${deadRefreshTokens})`).bind(nowIso, revokedBefore),
    db
      .prepare(
        `DELETE FROM "oauthClient"
          WHERE "userId" IS NULL
            AND "createdAt" < ?
            AND "clientId" NOT IN (SELECT "clientId" FROM "oauthConsent")
            AND "clientId" NOT IN (SELECT "clientId" FROM "oauthRefreshToken" WHERE "revoked" IS NULL)`
      )
      .bind(registeredBefore),
  ]);
  return {
    sessions: sessions.meta.changes ?? 0,
    verifications: verifications.meta.changes ?? 0,
    rateLimits: rateLimits.meta.changes ?? 0,
    refreshTokens: refreshTokens.meta.changes ?? 0,
    oauthClients: oauthClients.meta.changes ?? 0,
  };
}
