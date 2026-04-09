-- Iteration 8a: Bulk pilot management + audit log foundation.
--
-- 1) Flatten pilot.sporting_body_ids JSON into explicit columns. civl_id stays.
-- 2) Add registered_pilot_* ID columns and glider to comp_pilot.
-- 3) Drop UNIQUE(comp_id, pilot_id) on comp_pilot and replace with a partial
--    unique index so that multiple unlinked (pilot_id IS NULL) registrations
--    can coexist.
-- 4) Add open_igc_upload flag to comp.
-- 5) Add uploaded_by_user_id / uploaded_by_name to task_track.
-- 6) Create audit_log table.

-- ── pilot: add new ID columns, drop sporting_body_ids ────────────────────────
-- SQLite cannot DROP COLUMN inside a transaction reliably on older versions,
-- so we recreate the table.

CREATE TABLE "pilot_new" (
  "pilot_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL UNIQUE REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "civl_id" TEXT,
  "safa_id" TEXT,
  "ushpa_id" TEXT,
  "bhpa_id" TEXT,
  "dhv_id" TEXT,
  "ffvl_id" TEXT,
  "fai_id" TEXT,
  "phone" TEXT,
  "glider" TEXT
);

INSERT INTO pilot_new (pilot_id, user_id, name, civl_id, phone, glider)
SELECT pilot_id, user_id, name, civl_id, phone, glider FROM pilot;

DROP TABLE pilot;
ALTER TABLE pilot_new RENAME TO pilot;

-- ── comp_pilot: add registered_* ID columns, glider, drop UNIQUE(comp,pilot) ─

CREATE TABLE "comp_pilot_new" (
  "comp_pilot_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "comp_id" INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "pilot_id" INTEGER REFERENCES "pilot"("pilot_id") ON DELETE SET NULL,
  "registered_pilot_name" TEXT NOT NULL,
  "registered_pilot_email" TEXT,
  "registered_pilot_civl_id" TEXT,
  "registered_pilot_safa_id" TEXT,
  "registered_pilot_ushpa_id" TEXT,
  "registered_pilot_bhpa_id" TEXT,
  "registered_pilot_dhv_id" TEXT,
  "registered_pilot_ffvl_id" TEXT,
  "registered_pilot_fai_id" TEXT,
  "registered_pilot_glider" TEXT,
  "pilot_class" TEXT NOT NULL,
  "team_name" TEXT,
  "driver_contact" TEXT,
  "civl_ranking" INTEGER,
  "first_start_order" INTEGER
);

INSERT INTO comp_pilot_new (
  comp_pilot_id, comp_id, pilot_id,
  registered_pilot_name, registered_pilot_email, registered_pilot_civl_id,
  pilot_class, team_name, driver_contact, civl_ranking, first_start_order
)
SELECT
  comp_pilot_id, comp_id, pilot_id,
  registered_pilot_name, registered_pilot_email, registered_pilot_civl_id,
  pilot_class, team_name, driver_contact, civl_ranking, first_start_order
FROM comp_pilot;

DROP TABLE comp_pilot;
ALTER TABLE comp_pilot_new RENAME TO comp_pilot;

-- Partial unique index: enforce one linked registration per (comp, pilot) but
-- allow many unlinked (pilot_id IS NULL) registrations.
CREATE UNIQUE INDEX "idx_comp_pilot_unique_linked"
  ON comp_pilot(comp_id, pilot_id)
  WHERE pilot_id IS NOT NULL;

-- ── comp: open_igc_upload flag ───────────────────────────────────────────────

ALTER TABLE comp ADD COLUMN open_igc_upload INTEGER NOT NULL DEFAULT 1;

-- ── task_track: uploader attribution ─────────────────────────────────────────

ALTER TABLE task_track ADD COLUMN uploaded_by_user_id TEXT REFERENCES "user"("id");
ALTER TABLE task_track ADD COLUMN uploaded_by_name TEXT;

-- ── audit_log: new table ─────────────────────────────────────────────────────

CREATE TABLE "audit_log" (
  "audit_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "comp_id" INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "timestamp" TEXT NOT NULL,
  "actor_user_id" TEXT REFERENCES "user"("id"),
  "actor_name" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" INTEGER,
  "subject_name" TEXT,
  "description" TEXT NOT NULL
);

CREATE INDEX "idx_audit_log_comp_time"
  ON audit_log(comp_id, timestamp DESC);
