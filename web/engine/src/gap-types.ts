/**
 * CIVL GAP scoring types — the shapes the scorer reads and publishes.
 *
 * Declarations first: the per-pilot input ({@link FlightScoringData}), the
 * per-pilot and whole-field results ({@link PilotScore},
 * {@link TaskScoreResult}, {@link TaskStats}, {@link StoppedTaskScore}), and
 * the small option/candidate shapes the scoring entry points take. The only
 * runtime code here is the pair of one-line readers of these shapes
 * ({@link isNeutralisingOutcome}, {@link officialStartTimeMs}) — the single
 * interpretation of a field every scoring module shares.
 *
 * Split out of ./gap-scoring so that module stays inside the 1,000-line
 * boundary; gap-scoring re-exports everything here, so the public surface and
 * every existing import are unchanged.
 *
 * @see https://www.fai.org/sites/default/files/civl/documents/sporting_code_s7_f_-_xc_scoring_2026.pdf
 */

import type { IGCFix } from './igc-parser';
import type { TurnpointSequenceResult, TurnpointReaching } from './turnpoint-sequence';
import type { GAPParameters } from './gap-params';
import type { TaskValidity, WeightFractions } from './gap-formulas';
import type {
  LeadingAggregate,
  LeadingFieldTimes,
  LeadingMaxTimeSource,
} from './gap-leading';

/**
 * Available points in each category.
 *
 * `total` is the day's points on offer — 1000 × task validity — and is NOT
 * defined as the sum of the four components. They normally add up to it, but
 * under FAI S7F §11 an HG task nobody flew to ESS has zero time and arrival
 * points with nothing redistributed, so distance + leading falls short of the
 * total by the unallocated remainder.
 */
export interface AvailablePoints {
  distance: number;
  time: number;
  leading: number;
  arrival: number;
  total: number;
}

/**
 * How an early start reshaped a pilot's score (FAI S7F §13.3) — see
 * {@link PilotScore.earlyStartOutcome} for what each case means.
 */
export type EarlyStartOutcome = 'pg_launch_to_sss' | 'hg_penalty' | 'hg_min_distance';

/**
 * Whether an early-start outcome NEUTRALISES the flight (§13.3): the pilot is
 * scored for a fixed distance only — the PG launch→SSS leg, or the HG minimum
 * distance — with no time, leading or arrival points. 'hg_penalty' is NOT
 * neutralising: the complete flight is scored and only a points penalty
 * applies. The one predicate the scorer's early-start branches share, so the
 * pair of outcomes can never drift apart between call sites.
 */
export function isNeutralisingOutcome(o: EarlyStartOutcome | undefined): boolean {
  return o === 'pg_launch_to_sss' || o === 'hg_min_distance';
}

