/**
 * Shaping one pilot class's engine result into the API response: penalties,
 * ranking, and the transparency extras the report card reads.
 */

import type { GAPParameters, StoppedTaskScore, TaskScoreCore } from "@glidecomp/engine";
import { encodeId } from "../sqids";
import type {
  ClassScore,
  ClassValidityInputs,
  ExcludedPilot,
  PilotScoreEntry,
} from "./types";

/**
 * Rank competition standings by total score, sharing ranks on ties.
 *
 * S7A §5.2.5.1/§5.2.5.4: the overall competition ranking orders pilots by total
 * score descending, and "pilots with the same score are ranked in the same
 * position" — ties are permitted, with no tie-break. Equality is on the
 * *published* whole-point total (the value the UI shows via `Math.round`,
 * matching AirScore's `comp_result_decimal`), so two pilots displaying the same
 * total share a rank even when their raw sums differ by a fraction. Returns a
 * new array sorted best-first with a 1-based `rank` assigned (e.g. 1, 2, 2, 4),
 * mirroring the engine's per-task tie handling in gap-scoring.ts.
 */
export function rankByTotalScore<T extends { total_score: number }>(
  pilots: T[]
): Array<T & { rank: number }> {
  const ranked = [...pilots]
    .sort((a, b) => b.total_score - a.total_score)
    .map((p) => ({ ...p, rank: 0 }));
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].rank =
      i > 0 &&
      Math.round(ranked[i].total_score) === Math.round(ranked[i - 1].total_score)
        ? ranked[i - 1].rank
        : i + 1;
  }
  return ranked;
}

/**
 * An empty class result — used when a class has no scored tracks. Any pilot
 * whose track was withheld for data quality is still seated, at 0: a class
 * whose ONLY track hard-failed must not silently lose its competitor.
 */
export function emptyClassScore(
  pilotClass: string,
  excluded: ExcludedPilot[] = [],
  alphabet = ""
): ClassScore {
  return {
    pilot_class: pilotClass,
    task_validity: { launch: 0, distance: 0, time: 0, task: 0 },
    available_points: { distance: 0, time: 0, leading: 0, arrival: 0, total: 0 },
    pilots: excluded.map((e, i) => excludedPilotEntry(e, i + 1, alphabet)),
  };
}

/**
 * The standings row for a pilot whose tracklog was withheld: zero everywhere,
 * with the reasons attached so the scores table and the score-detail page can
 * say WHY rather than showing an unexplained 0.
 */
function excludedPilotEntry(
  excluded: ExcludedPilot,
  rank: number,
  alphabet: string
): PilotScoreEntry {
  return {
    rank,
    comp_pilot_id: encodeId(alphabet, excluded.comp_pilot_id),
    pilot_name: excluded.pilot_name,
    made_goal: false,
    reached_ess: false,
    flown_distance: 0,
    speed_section_time: null,
    distance_points: 0,
    distance_linear_points: 0,
    distance_difficulty_points: 0,
    time_points: 0,
    leading_points: 0,
    arrival_points: 0,
    penalty_points: 0,
    penalty_reason: null,
    total_score: 0,
    early_start_seconds: null,
    early_start_outcome: null,
    jump_the_gun_penalty: null,
    stopped_altitude_bonus: null,
    leading_coefficient: null,
    arrival_position: null,
    ess_time_ms: null,
    track_excluded: { reasons: excluded.reasons },
  };
}

/** What the scorer knows about a pilot that the engine result does not. */
export interface PilotMeta {
  comp_pilot_id: number;
  penalty_points: number;
  penalty_reason: string | null;
}

/**
 * Index a class's analysed pilots by track file, for pairing back to engine
 * results. scoreFlights()/scoreOpenDistanceFlights() sort pilotScores by rank,
 * so the output order does NOT match the input order — pair each score back to
 * its pilot by trackFile (the unique igc_filename), never by array index.
 */
export function pilotMetaByTrackFile(
  pilots: Array<PilotMeta & { flight: { trackFile: string } }>
): Map<string, PilotMeta> {
  return new Map(
    pilots.map((p) => [
      p.flight.trackFile,
      {
        comp_pilot_id: p.comp_pilot_id,
        penalty_points: p.penalty_points,
        penalty_reason: p.penalty_reason,
      },
    ])
  );
}

/**
 * Apply penalties, re-rank, and shape one class's engine result into the API
 * response. Shared by the GAP and open-distance paths — both produce a result
 * with the same taskValidity / availablePoints / pilotScores shape.
 */
