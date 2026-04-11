-- Pilot status tracking.
--
-- 1) comp.pilot_statuses — JSON array of { key, label, on_track_upload }
--    configuring the statuses available in each competition. Default set
--    covers the two canonical statuses: safely landed and DNF.
--
--    on_track_upload controls what happens to a pilot's status on this task
--    when a track is uploaded for them:
--      "none"  — leave the status as-is (e.g. safely landed is implied
--                by the presence of a track, so no action required).
--      "clear" — drop this status (e.g. DNF should be cleared when a
--                track arrives).
--      "set"   — set this status (rarely useful, kept symmetric).
--
-- 2) task_pilot_status — one row per (task, pilot) carrying the current
--    status plus optional free-text note. Statuses are mutually exclusive,
--    enforced by the unique index.

ALTER TABLE comp ADD COLUMN pilot_statuses TEXT NOT NULL DEFAULT
  '[{"key":"safely_landed","label":"Safely landed","on_track_upload":"none"},{"key":"dnf","label":"DNF","on_track_upload":"clear"}]';

CREATE TABLE "task_pilot_status" (
  "task_pilot_status_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "comp_id" INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "task_id" INTEGER NOT NULL REFERENCES "task"("task_id") ON DELETE CASCADE,
  "comp_pilot_id" INTEGER NOT NULL REFERENCES "comp_pilot"("comp_pilot_id") ON DELETE CASCADE,
  "status_key" TEXT NOT NULL,
  "note" TEXT,
  "set_by_user_id" TEXT REFERENCES "user"("id"),
  "set_by_name" TEXT NOT NULL,
  "set_at" TEXT NOT NULL
);

CREATE UNIQUE INDEX "idx_task_pilot_status_unique"
  ON task_pilot_status(task_id, comp_pilot_id);

CREATE INDEX "idx_task_pilot_status_by_comp"
  ON task_pilot_status(comp_id, task_id);