/** Individual pilot's scored result. */
export interface PilotScore {
  /** Pilot name from IGC header, or filename */
  pilotName: string;
  /** Source track file path */
  trackFile: string;
  /** Distance flown in meters */
  flownDistance: number;
  /** Speed section time in seconds, null if ESS not reached */
  speedSectionTime: number | null;
  /** Whether the pilot completed the task */
  madeGoal: boolean;
  /** Whether the pilot reached End of Speed Section */
  reachedESS: boolean;
  /** Distance component score (linear + difficulty halves) */
  distancePoints: number;
  /** Linear half of the distance score (the full score when difficulty is off / PG) */
  distanceLinearPoints: number;
  /** Difficulty half of the distance score (0 for PG or when difficulty is off) */
  distanceDifficultyPoints: number;
  /** Time/speed component score */
  timePoints: number;
  /** Leading coefficient component score */
  leadingPoints: number;
  /** Arrival component score (HG only, 0 for PG) */
  arrivalPoints: number;
  /**
   * Sum of all point components, rounded to one decimal place (FAI S7F §12).
   * Any jump-the-gun penalty (§13.3) is applied before this rounding; the
   * scorekeeper's absolute penalty (§13.5) is applied downstream in the
   * backend, which re-rounds after subtracting it. Ranking and tie-breaks use
   * this spec-rounded value — the UI may still display it as whole points.
   */
  totalScore: number;
  /** Rank position (1-based) */
  rank: number;
  /** Leading coefficient value */
  leadingCoefficient: number;
  /**
   * Where this pilot came in the ESS arrival order (1-based), the sole input
   * to arrival points besides the size of the field that reached ESS.
   *
   * Ordered by WALL-CLOCK time at ESS, not by speed: a pilot on an early
   * start gate can cross ESS ahead of a faster pilot on a later gate and
   * take more arrival points for it. Published because the scorer's own
   * ordering is otherwise unreproducible from the results — the report card
   * had no way to substitute the §13.5 formula and could only assert its
   * output.
   *
   * Absent when arrival points aren't scored (PG, or useArrival off) and for
   * a pilot who never reached ESS.
   */
  arrivalPosition?: number;
  /**
   * Epoch milliseconds at which this pilot reached the end of the speed
   * section, or null if they never did. The evidence behind
   * {@link arrivalPosition}: with it a reader can check the order rather than
   * take it on trust, and a tie (two pilots, one timestamp) becomes visible
   * instead of presenting as a confident ordering the data cannot support.
   */
  essTimeMs?: number | null;
  /**
   * Seconds the pilot started before the first start gate (§12.2), when an
   * early start was detected. Absent for normal starts.
   */
  earlyStartSeconds?: number;
  /**
   * How the early start reshaped the score (§13.3):
   * - 'pg_launch_to_sss' — PG: scored only for the launch→SSS distance
   * - 'hg_penalty' — HG within the limit: full flight scored, penalty applied
   * - 'hg_min_distance' — HG beyond the limit: scored for minimum distance
   */
  earlyStartOutcome?: EarlyStartOutcome;
  /**
   * Jump-the-gun penalty points deducted from the total (HG 'hg_penalty'
   * outcome): earlyStartSeconds ÷ jumpTheGunFactor, with the total floored
   * at the minimum-distance score rather than zero (§12.2).
   */
  jumpTheGunPenalty?: number;
  /**
   * Stopped tasks only (§13.4.6): the altitude-bonus distance (meters)
   * folded into this pilot's flownDistance. Absent when no bonus applied.
   */
  stoppedAltitudeBonus?: number;
  /** Underlying turnpoint sequence result for transparency */
  turnpointResult: TurnpointSequenceResult;
}

/**
 * The whole-field stopped-task outcome (FAI S7F §13.4), present on the
 * result when the task was scored as stopped.
 */
export interface StoppedTaskScore {
  /** The resolved task stop time (epoch ms) the field was scored against (§13.4.1). */
  stopTimeMs: number;
  /**
   * Seconds from the scored-window start — the race start for a
   * single-start-gate race, otherwise the last pilot's start — to the stop
   * time (§13.4.2/§13.4.4). Null when nobody started before the stop.
   */
  scoredWindowSeconds: number | null;
  /** §13.4.2 minimum run: min(1 h, nominalTime ÷ 2), in seconds. */
  minimumRunSeconds: number;
  /**
   * Whether the stopped task ran long enough to be scored (§13.4.2). When
   * false the stopped validity is 0, so every pilot scores 0 — the closest
   * scoreable representation of "the task cannot be scored".
   */
  requirementMet: boolean;
  /** The §13.4.3 stopped-task validity applied (0 when requirementMet is false). */
  stoppedValidity: number;
  /**
   * §13.4.5 (2026): the fixed time-points reduction applied to every goal
   * pilot — the standard §12.2 time points the best pilot between ESS and
   * goal at the stop would have received had they completed the flight (or,
   * with nobody between, a hypothetical pilot reaching ESS exactly at the
   * end of the scored window). The same amount is ADDED to the available
   * distance points, so the published `availablePoints.distance` already
   * carries it. 0 when nobody made goal or no best time exists.
   */
  timePointsReduction: number;
  /** Launched pilots who landed before the stop (feeds §13.4.3). */
  numLandedBeforeStop: number;
}

