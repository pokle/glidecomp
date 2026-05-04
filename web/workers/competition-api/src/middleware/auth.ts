import { createMiddleware } from "hono/factory";
import type { Env, AuthUser } from "../env";

/**
 * Resolve the caller via auth-api. Forward whichever inbound credential
 * the client sent: a Better Auth session cookie (browser), or an API key
 * via `x-api-key` / `Authorization: Bearer` (mcp-api and direct API
 * clients). Better Auth's apiKey plugin with `enableSessionForAPIKeys`
 * resolves either to the same { user } shape, so callers don't need to
 * care which they used.
 *
 * Forwarding only inbound auth headers — never trusting an attacker-
 * controlled "I am user X" header — is what closes SEC-10.
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

  const res = await env.AUTH_API.fetch(
    new Request("https://auth/api/auth/me", { headers: forward })
  );
  const data = (await res.json()) as { user: AuthUser | null };
  return data.user;
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
  const user = await resolveUser(c.env, c.req.raw.headers);
  if (!user) {
    return c.json({ error: "Not authenticated" }, 401);
  }
  c.set("user", user);
  await next();
});

/**
 * Middleware that optionally authenticates. Sets c.var.user if authenticated,
 * null otherwise. Never returns 401.
 */
export const optionalAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: AuthUser | null };
}>(async (c, next) => {
  try {
    const user = await resolveUser(c.env, c.req.raw.headers);
    c.set("user", user);
  } catch {
    c.set("user", null);
  }
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

  const row = await c.env.DB.prepare(
    "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
  )
    .bind(compId, c.var.user.id)
    .first();

  if (!row) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
});
