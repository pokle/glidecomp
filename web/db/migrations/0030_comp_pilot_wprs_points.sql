-- The roster carries WPRS POINTS, not a rank.
--
-- Migration 0029 put a CIVL rank on each roster row. A rank turns out to be
-- the wrong number to keep, for the reason that made choosing a list hard in
-- the first place: CIVL publishes ten lists and no overall ranking, and a rank
-- is only a position within one list's pool. The pools run from six pilots
-- (HG Class 2) to 6,875 (PG XC), so #5 and #128 can name the same standing —
-- or the reverse of it. Sorting a roster by such numbers mixes them:
--
--   Christian Maurer  #1   400.1 pts  PG Hike & Fly
--   Luke de Weert     #5   100.6 pts  PG Acro Solo
--   A. Andreliunas    #128 250.3 pts  PG XC
--
-- By rank that is the launch order; by achievement it has de Weert two and a
-- half times too high.
--
-- WPRS — the World Pilot Ranking Scheme score CIVL computes from a pilot's
-- results and sorts each list by — is the same quantity in every list. It is
-- what the fill already uses to decide WHICH list to take a pilot from
-- (civl-ranking-match.ts), so keeping it is also keeping the number the
-- decision was made on.
--
-- REAL, not INTEGER: points carry one decimal (261.5), which is exactly the
-- precision that separates pilots near the top of a list.
--
-- `civl_ranking_slug` and `civl_ranking_date` stay as they are. They name the
-- list and month the number came from, which is true of the points as much as
-- it was of the rank, and NULL still means "an organiser typed this in".

ALTER TABLE comp_pilot ADD COLUMN wprs_points REAL;

-- Convert what is already stored rather than asking organisers to re-fill.
-- Every rank was copied from a (list, month, pilot) that `pilot_ranking` still
-- holds, so the points are recoverable by the same key. Checked against
-- production before writing this: 37 rows carried a rank, all 37 join.
--
-- A rank an organiser typed BY HAND cannot be converted — there is no list to
-- look it up in — and becomes NULL. Production had none; a developer database
-- might, and re-typing a number is better than inventing one.
UPDATE comp_pilot
   SET wprs_points = (
     SELECT pr.points FROM pilot_ranking pr
      WHERE pr.civl_id = comp_pilot.registered_pilot_civl_id
        AND pr.ranking_slug = comp_pilot.civl_ranking_slug
        AND pr.ranking_date = comp_pilot.civl_ranking_date
   )
 WHERE civl_ranking IS NOT NULL
   AND civl_ranking_slug IS NOT NULL;

-- A source with no number left is not provenance, it is litter.
UPDATE comp_pilot
   SET civl_ranking_slug = NULL, civl_ranking_date = NULL
 WHERE wprs_points IS NULL;

-- Dropped rather than left in place. It was already dead weight once — carried
-- unused from 0001 until 0029 — and a column nothing reads is a trap for the
-- next person who assumes it means something. Safe to drop: no index and no
-- trigger names it (the search triggers in 0026 watch name/ids/class/team).
ALTER TABLE comp_pilot DROP COLUMN civl_ranking;
