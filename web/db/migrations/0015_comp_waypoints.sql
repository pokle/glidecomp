-- Competition waypoint database (issue #312).
--
-- One row per competition holds the whole waypoint set as a JSON blob:
-- [{ code, name, latitude, longitude, altitude, radius }]. Comp admins upload
-- and edit it once; tasks then PICK from this shared set when building their
-- route, copying each turnpoint's details into the task's own xctsk. So
-- editing a waypoint here never silently changes an existing task — the task
-- froze its own copy at pick time.
--
-- NOT a scoring input: scoring reads the frozen xctsk on the task row, never
-- this table, so a change here does not stale any task's scores.
CREATE TABLE "comp_waypoints" (
  "comp_id"    INTEGER PRIMARY KEY REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "waypoints"  TEXT NOT NULL,  -- JSON array of { code, name, latitude, longitude, altitude, radius }
  "updated_at" TEXT NOT NULL
);
