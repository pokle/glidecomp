/**
 * MCP grants: an organiser's consent for one MCP client (Claude, ChatGPT, …)
 * to act as them, and the tokens that carry it
 * (docs/2026-10-24-mcp-oauth-plan.md §3).
 *
 * The OAuth provider (mcp() in auth.ts) issues the tokens. Everything GlideComp
 * decides about them lives here:
 *
 * - resolveAccessToken: what /me answers for an access token. The token is a
 *   JWT that cannot be recalled, so it is honoured only while the consent
 *   behind it stands — which is what makes Disconnect take effect on the next
 *   request rather than when the token expires.
 * - listConnectedAssistants / disconnectAssistant: Settings → Connected
 *   assistants. Disconnecting also revokes the client's refresh tokens; the
 *   provider's own delete-consent removes the consent row and nothing else.
 *
 * Registration is open (MCP clients register themselves); clients nobody
 * consented to are removed by competition-api's nightly retention purge
 * (data-retention.ts there), beside the other auth tables.
 */
import { chargeBudgetKey } from "@glidecomp/worker-kit/rate-limit";
import { verifyAccessToken } from "@glidecomp/worker-kit/access-token";
import { createAuth, mcpResource, type AuthEnv } from "./auth";
import { OAUTH_GRANT_BUDGET } from "./rate-limit";

/** What /me says about the grant behind an access token. */
export interface AccessGrant {
  kind: "oauth";
  client_id: string;
  client_name: string | null;
  scopes: string[];
}

export type AccessTokenAnswer =
  | { status: "ok"; user: Record<string, unknown>; grant: AccessGrant }
  | { status: "limited"; retryAfterSeconds: number }
  | { status: "none" };

/** The issuer the provider stamps on its tokens: the origin plus Better Auth's base path. */
export function mcpIssuer(env: Pick<AuthEnv, "BETTER_AUTH_URL">): string {
  return `${new URL(env.BETTER_AUTH_URL).origin}/api/auth`;
}

const GRANT_BUDGET_KEY_PREFIX = "oauth-grant:";

/**
 * Who an MCP access token speaks for, if anyone. "none" for a token that does
 * not verify, has no client, or whose consent is gone — /me answers those the
 * way it answers a bad API key, `{ user: null }`.
 */
export async function resolveAccessToken(
  env: AuthEnv,
  token: string,
  now: number = Date.now()
): Promise<AccessTokenAnswer> {
  const auth = createAuth(env);
  const issuer = mcpIssuer(env);
  const verified = await verifyAccessToken(token, {
    issuer,
    audience: mcpResource(env),
    fetchJwks: () => auth.handler(new Request(`${issuer}/jwks`)),
  });
  if (!verified?.clientId) return { status: "none" };

  const db = env.glidecomp_auth;
  const row = await db
    .prepare(
      `SELECT cl."name" AS client_name
         FROM "oauthConsent" c
         JOIN "oauthClient" cl ON cl."clientId" = c."clientId"
        WHERE c."userId" = ? AND c."clientId" = ? AND (cl."disabled" IS NULL OR cl."disabled" = 0)
        LIMIT 1`
    )
    .bind(verified.userId, verified.clientId)
    .first<{ client_name: string | null }>();
  if (!row) return { status: "none" };

  const budget = await chargeBudgetKey(
    db,
    `${GRANT_BUDGET_KEY_PREFIX}${verified.clientId}:${verified.userId}`,
    OAUTH_GRANT_BUDGET,
    now
  );
  if (!budget.allowed) return { status: "limited", retryAfterSeconds: budget.retryAfterSeconds };

  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserById(verified.userId);
  if (!user) return { status: "none" };
  return {
    status: "ok",
    user: user as unknown as Record<string, unknown>,
    grant: {
      kind: "oauth",
      client_id: verified.clientId,
      client_name: row.client_name,
      scopes: verified.scopes,
    },
  };
}

/** One row of Settings → Connected AI Assistants. */
export interface ConnectedAssistant {
  client_id: string;
  name: string | null;
  uri: string | null;
  scopes: string[];
  connected_at: string | null;
}

function parseScopes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return raw.split(" ").filter(Boolean);
  }
}

export async function listConnectedAssistants(
  db: D1Database,
  userId: string
): Promise<ConnectedAssistant[]> {
  const { results } = await db
    .prepare(
      `SELECT c."clientId" AS client_id, cl."name" AS name, cl."uri" AS uri,
              c."scopes" AS scopes, c."createdAt" AS connected_at
         FROM "oauthConsent" c
         JOIN "oauthClient" cl ON cl."clientId" = c."clientId"
        WHERE c."userId" = ?
        ORDER BY c."createdAt" DESC`
    )
    .bind(userId)
    .all<{ client_id: string; name: string | null; uri: string | null; scopes: string | null; connected_at: string | null }>();
  return results.map((r) => ({ ...r, scopes: parseScopes(r.scopes) }));
}

/**
 * Remove a user's consent for a client and everything that carries it: the
 * refresh tokens are marked revoked (the provider then refuses them), and any
 * stored access tokens go. A JWT access token already in the client's hands
 * stops working at once too, because /me checks the consent.
 *
 * @returns whether there was anything to disconnect.
 */
export async function disconnectAssistant(
  db: D1Database,
  userId: string,
  clientId: string,
  now: Date = new Date()
): Promise<boolean> {
  const [consents] = await db.batch([
    db.prepare(`DELETE FROM "oauthConsent" WHERE "userId" = ? AND "clientId" = ?`).bind(userId, clientId),
    db
      .prepare(
        `UPDATE "oauthRefreshToken" SET "revoked" = ? WHERE "userId" = ? AND "clientId" = ? AND "revoked" IS NULL`
      )
      .bind(now.toISOString(), userId, clientId),
    db.prepare(`DELETE FROM "oauthAccessToken" WHERE "userId" = ? AND "clientId" = ?`).bind(userId, clientId),
  ]);
  return (consents?.meta.changes ?? 0) > 0;
}
