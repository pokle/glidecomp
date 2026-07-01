-- Competition scoring format.
--
-- comp.scoring_format selects how a competition's tasks are scored:
--   "gap"           — CIVL GAP race-to-goal / elapsed-time (the default and
--                     historical behaviour; driven by comp.gap_params).
--   "open_distance" — Open distance: a single TAKEOFF turnpoint, no goal;
--                     each pilot scores the metres of open distance flown
--                     from the point they exit the take-off cylinder.
--
-- Existing competitions default to "gap" so their scores are unchanged.
-- The value is also validated in the app layer (zod enum in validators.ts).

ALTER TABLE comp ADD COLUMN scoring_format TEXT NOT NULL DEFAULT 'gap'
  CHECK ("scoring_format" IN ('gap', 'open_distance'));