/**
 * The §12.3.1 leading clock as the field resolved it: the times it was built
 * from, and the `maxTime` they produced.
 *
 * Published because `maxTime` is the one input to a landed-out pilot's
 * leading coefficient that lives entirely outside their own flight — without
 * it the report card can only assert the coefficient, never show where the
 * graph was carried to or why it stopped there.
 */
export interface LeadingTimes extends LeadingFieldTimes {
  /** maxTime = min(max(lastOutlandingTime, lastESStime), taskDeadline), epoch ms. */
  maxTimeMs: number;
  /** Which of the field times `maxTimeMs` came from. */
  maxTimeSource: LeadingMaxTimeSource;
}

/** Complete task scoring result. */
export interface TaskScoreResult {
  parameters: GAPParameters;
  taskValidity: TaskValidity;
  weights: WeightFractions;
  availablePoints: AvailablePoints;
  pilotScores: PilotScore[];
  /** Aggregate stats used in scoring */
  stats: TaskStats;
  /** Present when the task was scored as stopped (FAI S7F §13.4). */
  stopped?: StoppedTaskScore;
  /**
   * The §12.3.1 leading clock the coefficients were measured against.
   * Present only when the competition scores leading points.
   */
  leadingTimes?: LeadingTimes;
}

/** Aggregate statistics from all pilots in the task. */
export interface TaskStats {
  numPresent: number;
  numFlying: number;
  numInGoal: number;
  numReachedESS: number;
  bestDistance: number;
  bestTime: number | null;
  goalRatio: number;
  taskDistance: number;
}

/** A scored pilot without the (heavy) transparency turnpoint result. */
export type PilotScoreCore = Omit<PilotScore, 'turnpointResult'>;

/** {@link TaskScoreResult} without the per-pilot turnpoint results. */
export type TaskScoreCore = Omit<TaskScoreResult, 'pilotScores'> & {
  pilotScores: PilotScoreCore[];
};

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** A pilot's flight data for scoring. */
export interface PilotFlight {
  /** Pilot name (from IGC header or filename) */
  pilotName: string;
  /** Source file path */
  trackFile: string;
  /** Parsed GPS fixes */
  fixes: IGCFix[];
}

/**
 * What one flight brings to the leading-coefficient calculation (FAI S7F
 * §13.4) — exactly one of three mutually exclusive cases, so the scorer never
 * has to guess which fields a caller meant to fill in:
 *
 * - `aggregate` — the field-independent per-track scan is already done. The
 *   competition backend caches it per track, so a new upload doesn't force a
 *   re-scan of the whole field.
 * - `track` — the raw tracklog plus its resolved reachings; the aggregate is
 *   computed on the fly. This is `scoreTask`'s path.
 * - `none` — nothing to lead with, and no leading points (LC = Infinity).
 *   Either the competition scores no leading at all (the common case: the
 *   per-fix scan is the expensive part, so it is skipped), or the pilot is
 *   track-less — a manual flight, issue #306, which has no tracklog to lead
 *   with in the first place.
 *
 * Stating the choice as a union rather than as correlated optional fields is
 * what lets the compiler reject a mis-wired flight at the call site. The
 * scorer used to discover it mid-run and throw.
 */
export type FlightLeadingInput =
  | { kind: 'aggregate'; aggregate: LeadingAggregate }
  | { kind: 'track'; fixes: IGCFix[]; sequence: TurnpointReaching[] }
  | { kind: 'none' };

/**
 * Compact, per-pilot scoring inputs — everything the whole-field GAP
 * aggregation needs from one flight, in a plain-JSON-serializable shape.
 *
 * This is the boundary that lets the scoring backend cache per-track work:
 * resolving a pilot's turnpoint sequence (the expensive tracklog scan) is
 * independent of the rest of the field, so it can be computed once and reused
 * while the cheap field-level aggregation re-runs whenever the roster changes.
 */
