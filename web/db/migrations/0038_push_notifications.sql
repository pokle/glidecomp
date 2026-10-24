-- ── Push notifications (mobile plan stage 9) ───────────────────────────────
--
-- The app's push tokens, and which competitions each account asked to hear
-- about. Opt-in, per competition: nothing is sent to anyone who has not
-- turned a competition's notifications on in the app. Never a replacement for
-- the emails — the track notice still goes out whatever is set here.
--
-- Both go with the account when it is deleted (ON DELETE CASCADE), like
-- every other per-account table.
--
-- Neither table is competition data (no organiser wrote it, and no score or
-- analysis reads it), so changes to them take no audit() call and no score
-- bump, like task_weather and pilot_ranking.

-- One row per device: an Expo push token is the device's address. A token
-- that moves to another account (a shared phone, a sign-out and sign-in)
-- moves with it, so a phone never notifies the account that left it.
CREATE TABLE IF NOT EXISTS push_token (
  "token"        TEXT PRIMARY KEY,
  "user_id"      TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "platform"     TEXT NOT NULL CHECK ("platform" IN ('ios', 'android')),
  "created_at"   TEXT NOT NULL,
  "last_seen_at" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_token_user ON push_token ("user_id");

-- An account following a competition. Deleted with the competition.
CREATE TABLE IF NOT EXISTS comp_notify (
  "user_id"    TEXT    NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "comp_id"    INTEGER NOT NULL REFERENCES comp ("comp_id") ON DELETE CASCADE,
  "created_at" TEXT    NOT NULL,
  PRIMARY KEY ("user_id", "comp_id")
);
CREATE INDEX IF NOT EXISTS comp_notify_comp ON comp_notify ("comp_id");
