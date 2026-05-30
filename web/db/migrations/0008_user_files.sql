-- User-owned files (tracks, tasks, annotations).
--
-- Replaces the browser-IndexedDB storage in web/frontend/src/analysis/storage.ts.
-- Tracks live in R2 under u/{userId}/track/{sha256}.igc.gz; their metadata is
-- here. Tasks are small JSON blobs and live entirely in D1. Annotations are
-- per-(user, track) and cascade with the track.
--
-- Everything cascades on user deletion via the FK to "user". The auth-api
-- delete-account handler additionally lists+deletes R2 objects under
-- u/{userId}/ before the user row goes away.

CREATE TABLE "user_track" (
  "user_id"          TEXT    NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "track_id"         TEXT    NOT NULL,                      -- sha256 hex of content
  "r2_key"           TEXT    NOT NULL,                      -- u/{userId}/track/{hash}.igc.gz
  "filename"         TEXT    NOT NULL,
  "display_name"     TEXT    NOT NULL,
  "pilot"            TEXT,
  "glider"           TEXT,
  "flight_date"      TEXT,                                  -- YYYY-MM-DD
  "file_size"        INTEGER NOT NULL,                      -- gzipped bytes (matches what R2 bills)
  "stored_at"        TEXT    NOT NULL,
  "last_accessed_at" TEXT    NOT NULL,
  PRIMARY KEY ("user_id", "track_id")
);
CREATE INDEX "idx_user_track_accessed" ON user_track(user_id, last_accessed_at DESC);

CREATE TABLE "user_task" (
  "user_id"          TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "task_code"        TEXT NOT NULL,                         -- lowercased XContest code or filename slug
  "display_name"     TEXT NOT NULL,
  "xctsk_json"       TEXT NOT NULL,                         -- raw XCTSK JSON (same shape as task.xctsk)
  "stored_at"        TEXT NOT NULL,
  "last_accessed_at" TEXT NOT NULL,
  PRIMARY KEY ("user_id", "task_code")
);
CREATE INDEX "idx_user_task_accessed" ON user_task(user_id, last_accessed_at DESC);

CREATE TABLE "user_annotation" (
  "user_id"   TEXT    NOT NULL,
  "track_id"  TEXT    NOT NULL,
  "stroke_id" TEXT    NOT NULL,                             -- UUID generated client-side
  "color"     TEXT    NOT NULL,
  "width"     REAL    NOT NULL,
  "points"    TEXT    NOT NULL,                             -- JSON [lng,lat][]
  "timestamp" INTEGER NOT NULL,
  PRIMARY KEY ("user_id", "track_id", "stroke_id"),
  FOREIGN KEY ("user_id", "track_id")
    REFERENCES "user_track"("user_id", "track_id") ON DELETE CASCADE
);
CREATE INDEX "idx_user_annotation_track" ON user_annotation(user_id, track_id);
