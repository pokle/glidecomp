// Per-user preferences storage. Replaces the `glidecomp:preferences` and
// `glidecomp:theme` localStorage keys for authenticated users so settings
// sync across devices.
//
// Both blobs are opaque JSON owned by the client; the server only enforces
// size limits and stores them verbatim.

import type { Hono } from "hono";
import { createAuth, type AuthEnv } from "../auth";

// Cap the entire request body. Theme blobs are the larger of the two
// (~5-10KB with all fonts/colors); 64KB leaves generous headroom while
// preventing obvious abuse.
const MAX_BODY_BYTES = 64 * 1024;

type PreferencesRow = {
  prefs_json: string;
  theme_json: string | null;
  updated_at: string;
};

async function getSessionUser(
  env: AuthEnv,
  headers: Headers
): Promise<{ id: string } | null> {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers });
  return session?.user ?? null;
}

function parseStoredJson(text: string | null | undefined): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Stored value is corrupt — surface as null rather than 500ing. The
    // client treats null/empty as "no override" and falls back to defaults.
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mountPreferencesRoutes(app: Hono<{ Bindings: AuthEnv }>) {
  app.get("/api/auth/preferences", async (c) => {
    const user = await getSessionUser(c.env, c.req.raw.headers);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const row = await c.env.glidecomp_auth
      .prepare(
        `SELECT prefs_json, theme_json, updated_at
           FROM user_preferences WHERE user_id = ?`
      )
      .bind(user.id)
      .first<PreferencesRow>();

    if (!row) {
      return c.json({ prefs: {}, theme: null, updated_at: null });
    }

    return c.json({
      prefs: parseStoredJson(row.prefs_json) ?? {},
      theme: parseStoredJson(row.theme_json),
      updated_at: row.updated_at,
    });
  });

  app.put("/api/auth/preferences", async (c) => {
    const user = await getSessionUser(c.env, c.req.raw.headers);
    if (!user) return c.json({ error: "Not authenticated" }, 401);

    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) {
      return c.json({ error: "Request body too large" }, 413);
    }

    let body: unknown;
    try {
      body = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!isPlainObject(body)) {
      return c.json({ error: "Body must be a JSON object" }, 400);
    }

    const hasPrefs = "prefs" in body;
    const hasTheme = "theme" in body;
    if (!hasPrefs && !hasTheme) {
      return c.json(
        { error: "Body must include 'prefs' and/or 'theme'" },
        400
      );
    }

    if (hasPrefs && !isPlainObject(body.prefs)) {
      return c.json({ error: "'prefs' must be a JSON object" }, 400);
    }
    if (hasTheme && body.theme !== null && !isPlainObject(body.theme)) {
      return c.json({ error: "'theme' must be a JSON object or null" }, 400);
    }

    // Partial update done atomically: a single INSERT … ON CONFLICT statement
    // with CASE guards. CASE branches off `?` (1 = field present, 0 = absent)
    // so absent fields preserve the existing column value. Two concurrent PUTs
    // from different devices can no longer lose each other's updates.
    //
    // For the INSERT (no conflict) path we still need values for prefs_json /
    // theme_json — fall back to the column defaults when the field is absent.
    const prefsValue = hasPrefs ? JSON.stringify(body.prefs) : "{}";
    const themeValue = hasTheme
      ? body.theme === null
        ? null
        : JSON.stringify(body.theme)
      : null;
    const now = new Date().toISOString();

    await c.env.glidecomp_auth
      .prepare(
        `INSERT INTO user_preferences (user_id, prefs_json, theme_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           prefs_json = CASE WHEN ? = 1 THEN excluded.prefs_json ELSE prefs_json END,
           theme_json = CASE WHEN ? = 1 THEN excluded.theme_json ELSE theme_json END,
           updated_at = excluded.updated_at`
      )
      .bind(
        user.id,
        prefsValue,
        themeValue,
        now,
        hasPrefs ? 1 : 0,
        hasTheme ? 1 : 0
      )
      .run();

    return c.json({ updated_at: now });
  });
}
