// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, isLocalDev, type AuthEnv } from "./auth";

const app = new Hono<{ Bindings: AuthEnv }>();

// CORS for local dev (credentials needed for cookies)
app.use(
  "/api/auth/*",
  cors({
    origin: (origin) => origin ?? "",
    credentials: true,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// GET /api/auth/me — return current user or null
app.get("/api/auth/me", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) {
    return c.json({ user: null });
  }
  return c.json({ user: session.user });
});

// POST /api/auth/set-username — set username for authenticated user
app.post("/api/auth/set-username", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const body = await c.req.json<{ username: string }>();
  const username = body.username?.trim();

  // Validate username format
  if (!username || username.length < 3 || username.length > 20) {
    return c.json(
      { error: "Username must be 3-20 characters" },
      400
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(username) && username.length > 2) {
    return c.json(
      { error: "Username can only contain letters, numbers, and hyphens (no leading/trailing hyphens)" },
      400
    );
  }
  if (/^[a-zA-Z0-9]$/.test(username)) {
    // Single char already caught by length check, but just in case
    return c.json({ error: "Username must be 3-20 characters" }, 400);
  }

  // Check uniqueness
  const existing = await c.env.glidecomp_auth.prepare(
    'SELECT id FROM "user" WHERE username = ? AND id != ?'
  )
    .bind(username, session.user.id)
    .first();

  if (existing) {
    return c.json({ error: "Username is already taken" }, 409);
  }

  // Update user
  await c.env.glidecomp_auth.prepare(
    'UPDATE "user" SET username = ?, "updatedAt" = ? WHERE id = ?'
  )
    .bind(username, new Date().toISOString(), session.user.id)
    .run();

  return c.json({ username });
});

// POST /api/auth/delete-account — delete user and all associated data
app.post("/api/auth/delete-account", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  // Revoke Google OAuth grant so re-login shows consent screen
  const account = await c.env.glidecomp_auth.prepare(
    'SELECT "accessToken" FROM "account" WHERE "userId" = ? AND "providerId" = ?'
  )
    .bind(session.user.id, "google")
    .first<{ accessToken: string | null }>();

  if (account?.accessToken) {
    // Best-effort revocation — don't block deletion if it fails
    try {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(account.accessToken)}`,
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
    } catch {
      // Revocation failed (network error, expired token, etc.) — proceed with deletion
    }
  }

  // Delete user row — CASCADE rules auto-delete session and account rows
  await c.env.glidecomp_auth.prepare('DELETE FROM "user" WHERE id = ?')
    .bind(session.user.id)
    .run();

  return c.json({ success: true });
});

// POST /api/auth/dev-login — dev/test-only: create session without OAuth
app.post("/api/auth/dev-login", async (c) => {
  if (!isLocalDev(c.env)) {
    return c.notFound();
  }

  let name: string, email: string;
  try {
    ({ name, email } = await c.req.json<{ name: string; email: string }>());
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!name || !email) {
    return c.json({ error: "name and email are required" }, 400);
  }

  const auth = createAuth(c.env);
  const password = "dev";

  // Sign up (ignore error if user already exists)
  try {
    await auth.api.signUpEmail({
      body: { email, password, name },
    });
  } catch {
    // User already exists — that's fine
  }

  // Sign in via Better Auth to get a properly signed session cookie
  return auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
});

// Better Auth catch-all handler
app.all("/api/auth/*", async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

export default app;
