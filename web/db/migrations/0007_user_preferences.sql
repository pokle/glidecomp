-- Per-user app preferences and custom theme. Replaces the
-- `glidecomp:preferences` and `glidecomp:theme` localStorage keys for
-- authenticated users so settings sync across devices.
--
-- One row per user. Both blobs are opaque JSON owned by the client; the
-- server only enforces size limits and treats them as strings.
--
-- theme_json is nullable so "reset to default" is a clean NULL rather than
-- a sentinel value. CASCADE on user delete piggybacks on the existing
-- account-deletion flow — no extra cleanup code needed.

CREATE TABLE "user_preferences" (
  "user_id" TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "prefs_json" TEXT NOT NULL DEFAULT '{}',
  "theme_json" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
);
