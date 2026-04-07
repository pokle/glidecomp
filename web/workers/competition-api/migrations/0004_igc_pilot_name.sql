-- Add igc_pilot_name to task_track to store the pilot name from the IGC file header.
-- NULL for existing tracks (uploaded before this migration).
ALTER TABLE task_track ADD COLUMN igc_pilot_name TEXT;
