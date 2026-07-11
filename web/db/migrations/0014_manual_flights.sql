-- Manual flight reports for track-less pilots (issue #306).
--
-- A pilot who took off (verified by launch marshals) but has no valid
-- tracklog is scored from a manual flight: the last turnpoint they legally
-- reached plus where they landed (FAI S7F §8.4). The engine turns those two
-- facts into a made-good distance (web/engine/src/manual-flight.ts) that feeds
-- GAP scoring exactly like a real track, so a full field is scored, not just
-- the pilots who uploaded IGCs.
--
-- A pilot has at most ONE active flight record per task — a track XOR a manual
-- flight. Recording one supersedes the other; setting Absent/DNF/Present
-- supersedes both. Superseded records are RETAINED (active = 0), never
-- hard-deleted, so they stay viewable and restorable. This also fixes the bug
-- where setting DNF left a still-scoring track on disk (scoring now reads only
-- active records).

-- 1) Manual flight evidence. Many rows may accumulate per (task, pilot) as
--    reports are superseded; the partial unique index enforces at most one
--    ACTIVE row.
CREATE TABLE "task_manual_flight" (
  "task_manual_flight_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "task_id" INTEGER NOT NULL REFERENCES "task"("task_id") ON DELETE CASCADE,
  "comp_pilot_id" INTEGER NOT NULL REFERENCES "comp_pilot"("comp_pilot_id") ON DELETE CASCADE,
  -- Index into the FULL task turnpoints[] of the last turnpoint legally
  -- reached (the admin-vouched anchor). Mapped to the scoring-task frame at
  -- score time (distance origin trims leading take-off turnpoints).
  "last_reached_tp_index" INTEGER NOT NULL,
  "landing_lat" REAL NOT NULL,
  "landing_lon" REAL NOT NULL,
  -- Derived from last_reached_tp_index === goal at capture; stored for the
  -- "Goal" badge without re-parsing the task.
  "made_goal" INTEGER NOT NULL DEFAULT 0,
  -- Speed-section time in seconds, only meaningful in goal.
  "duration_seconds" INTEGER,
  -- Materialized made-good distance (metres) the engine computed at capture,
  -- for display/audit. Scoring recomputes live so a later route edit rescales
  -- it correctly.
  "computed_distance" REAL NOT NULL DEFAULT 0,
  -- 1 = the scored evidence for this pilot; 0 = superseded (retained).
  "active" INTEGER NOT NULL DEFAULT 1,
  "set_by_user_id" TEXT REFERENCES "user"("id"),
  "set_by_name" TEXT NOT NULL,
  "set_at" TEXT NOT NULL
);

-- At most one ACTIVE manual flight per pilot/task; superseded rows are exempt.
CREATE UNIQUE INDEX "idx_task_manual_flight_active"
  ON task_manual_flight(task_id, comp_pilot_id) WHERE active = 1;
CREATE INDEX "idx_task_manual_flight_by_task"
  ON task_manual_flight(task_id);

-- 2) Tracks gain the same active/superseded concept, so setting Absent/DNF/
--    Present (or recording a manual flight) can supersede a track WITHOUT
--    deleting it. Existing tracks are active. An explicit "delete track" still
--    hard-deletes (removes the R2 object); this flag is for reconciliation.
ALTER TABLE task_track ADD COLUMN "active" INTEGER NOT NULL DEFAULT 1;

-- 3) 'landed' is no longer a hand-picked status — it is DERIVED from an active
--    flight record (track or manual). Existing 'landed' rows all came from
--    track uploads, and those tracks are now active, so the outcome still
--    resolves to Landed. Drop the redundant rows; the status table keeps only
--    the admin-set outcomes (absent/dnf), Present being the absence of a row.
DELETE FROM task_pilot_status WHERE status_key = 'landed';
