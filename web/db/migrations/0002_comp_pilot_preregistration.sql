-- Add pre-registration fields to comp_pilot.
-- Pilots may not have a GlideComp account when registered by an organizer.
-- pilot_id is NULL until the pilot signs up and claims their registration (matched by CIVL ID).

-- SQLite cannot ALTER COLUMN, so we recreate the table.

CREATE TABLE IF NOT EXISTS "comp_pilot_new" (
  "comp_pilot_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "comp_id" INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "pilot_id" INTEGER REFERENCES "pilot"("pilot_id") ON DELETE SET NULL,
  "registered_pilot_name" TEXT NOT NULL,
  "registered_pilot_email" TEXT,
  "registered_pilot_civl_id" TEXT,
  "pilot_class" TEXT NOT NULL,
  "team_name" TEXT,
  "driver_contact" TEXT,
  "civl_ranking" INTEGER,
  "first_start_order" INTEGER,
  UNIQUE("comp_id", "pilot_id")
);

-- Migrate existing rows (use pilot.name as registered_pilot_name)
INSERT INTO comp_pilot_new (
  comp_pilot_id, comp_id, pilot_id, registered_pilot_name, pilot_class,
  team_name, driver_contact, civl_ranking, first_start_order
)
SELECT
  cp.comp_pilot_id, cp.comp_id, cp.pilot_id, COALESCE(p.name, 'Unknown'), cp.pilot_class,
  cp.team_name, cp.driver_contact, cp.civl_ranking, cp.first_start_order
FROM comp_pilot cp
LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id;

DROP TABLE comp_pilot;
ALTER TABLE comp_pilot_new RENAME TO comp_pilot;
