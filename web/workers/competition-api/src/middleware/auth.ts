import { createMiddleware } from "hono/factory";
import type { Env, AuthUser } from "../env";

/**
 * Internal trusted header set by the MCP worker via service binding.
 * Service bindings are internal-only (not reachable from the internet),
 * so trusting this header is safe.
 */
const INTERNAL_USER_HEADER = "X-Glidecomp-Internal-User";

/**
 * Try to resolve the user from the internal header (set by mcp-api
 * via service binding) or from the session cookie (set by the browser).
 */
async function resolveUser(
  env: Env,
  headers: Headers
): Promise<AuthUser | null> {
  // Trust internal header from service bindings (mcp-api worker)
  const internalUser = headers.get(INTERNAL_USER_HEADER);
  if (internalUser) {
    try {
      return JSON.parse(internalUser) as AuthUser;
    } catch {
      return null;
    }
  }

  // Fall back to cookie-based session via auth-api
  const res = await env.AUTH_API.fetch(
    new Request("https://auth/api/auth/me", {
      headers: { cookie: headers.get("cookie") || "" },
    })
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