export function buildClassScore(
  pilotClass: string,
  result: Pick<TaskScoreCore, "taskValidity" | "availablePoints" | "pilotScores"> & {
    stopped?: StoppedTaskScore;
  },
  pilotMeta: Map<string, PilotMeta>,
  alphabet: string,
  // Pilots whose tracklogs a HARD data-quality finding withheld from
  // scoring. Appended AFTER the sort, so the scored field's ranks are exactly
  // what they would be if these tracks had never been uploaded, and the
  // withheld pilots take the places below them.
  excluded: ExcludedPilot[] = [],
  // Transparency extras the GAP path supplies and the open-distance path does
  // not (it has no validity story and ignores GAP parameters).
  transparency?: { validity_inputs: ClassValidityInputs; gap_params: GAPParameters }
): ClassScore {
  const withPenalties = result.pilotScores.map((ps) => {
    const pilot = pilotMeta.get(ps.trackFile)!;
    // FAI S7F §12.4: apply the scorekeeper's absolute penalty, then round to
    // one decimal place (rounding is done after penalties), floored at zero
    // (the lowest score a pilot can attain is 0). ps.totalScore is already the
    // §11 one-decimal total; re-rounding keeps the final clean when the
    // penalty itself carries more precision.
    const penalised = ps.totalScore - pilot.penalty_points;
    return {
      pilotScore: ps,
      comp_pilot_id: pilot.comp_pilot_id,
      penalty_points: pilot.penalty_points,
      penalty_reason: pilot.penalty_reason,
      finalScore: Math.max(0, Math.round(penalised * 10) / 10),
    };
  });

  withPenalties.sort((a, b) => b.finalScore - a.finalScore);

  const pilots: PilotScoreEntry[] = withPenalties.map((p, i) => ({
    rank: i + 1,
    comp_pilot_id: encodeId(alphabet, p.comp_pilot_id),
    pilot_name: p.pilotScore.pilotName,
    made_goal: p.pilotScore.madeGoal,
    reached_ess: p.pilotScore.reachedESS,
    flown_distance: p.pilotScore.flownDistance,
    speed_section_time: p.pilotScore.speedSectionTime,
    distance_points: p.pilotScore.distancePoints,
    distance_linear_points: p.pilotScore.distanceLinearPoints,
    distance_difficulty_points: p.pilotScore.distanceDifficultyPoints,
    time_points: p.pilotScore.timePoints,
    leading_points: p.pilotScore.leadingPoints,
    arrival_points: p.pilotScore.arrivalPoints,
    penalty_points: p.penalty_points,
    penalty_reason: p.penalty_reason,
    total_score: p.finalScore,
    early_start_seconds: p.pilotScore.earlyStartSeconds ?? null,
    early_start_outcome: p.pilotScore.earlyStartOutcome ?? null,
    jump_the_gun_penalty: p.pilotScore.jumpTheGunPenalty ?? null,
    stopped_altitude_bonus: p.pilotScore.stoppedAltitudeBonus ?? null,
    // Only meaningful where leading is scored; elsewhere the engine leaves it
    // at 0 (or Infinity for a pilot with no valid start), and publishing that
    // would invite the page to explain a number that decided nothing.
    leading_coefficient:
      transparency && transparency.gap_params.useLeading &&
      Number.isFinite(p.pilotScore.leadingCoefficient)
        ? p.pilotScore.leadingCoefficient
        : null,
    arrival_position: p.pilotScore.arrivalPosition ?? null,
    ess_time_ms: p.pilotScore.essTimeMs ?? null,
    track_excluded: null,
  }));

  for (const e of excluded) {
    pilots.push(excludedPilotEntry(e, pilots.length + 1, alphabet));
  }

  return {
    pilot_class: pilotClass,
    task_validity: result.taskValidity,
    available_points: result.availablePoints,
    pilots,
    ...(transparency
      ? {
          validity_inputs: transparency.validity_inputs,
          gap_params: transparency.gap_params,
        }
      : {}),
    ...(result.stopped
      ? {
          stopped: {
            stop_time_ms: result.stopped.stopTimeMs,
            scored_window_seconds: result.stopped.scoredWindowSeconds,
            minimum_run_seconds: result.stopped.minimumRunSeconds,
            requirement_met: result.stopped.requirementMet,
            stopped_validity: result.stopped.stoppedValidity,
            time_points_reduction: result.stopped.timePointsReduction,
            num_landed_before_stop: result.stopped.numLandedBeforeStop,
          },
        }
      : {}),
  };
}

/**
 * The validity/weight inputs for one scored class, from the engine result.
 *
 * `mean_distance_over_minimum` is recomputed here rather than read off the
 * engine, but from the same array `calculateDistanceValidity` was handed:
 * `PilotScore.flownDistance` is the scored distance with the minimum-distance
 * floor already applied, which is exactly what the validity ran on.
 */
export function validityInputs(
  result: Pick<TaskScoreCore, "stats" | "weights" | "pilotScores">,
  params: GAPParameters
): ClassValidityInputs {
  const s = result.stats;
  const overMinimum = result.pilotScores.reduce(
    (sum, p) => sum + Math.max(0, p.flownDistance - params.minimumDistance),
    0
  );
  return {
    num_present: s.numPresent,
    num_flying: s.numFlying,
    num_in_goal: s.numInGoal,
    num_reached_ess: s.numReachedESS,
    best_distance: s.bestDistance,
    best_time: s.bestTime,
    goal_ratio: s.goalRatio,
    task_distance: s.taskDistance,
    mean_distance_over_minimum:
      s.numFlying > 0 ? overMinimum / s.numFlying : 0,
    weights: result.weights,
  };
}
