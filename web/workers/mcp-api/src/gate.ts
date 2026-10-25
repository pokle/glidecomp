/**
 * Who an MCP request speaks for (docs/2026-10-24-mcp-oauth-plan.md §1, §3).
 *
 * The bearer token is an OAuth access token from auth-api's mcp() provider.
 * The gate asks auth-api's /me about it rather than checking its signature
 * here, because /me is the one place that also knows whether the organiser's
 * consent still stands and whether the grant is within its budget. A token
 * checked locally kept working after Disconnect in the phase 0 spike: the
 * tools then ran as nobody instead of the client being told to sign in again.
 *
 * Only an OAuth grant gets in. /me also answers for an API key sent as a
 * bearer value, and for a browser session; neither is a way into /mcp.
 */
import {
  bearerAuthChallengeResponse,
  OAuthError,
  OAuthErrorCode,
  verifyBearerToken,
  type AuthInfo,
} from "@modelcontextprotocol/server";

export interface GateEnv {
  AUTH_API: Fetcher;
}

/** What auth-api publishes about this resource (RFC 9728). */
export interface ResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

export const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

/** The scope every tool on this server needs. */
export const REQUIRED_SCOPES = ["comp:read"];

/** The organiser a request acts as, and the client they let in. */
export interface Caller {
  user: { id: string; name: string; email: string; username?: string | null };
  clientId: string;
  clientName: string | null;
  scopes: string[];
}

class RateLimited extends Error {
  constructor(readonly retryAfter: string) {
    super("rate limited");
  }
}

class AuthUnavailable extends Error {}

/**
 * The resource identifier comes from auth-api's own metadata, so
 * BETTER_AUTH_URL stays the one place that names this deployment's origin.
 * Per isolate: it only changes with a redeploy.
 */
let metadata: Promise<ResourceMetadata> | null = null;

export function resourceMetadata(env: GateEnv): Promise<ResourceMetadata> {
  metadata ??= env.AUTH_API.fetch(new Request(`https://auth${METADATA_PATH}`))
    .then(async (res) => {
      if (!res.ok) throw new Error(`protected-resource metadata: ${res.status}`);
      return (await res.json()) as ResourceMetadata;
    })
    .catch((err) => {
      metadata = null;
      throw err;
    });
  return metadata;
}

/** Tests only. */
export function resetResourceMetadata(): void {
  metadata = null;
}

/**
 * The token's `exp`, read from its payload. /me has just verified this same
 * JWT — signature, issuer, audience, expiry — so the claim can be taken as
 * read; the SDK insists on an expiry, and /me's answer doesn't carry one.
 */
function expiryOf(token: string): number | undefined {
  try {
    const payload = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const exp = (JSON.parse(atob(payload)) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The caller, or the Response that refuses them: 401 with the RFC 9728
 * challenge (so the client starts or restarts sign-in), 403 for a missing
 * scope, 429 for a grant over its budget, 503 when auth-api can't answer.
 */
export async function gate(
  request: Request,
  env: GateEnv
): Promise<{ caller: Caller; authInfo: AuthInfo; origin: string } | Response> {
  let meta: ResourceMetadata;
  try {
    meta = await resourceMetadata(env);
  } catch (err) {
    console.error("[mcp-api] auth-api metadata unavailable", err);
    return new Response("Authorisation server unavailable", { status: 503 });
  }
  const resource = new URL(meta.resource);
  const resourceMetadataUrl = `${resource.origin}${METADATA_PATH}`;
  let caller: Caller | null = null;

  try {
    const authInfo = await verifyBearerToken(request.headers.get("authorization"), {
      resourceMetadataUrl,
      requiredScopes: REQUIRED_SCOPES,
      verifier: {
        async verifyAccessToken(token: string): Promise<AuthInfo> {
          let res: Response;
          try {
            res = await env.AUTH_API.fetch(
              new Request("https://auth/api/auth/me", { headers: { authorization: `Bearer ${token}` } })
            );
          } catch (err) {
            throw new AuthUnavailable(String(err));
          }
          if (res.status === 429) throw new RateLimited(res.headers.get("retry-after") ?? "60");
          if (res.status >= 500) throw new AuthUnavailable(`auth-api /me responded ${res.status}`);
          const body = (await res.json()) as {
            user?: Caller["user"] | null;
            grant?: { kind?: string; client_id?: string; client_name?: string | null; scopes?: string[] } | null;
          };
          if (!body.user || body.grant?.kind !== "oauth" || !body.grant.client_id) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid, expired or disconnected access token");
          }
          caller = {
            user: body.user,
            clientId: body.grant.client_id,
            clientName: body.grant.client_name ?? null,
            scopes: body.grant.scopes ?? [],
          };
          return { token, clientId: caller.clientId, scopes: caller.scopes, resource, expiresAt: expiryOf(token) };
        },
      },
    });
    return { caller: caller!, authInfo, origin: resource.origin };
  } catch (err) {
    if (err instanceof RateLimited) {
      return Response.json(
        { error: "rate_limited", error_description: "Too many requests for this connection" },
        { status: 429, headers: { "Retry-After": err.retryAfter } }
      );
    }
    if (err instanceof AuthUnavailable) {
      console.error("[mcp-api] auth-api unreachable", err.message);
      return new Response("Authorisation server unavailable", { status: 503 });
    }
    return bearerAuthChallengeResponse(err, { resourceMetadataUrl, requiredScopes: REQUIRED_SCOPES });
  }
}
