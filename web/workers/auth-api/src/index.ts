// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { APIError } from "better-auth/api";
import { createAuth, isLocalDev, type AuthEnv } from "./auth";
import { mountPreferencesRoutes } from "./routes/preferences";

const app = new Hono<{ Bindings: AuthEnv }>();

// CORS — credentials:true means we MUST NOT reflect arbitrary origins, or any
// site the user visits can read their session. Allowlist is prod + Pages
// preview deploys + localhost (for bun run dev against a live backend).
const PAGES_PREVIEW = /^https:\/\/[a-z0-9-]+\.glidecomp\.pages\.dev$/;
function isAllowedOrigin(origin: string): boolean {
  if (origin === "https://glidecomp.com") return true;
  if (PAGES_PREVIEW.test(origin)) return true;
  try {
    if (new URL(origin).hostname === "localhost") return true;
  } catch {
    /* malformed Origin — reject */
  }
  return false;
}

app.use(
  "/api/auth/*",
  cors({
    origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : ""),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Cap request-body size at the HTTP layer so oversize bodies are rejected
// while streaming, before any handler buffers them (the preferences route's
// own 64 KiB check runs only after c.req.text() has buffered the whole
// body). Better Auth payloads (sign-in, set-username, API-key ops) and the
// preferences blob are all far below this cap. (Not exported: workerd
// requires every named export of the entry module to be a handler.)
const MAX_BODY_BYTES = 128 * 1024;
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  })
);

// Every 429 leaving this worker must carry Retry-After so API clients can
// back off deterministically instead of blind-retrying (SEC-08). The apiKey
// plugin's window is 60s, so that's the conservative fallback when a handler
// didn't set a more precise value.
app.use("/api/auth/*", async (c, next) => {
  await next();
  if (c.res.status === 429 && !c.res.headers.has("Retry-After")) {
    const res = new Response(c.res.body, c.res);
    res.headers.set("Retry-After", "60");
    c.res = res;
  }
});

// Surface unhandled exceptions as a JSON body instead of Hono's bare
// "Internal Server Error" — mirrors competition-api so any 500 in CI
// traces or wrangler tail points at the real cause. Stack is logged
// server-side; only the message goes to the client.
app.onError((err, c) => {
  console.error("[auth-api] unhandled error", err);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
});

// GET /api/auth/me — return current user or null
app.get("/api/auth/me", async (c) => {
  const auth = createAuth(c.env);
  let session;
  try {
    session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
  } catch (err) {
    // The apiKey plugin's enableSessionForAPIKeys hook throws (rather than
    // resolving a null session) when an x-api-key credential is rate-limited,
    // invalid, expired, or revoked.
    if (err instanceof APIError) {
      if (err.statusCode === 429) {
        // The plugin reports tryAgainIn in milliseconds; the Retry-After
        // middleware above fills in the 60s window default if this is absent.
        const tryAgainIn = (
          err.body as { details?: { tryAgainIn?: number } } | undefined
        )?.details?.tryAgainIn;
        if (typeof tryAgainIn === "number" && tryAgainIn > 0) {
          c.header("Retry-After", String(Math.ceil(tryAgainIn / 1000)));
        }
        return c.json({ user: null, error: "Rate limit exceeded" }, 429);
      }
      // A bad API key resolves to "no session", mirroring a garbage cookie.
      return c.json({ user: null });
    }
    throw err;
  }
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

  // Delete every R2 object under this user's prefix BEFORE removing the user
  // row. D1 CASCADE wipes the metadata in user_track / user_task /
  // user_annotation, but R2 lives in a separate system and would otherwise
  // be orphaned.
  const prefix = `u/${session.user.id}/`;
  let cursor: string | undefined;
  do {
    const listed = await c.env.R2.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await c.env.R2.delete(listed.objects.map((o) => o.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Three columns reference "user" WITHOUT ON DELETE CASCADE, so any of them
  // pointing at this user would make the DELETE below fail with a FOREIGN KEY
  // constraint error. These are historical/attribution records that must
  // outlive the account (each keeps a denormalized *_name fallback), so we
  // de-link them rather than delete them. Everything else cascades: session,
  // account, apikey, pilot, comp_admin, user_preferences, user_track,
  // user_task, user_annotation. Run it all as one batch (a single implicit
  // transaction) so the user row and its de-links commit together.
  const userId = session.user.id;
  await c.env.glidecomp_auth.batch([
    c.env.glidecomp_auth
      .prepare("UPDATE task_track SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id = ?")
      .bind(userId),
    c.env.glidecomp_auth
      .prepare("UPDATE audit_log SET actor_user_id = NULL WHERE actor_user_id = ?")
      .bind(userId),
    c.env.glidecomp_auth
      .prepare("UPDATE task_pilot_status SET set_by_user_id = NULL WHERE set_by_user_id = ?")
      .bind(userId),
    c.env.glidecomp_auth.prepare('DELETE FROM "user" WHERE id = ?').bind(userId),
  ]);

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

// API key create/list/delete are handled by the @better-auth/api-key plugin
// via the catch-all handler below. Programmatic clients verify API keys by
// calling GET /api/auth/me with the x-api-key header — enableSessionForAPIKeys
// makes this return the user associated with the key.

// Per-user preferences storage (registered before the better-auth catch-all
// so /api/auth/preferences resolves here, not to better-auth's handler).
mountPreferencesRoutes(app);

// Better Auth catch-all handler
app.all("/api/auth/*", async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

export default app;
