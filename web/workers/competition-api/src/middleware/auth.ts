import { createMiddleware } from "hono/factory";
import type { Env, AuthUser } from "../env";

/**
 * Middleware that verifies authentication via service binding to auth-api.
 * Sets c.var.user to the authenticated user.
 * Returns 401 if not authenticated.
 */
export const requireAuth = createMiddleware<{
  Bindings: Env;
  Variables: { user: AuthUser };
}>(async (c, next) => {
  const res = await c.env.AUTH_API.fetch(
    new Request("https://auth/api/auth/me", {
      headers: { cookie: c.req.header("cookie") || "" },
    })
  );
  const { user } = (await res.json()) as { user: AuthUser | null };
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
    const res = await c.env.AUTH_API.fetch(
      new Request("https://auth/api/auth/me", {
        headers: { cookie: c.req.header("cookie") || "" },
      })
    );
    const { user } = (await res.json()) as { user: AuthUser | null };
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
