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
  /**
   * For a write: the JSON body fields a token may send. The route itself may
   * take more — a task PATCH also stops the task, closes it to submissions and
   * carries the weather notes — but the organiser consented to "create tasks
   * and change their routes", and a token is a bearer credential that can call
   * this API directly, not only through mcp-api's tools. So the fence, not the
   * tool, is what keeps a write inside the scope's words.
   */
  fields?: readonly string[];
}

/** What `task:write` may change on a task: its name, date, classes and route. */
const TASK_FIELDS = ["name", "task_date", "pilot_classes", "xctsk"] as const;

/** A path segment: an id or a slug, never a slash. */
const SEG = "[^/]+";

/**
 * The fixed words competition-api serves directly under /api/comp/. A comp id
 * is a short run of lowercase letters, so `pilot` or `search` would pass for
 * one, and `/api/comp/:comp_id` would quietly admit the account's own pilot
 * profile. Every such word is excluded from COMP; `search` is then let in by a
 * route of its own. web/scripts/mcp-fence-routes.test.ts fails if a route adds
 * a word that isn't listed here.
 */
export const STATIC_COMP_SEGMENTS = ["lookup", "open-now", "pilot", "sample-3dvis", "search"] as const;

/** A comp id segment: any segment except the fixed words above. */
const COMP = `(?!(?:${STATIC_COMP_SEGMENTS.join("|")})(?:/|$))${SEG}`;

/**
 * Every route an MCP access token may reach, and the scope it needs. Grow it
 * deliberately, beside the tool that calls the route.
 */
export const MCP_ROUTES: readonly FencedRoute[] = [
  { method: "GET", path: /^\/api\/comp$/, scope: "comp:read" },
  { method: "GET", path: /^\/api\/comp\/search$/, scope: "comp:read" },
  { method: "GET", path: new RegExp(`^/api/comp/${COMP}$`), scope: "comp:read" },
  { method: "GET", path: new RegExp(`^/api/comp/${COMP}/waypoints$`), scope: "comp:read" },
  { method: "GET", path: new RegExp(`^/api/comp/${COMP}/task/${SEG}$`), scope: "comp:read" },
  { method: "POST", path: new RegExp(`^/api/comp/${COMP}/task$`), scope: "task:write", fields: TASK_FIELDS },
  { method: "PATCH", path: new RegExp(`^/api/comp/${COMP}/task/${SEG}$`), scope: "task:write", fields: TASK_FIELDS },
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

/**
 * The body fields a write sends that the route's grant doesn't cover, or null
 * when it sends none. A body that isn't a JSON object is left to the route's
 * validator, which refuses it in its own words.
 */
export function fieldsOutsideGrant(route: FencedRoute, body: unknown): string[] | null {
  if (!route.fields || body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const extra = Object.keys(body).filter((k) => !route.fields!.includes(k));
  return extra.length > 0 ? extra : null;
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
  const route = fencedRoute(c.req.method, c.req.path)!;
  if (verdict === "scope") {
    c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${route.scope}"`);
    return c.json({ error: "The assistant was not given permission for this", code: "INSUFFICIENT_SCOPE" }, 403);
  }
  if (route.fields) {
    // Hono caches the parsed body on c.req, so the route's validator reads
    // this same parse rather than a drained stream.
    const extra = fieldsOutsideGrant(route, await c.req.json().catch(() => null));
    if (extra) {
      return c.json(
        {
          error: `Connected assistants can't change ${extra.join(", ")}`,
          code: "NOT_AVAILABLE_TO_ASSISTANTS",
        },
        403
      );
    }
  }
  await next();
});
