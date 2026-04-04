-- Competition schema for Cloudflare D1 (shared taskscore-auth database)
-- Apply with: wrangler d1 execute taskscore-auth --file=web/workers/competition-api/src/db/competition-schema.sql

-- Long-lived pilot profile. One per user.
CREATE TABLE IF NOT EXISTS "pilot" (
  "pilot_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" TEXT NOT NULL UNIQUE REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "civl_id" TEXT,
  "sporting_body_ids" TEXT,
  "phone" TEXT,
  "glider" TEXT
);

-- Competition
CREATE TABLE IF NOT EXISTS "comp" (
  "comp_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL,
  "creation_date" TEXT NOT NULL,
  "close_date" TEXT,
  "category" TEXT NOT NULL CHECK ("category" IN ('hg', 'pg')),
  "test" INTEGER NOT NULL DEFAULT 0,
  "pilot_classes" TEXT NOT NULL DEFAULT '["open"]',
  "default_pilot_class" TEXT NOT NULL DEFAULT 'open',
  "gap_params" TEXT
);

-- Competition administrators (join table)
CREATE TABLE IF NOT EXISTS "comp_admin" (
  "comp_id" INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  PRIMARY KEY ("comp_id", "user_id")
);

-- Per-competition pilot registration
CREATE TABLE IF NOT EXISTS "comp_pilot" (
  "comp_pilot_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "comp_id" INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "pilot_id" INTEGER NOT NULL REFERENCES "pilot"("pilot_id") ON DELETE CASCADE,
  "pilot_class" TEXT NOT NULL,
  "team_name" TEXT,
  "driver_contact" TEXT,
  "civl_ranking" INTEGER,
  "first_start_order" INTEGER,
  UNIQUE("comp_id", "pilot_id")
);

-- Task within a competition
CREATE TABLE IF NOT EXISTS "task" (
  "task_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "comp_id" INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "task_date" TEXT NOT NULL,
  "creation_date" TEXT NOT NULL,
  "xctsk" TEXT
);

-- Join table linking tasks to pilot classes they score
CREATE TABLE IF NOT EXISTS "task_class" (
  "task_id" INTEGER NOT NULL REFERENCES "task"("task_id") ON DELETE CASCADE,
  "pilot_class" TEXT NOT NULL,
  PRIMARY KEY ("task_id", "pilot_class")
);

-- Links an IGC file to a pilot for a specific task
CREATE TABLE IF NOT EXISTS "task_track" (
  "task_track_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "task_id" INTEGER NOT NULL REFERENCES "task"("task_id") ON DELETE CASCADE,
  "comp_pilot_id" INTEGER NOT NULL REFERENCES "comp_pilot"("comp_pilot_id") ON DELETE CASCADE,
  "igc_filename" TEXT NOT NULL,
  "uploaded_at" TEXT NOT NULL,
  "file_size" INTEGER NOT NULL,
  "flight_data" TEXT,
  "penalty_points" REAL NOT NULL DEFAULT 0,
  "penalty_reason" TEXT,
  UNIQUE("task_id", "comp_pilot_id")
);
