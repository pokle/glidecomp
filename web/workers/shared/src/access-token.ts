/**
 * Verifies an OAuth access token that auth-api's mcp() plugin issued for the
 * MCP endpoint (docs/2026-10-24-mcp-oauth-plan.md §3).
 *
 * SPIKE: phase 0. The token is a JWT signed with the same key set as the
 * session-cache cookie, so what keeps the two apart is the claims checked
 * here — the issuer, the audience (the MCP resource), expiry and the header
 * `typ` — and the session-cache `typ`/`aud` that verifySessionCookie insists
 * on. Each refuses the other's token.
 */
import { decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { jwksKeyFor } from "./session-cookie";

/** What a verified token says, in the shape the workers pass around. */
export interface AccessGrant {
  userId: string;
  clientId: string | null;
  scopes: string[];
  claims: JWTPayload;
}

/** RFC 9068's media type for a JWT access token. */
const ACCESS_TOKEN_TYP = "at+jwt";

export async function verifyAccessToken(
  token: string,
  opts: { issuer: string; audience: string; fetchJwks: () => Promise<Response> }
): Promise<AccessGrant | undefined> {
  try {
    const header = decodeProtectedHeader(token);
    if (typeof header.kid !== "string") return undefined;
    if (header.typ !== undefined && header.typ.toLowerCase() !== ACCESS_TOKEN_TYP) return undefined;
    const key = await jwksKeyFor(header.kid, opts.fetchJwks);
    if (!key) return undefined;
    const { payload } = await jwtVerify(token, key.key, {
      algorithms: [key.alg],
      issuer: opts.issuer,
      audience: opts.audience,
      requiredClaims: ["sub", "exp"],
    });
    if (typeof payload.sub !== "string") return undefined;
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    const clientId =
      typeof payload.azp === "string" ? payload.azp : typeof payload.client_id === "string" ? payload.client_id : null;
    return { userId: payload.sub, clientId, scopes: scope.split(" ").filter(Boolean), claims: payload };
  } catch {
    return undefined;
  }
}

/** The bearer token in an Authorization header, if it is shaped like a JWT. */
export function bearerJwt(authorization: string | null | undefined): string | undefined {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization?.trim() ?? "");
  return m?.[1];
}
