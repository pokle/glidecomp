-- Track data-quality: the scorekeeper's override.
--
-- track-quality.ts assesses every submitted tracklog against its task and can
-- return a HARD verdict (the fixes fall outside the task's day by more than a
-- day, or no fix comes within 100 km of any turnpoint), which withholds the
-- track from scoring and from field analysis.
--
-- FAI S7A §4.4.6 (Rejection of Track Log) makes that call the ORGANISER's, not
-- the software's: "the pilot is to be awarded zero points for the task" only
-- where the organiser judges the log does not show sufficient evidence. So the
-- automatic verdict is a default a scorekeeper can overrule, never an
-- unappealable zero — set this to 1 and the track is scored and analysed
-- normally, with its findings still shown on the pilot's score page.
--
-- Deliberately a column on task_track rather than a row elsewhere: it is a
-- ruling about one uploaded file, it must survive re-scoring and cache clears,
-- and it must be readable in resolveTaskScoringConfig's existing track query
-- with no extra round trip.

ALTER TABLE "task_track" ADD COLUMN "quality_override" INTEGER NOT NULL DEFAULT 0;
