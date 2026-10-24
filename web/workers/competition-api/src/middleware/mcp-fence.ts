/**
 * The fence around MCP access tokens (docs/2026-10-24-mcp-oauth-plan.md §4).
 *
 * An organiser's assistant reaches competition-api with an OAuth access token
 * that auth-api's /me resolves like an API key — to the organiser. Without a
 * fence, that token could do anything the organiser can over the whole REST
 * API, which is far more than they consented to. So a request carrying one
 * reaches only the routes listed here, and only with the scope each needs.
 *
 * An allowlist, for the same reason auth-api's SEC-55 endpoint list is one: a
 * route added next year must not become reachable by every connected
 * assistant because nobody thought about it. Being an admin of the comp is
 * still checked by the route itself (requireCompAdmin); a scope never grants
 * more than the account has.
 *
 * A bearer token /me won't answer for — expired, signature wrong, consent
 * withdrawn — is refused outright rather than served as anonymous: a client
 * that holds a dead credential should be told so, and sent back to sign in,
 * not handed the signed-out view as if nothing were wrong.
 */
import { createMiddleware } from "hono/factory";
import { bearerJwt } from "@glidecomp/worker-kit/access-token";
import type { Env } from "../env";
import { resolveIdentity, type McpGrant } from "./auth";

interface FencedRoute {
  method: "GET" | "POST" | "PATCH";
  path: RegExp;
  scope: string;
}

/** A path segment: an id or a slug, never a slash. */
const SEG = "[^/]+";

/**
 * Every route an MCP access token may reach, and the scope it needs. Grow it
 * deliberately, beside the tool that calls the route.
 */
export const MCP_ROUTES: readonly FencedRoute[] = [
  { method: "GET", path: /^\/api\/comp$/, scope: "comp:read" },
  { method: "GET", path: /^\/api\/comp\/search$/, scope: "comp:read" },
  { method: "GET", path: new RegExp(`^/api/comp/${SEG}$`), scope: "comp:read" },
  { method: "GET", path: new RegExp(`^/api/comp/${SEG}/waypoints$`), scope: "comp:read" },
  { method: "GET", path: new RegExp(`^/api/comp/${SEG}/task/${SEG}$`), scope: "comp:read" },
];

/** The route a token may use for this request, if any. */
export function fencedRoute(method: string, pathname: string): FencedRoute | undefined {
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return MCP_ROUTES.find((r) => r.method === verb && r.path.test(pathname));
}

/** Whether a grant may make this request. */
export function grantAllows(grant: McpGrant, method: string, pathname: string): "ok" | "route" | "scope" {
  const route = fencedRoute(method, pathname);
  if (!route) return "route";
  return grant.scopes.includes(route.scope) ? "ok" : "scope";
}

export const mcpFence = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (c.req.method === "OPTIONS" || !bearerJwt(c.req.header("authorization"))) return next();

  let identity;
  try {
    identity = await resolveIdentity(c.env, c.req.raw.headers);
  } catch (err) {
    console.error("[competition-api] auth-api unreachable (MCP token)", err);
    return c.json({ error: "Authentication service unavailable" }, 503);
  }

  if (identity.retryAfterSeconds !== undefined) {
    c.header("Retry-After", String(identity.retryAfterSeconds));
    return c.json({ error: "Rate limit exceeded" }, 429);
  }
  // A JWT-shaped bearer value is only ever an MCP access token; one /me
  // doesn't vouch for is dead.
  if (!identity.user || !identity.grant) {
    c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
    return c.json({ error: "Invalid or revoked access token", code: "INVALID_TOKEN" }, 401);
  }

  const verdict = grantAllows(identity.grant, c.req.method, c.req.path);
  if (verdict === "route") {
    return c.json(
      { error: "This route is not available to connected assistants", code: "NOT_AVAILABLE_TO_ASSISTANTS" },
      403
    );
  }
  if (verdict === "scope") {
    c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${fencedRoute(c.req.method, c.req.path)!.scope}"`);
    return c.json({ error: "The assistant was not given permission for this", code: "INSUFFICIENT_SCOPE" }, 403);
  }
  await next();
});
