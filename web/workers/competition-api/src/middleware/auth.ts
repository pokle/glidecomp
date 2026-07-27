import { createMiddleware } from "hono/factory";
import type { Env, AuthUser } from "../env";
import { isCompAdmin } from "../super-admin";

const AUTH_ATTEMPTS = 3;
const AUTH_RETRY_DELAY_MS = 50;

/**
 * Resolve the caller via auth-api. Forward whichever inbound credential
 * the client sent: a Better Auth session cookie (browser), or an API key
 * via `x-api-key` / `Authorization: Bearer` (programmatic / direct API
 * clients). Better Auth's apiKey plugin with `enableSessionForAPIKeys`
 * resolves either to the same { user } shape, so callers don't need to
 * care which they used.
 *
 * Forwarding only inbound auth headers — never trusting an attacker-
 * controlled "I am user X" header — is what closes SEC-10.
 *
 * **"I couldn't tell" is not "anonymous" (issue #481).** This hop can fail
 * transiently — a 5xx out of auth-api, a dropped service-binding call, a body
 * that won't parse. Reporting that as `null` is indistinguishable from a real
 * signed-out visitor, and every caller acts on it: the comp GET drops
 * `is_admin` and the `admins` list, so an admin's page silently renders as a
 * visitor's, and a `test` comp 404s outright ("Competition not found"). None
 * of it self-heals, because nothing knows anything went wrong. So a
 * transient failure is retried here, and only a real answer from auth-api
 * decides who the caller is.
 *
 * A 4xx is a real answer and is NOT retried: `/api/auth/me` returns 429 for a
 * rate-limited API key, and retrying that would both lie about the limit and
 * push the caller further past it.
 */
async function resolveUser(
  env: Env,
  headers: Headers
): Promise<AuthUser | null> {
  const forward = new Headers();
  const cookie = headers.get("cookie");
  if (cookie) forward.set("cookie", cookie);
  const apiKey = headers.get("x-api-key");
  if (apiKey) forward.set("x-api-key", apiKey);

  if (![...forward.keys()].length) return null;

  let lastErr: unknown;
  for (let attempt = 0; attempt < AUTH_ATTEMPTS; attempt++) {
    try {
      const res = await env.AUTH_API.fetch(
        new Request("https://auth/api/auth/me", { headers: forward })
      );
      // 5xx: auth-api is up but couldn't answer. Retryable — falling through
      // to `null` here is what strands an admin on a visitor's page.
      if (res.status >= 500) {
        throw new Error(`auth-api /me responded ${res.status}`);
      }
      const data = (await res.json()) as { user?: AuthUser | null };
      return data.user ?? null;
    } catch (err) {
      lastErr = err;
      if (attempt < AUTH_ATTEMPTS - 1) {
        // Linear backoff (50ms, 100ms) — long enough for a blip, short
        // enough that a genuinely down auth-api doesn't stall the request.
        await new Promise((r) => setTimeout(r, AUTH_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Middleware that verifies authentication via service binding to auth-api.
 * Sets c.var.user to the authenticated user.
 * Returns 401 if not authenticated.
 */
export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: AuthUser };
}>(async (c, next) => {
  let user: AuthUser | null;
  try {
    user = await resolveUser(c.env, c.req.raw.headers);
  } catch (err) {
    // resolveUser only throws once its retries are exhausted, so this is
    // auth-api being unavailable rather than the caller being anonymous.
    // 503 says "try again", where 401 would tell a signed-in user to sign in.
    console.error("[competition-api] auth-api unreachable", err);
    return c.json({ error: "Authentication service unavailable" }, 503);
  }
  if (!user) {
    return c.json({ error: "Not authenticated" }, 401);
  }
  c.set("user", user);
  await next();
});

/**
 * Middleware that optionally authenticates. Sets c.var.user if authenticated,
 * null otherwise. Never returns 401.
 *
 * A public route stays readable when auth-api is down, so an exhausted
 * resolveUser degrades to anonymous here rather than failing the request —
 * but it is logged, because that degradation is exactly what makes an admin's
 * controls disappear without explanation (issue #481).
 */
export const optionalAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: AuthUser | null };
}>(async (c, next) => {
  let user: AuthUser | null = null;
  try {
    user = await resolveUser(c.env, c.req.raw.headers);
  } catch (err) {
    console.error("[competition-api] auth-api unreachable, serving anonymously", err);
  }
  c.set("user", user);
  await next();
});

/**
 * Middleware that checks the current user is an admin of the comp identified
 * by c.var.ids.comp_id. Must run after requireAuth and sqidsMiddleware.
 */
export const requireCompAdmin = createMiddleware<{
  Bindings: Env;
  Variables: {
    user: AuthUser;
    ids: { comp_id?: number };
  };
}>(async (c, next) => {
  const compId = c.var.ids.comp_id;
  if (compId === undefined) {
    return c.json({ error: "Missing comp_id" }, 400);
  }

  if (!(await isCompAdmin(c.env.DB, compId, c.var.user))) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
});
