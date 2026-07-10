-- Fixed pilot status vocabulary (issue #261).
--
-- Pilot statuses are no longer a per-competition, admin-editable config.
-- The vocabulary is now fixed in code (web/workers/competition-api/src/
-- pilot-statuses.ts) and identical for every competition:
--
--   (no row) = Present (default)   absent = Absent
--   dnf = Did Not Fly              landed = Landed (set on track upload)
--
-- These statuses now feed launch validity (FAI S7F §9.1): non-absent
-- pilots are "present", pilots with tracks are "flying".
--
-- 1) Migrate existing free-form task_pilot_status rows to the fixed keys.
--    The old default set was safely_landed + dnf. "safely_landed" (a track
--    is implied) becomes "landed"; "dnf" already matches.
UPDATE task_pilot_status SET status_key = 'landed' WHERE status_key = 'safely_landed';

--    Any other admin-created free-form key has no fixed equivalent — clear
--    those rows so those pilots revert to the Present default rather than
--    render an unknown status.
DELETE FROM task_pilot_status WHERE status_key NOT IN ('absent', 'dnf', 'landed');

-- 2) Drop the now-unused per-comp config column. The vocabulary lives in
--    code; nothing reads this column anymore.
ALTER TABLE comp DROP COLUMN pilot_statuses;