export interface FlightScoringData {
  /** Pilot name (from IGC header, filename, or roster) */
  pilotName: string;
  /** Source file path — the unique key used to pair scores back to a pilot */
  trackFile: string;
  /** Raw scored flown distance in metres (pre minimum-distance floor) */
  flownDistance: number;
  /** Whether the pilot completed the task */
  madeGoal: boolean;
  /** Whether the pilot reached End of Speed Section */
  reachedESS: boolean;
  /**
   * Speed section time in seconds, or null if ESS not reached. In a gated
   * race this is already gate-based (ESS time − start gate time, §9.4) —
   * resolveTurnpointSequence computes it that way.
   */
  speedSectionTime: number | null;
  /**
   * SSS reaching time (epoch ms), or null if the pilot never started.
   * Always the pilot's ACTUAL crossing (it anchors the leading-coefficient
   * tracklog scan and places the gates on the right day); the gate-based
   * official start time is already folded into speedSectionTime.
   */
  sssTimeMs: number | null;
  /** ESS reaching time (epoch ms), or null if ESS not reached */
  essTimeMs: number | null;
  /**
   * Seconds the pilot started before the first start gate (§13.3 early
   * start), when detected. Drives the sport-specific early-start scoring
   * (PG launch→SSS clamp, HG jump-the-gun penalty).
   */
  earlyStartSeconds?: number;
  /**
   * The pilot's OFFICIAL start time (epoch ms): the start gate taken in a
   * gated race (§9.2.4.1), otherwise the actual crossing. Feeds the stopped-
   * task scored-window arithmetic (§13.4.2/§13.4.4). Null/absent when the
   * pilot never started (older cached data may omit it — sssTimeMs is the
   * fallback).
   */
  startTimeMs?: number | null;
  /**
   * Stopped tasks only: whether the pilot landed before the task stop
   * (their tracklog ends before the scored-window end). Feeds the §13.4.3
   * stopped validity. Absent (counted as landed) for track-less pilots.
   */
  landedBeforeStop?: boolean;
  /**
   * Stopped tasks only (§13.4.6): the altitude-bonus distance (meters)
   * already folded into flownDistance, passed through for transparency.
   */
  stoppedAltitudeBonus?: number;
  /**
   * What this flight brings to the §13.4 leading calculation — see
   * {@link FlightLeadingInput}. Only read when
   * {@link GAPParameters.useLeading} is on, but required on every flight so
   * the three cases stay exhaustive: `{ kind: 'none' }` is the honest,
   * explicit answer both for a leading-off competition and for a track-less
   * pilot, and leaving the field optional would put a fourth (unstated) state
   * back into the type.
   */
  leading: FlightLeadingInput;
}

/**
 * A flight's OFFICIAL start time (epoch ms): the gate-snapped start when the
 * flight recorded one, otherwise the actual SSS crossing — older cached rows
 * predate {@link FlightScoringData.startTimeMs}, so the crossing is the
 * fallback. Null when the pilot never started. The one interpretation of the
 * pair of fields, shared by every consumer (§9.2.4.1, §13.4.4).
 */
export function officialStartTimeMs(
  f: Pick<FlightScoringData, 'startTimeMs' | 'sssTimeMs'>,
): number | null {
  return f.startTimeMs ?? f.sssTimeMs;
}

/** The per-pilot facts the best-time source reads (FAI S7F §9.4.1). */
export interface BestTimeCandidate {
  madeGoal: boolean;
  reachedESS: boolean;
  speedSectionTime: number | null;
}

/** Options for `scoreTask` beyond the parameter set. */
export interface ScoreTaskOptions {
  /**
   * The task stop announcement time (epoch ms) when the task was stopped
   * (FAI S7F §13.4). The task stop time is derived from it per §13.4.1
   * (PG: minus {@link GAPParameters.scoreBackTime}; HG: minus one start-gate
   * interval, or 15 minutes with a single gate) and the whole §13.4
   * machinery applies. Omit/null for a normally completed task.
   */
  stopAnnouncementMs?: number | null;
}
