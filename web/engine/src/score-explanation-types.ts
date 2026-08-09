/**
 * Score-explanation output and input types.
 *
 * The structured-data vocabulary the explanation builder produces and
 * consumes. Kept in its own module so the format helpers, the section
 * builders, and the public entry points can all share it without cycles.
 */

import type { XCTask } from './xctsk-parser';
import type { TurnpointSequenceResult } from './turnpoint-sequence';
import type { GAPParameters } from './gap-scoring';
import type { OpenDistanceGeometry } from './open-distance-scoring';
import type { ManualFlightGeometry } from './manual-flight';
import type { IGCFix } from './igc-parser';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** What an anchored item points at — lets the UI pick a marker style. */
export type ExplanationAnchorKind =
  | 'start'
  | 'start_candidate'
  | 'turnpoint'
  | 'ess'
  | 'goal'
  | 'best_progress'
  | 'origin'
  | 'furthest';

/** A location on the track/task that an explanation item refers to. */
export interface ExplanationAnchor {
  kind: ExplanationAnchorKind;
  latitude: number;
  longitude: number;
  /** GNSS altitude in metres, when known. */
  altitude?: number;
  /** Epoch milliseconds, when known (JSON-safe). */
  timeMs?: number;
  /**
   * An optional routed polyline the UI can draw for this anchor. For a
   * landed-out pilot's `best_progress` point this is the remaining task
   * route — from that point, through each un-reached turnpoint's optimal
   * tag point, to goal — so the "measured along the task" / "X km short"
   * wording is visible on the map rather than implied by a lone pin.
   */
  path?: Array<{ latitude: number; longitude: number }>;
}

/** One explainable fact or step in the calculation. */
export interface ScoreExplanationItem {
  id: string;
  /** Primary human-readable sentence. */
  text: string;
  /** Short figure shown alongside the text, e.g. "12:45:03" or "343.2 pts". */
  value?: string;
  /** Secondary line, e.g. the formula with substituted values. */
  detail?: string;
  /** Rendering hint: muted = supporting fact, warning = scoring caveat. */
  emphasis?: 'normal' | 'muted' | 'warning';
  /** Where this happened — lets the UI pan a map to the evidence. */
  anchor?: ExplanationAnchor;
  /**
   * A small chart belonging to this row rather than to the whole section —
   * the validity sparklines, and the distance distribution. Section charts
   * explain a component; these explain one line of it, and are drawn inline
   * at sparkline scale.
   */
  chart?: ScoreChart;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** One sample of a scoring function, in data space. */
export interface ScoreChartPoint {
  x: number;
  y: number;
}

/** One pilot's position on a component's scoring function. */
export interface ScoreChartPilot {
  /** Stable key within the chart (the API's comp_pilot_id where known). */
  key: string;
  name: string;
  x: number;
  /** The pilot's PUBLISHED points — never a recomputed value. */
  y: number;
  /** True for the pilot whose report card this is. */
  you: boolean;
}

/** What the x axis measures, so a UI can format ticks without guessing. */
export type ScoreChartXUnit = 'duration' | 'distance' | 'coefficient' | 'position';

/**
 * A point component's scoring function, with the field placed on it.
 *
 * This is NOT a fit. `curve` is the scorer's own function sampled, and every
 * pilot in `pilots` has been checked to sit on it: their published points and
 * the function's value at their x agree to within the published rounding.
 * Anyone who does not (an ESS-but-not-goal pilot carrying the §12.1
 * reduction, a goal pilot docked by a stopped task) is counted in `omitted`
 * and left off, because a dot beside the curve would silently contradict the
 * claim the curve makes. That check is what lets the caption say "every dot
 * sits exactly on it" and be true.
 */
export interface ScoreCurveChart {
  kind: 'curve';
  /** Axis label for x, e.g. "Speed section time". */
  xLabel: string;
  xUnit: ScoreChartXUnit;
  /** The scoring function, sampled left to right. */
  curve: ScoreChartPoint[];
  /** Every pilot the curve provably explains, including this one. */
  pilots: ScoreChartPilot[];
  /** Pilots whose published points the curve does not explain (see above). */
  omitted: number;
  /** The reading, in words — the figcaption and the accessible name. */
  caption: string;
}

/**
 * A validity factor's curve, with the DAY on it.
 *
 * Deliberately not a component chart: a validity factor is a fact about the
 * task, not about a pilot, and it has exactly one point — the day's. Putting
 * the field along it would be a category error, inviting every reader to
 * find "their" validity on a curve none of their numbers feed.
 *
 * Drawn sparkline-sized beside the row it explains. Only the factors that
 * genuinely curve get one: distance validity is the identity function on its
 * ratio (S7F clamps it and stops), so its shape says nothing and its
 * interesting content is the field's spread — see {@link ScoreDistributionChart}.
 */
export interface ScoreValidityChart {
  kind: 'validity';
  /** The S7F curve, x = the factor's ratio in [0, 1], y = validity in [0, 1]. */
  curve: ScoreChartPoint[];
  /** Where this day landed on it. */
  point: ScoreChartPoint;
  /** What the x axis measures, e.g. "share of the nominal time". */
  xLabel: string;
  caption: string;
}

/** One pilot's place on a distribution strip. */
export interface ScoreDistributionPoint {
  /** Stable key within the chart (the API's comp_pilot_id where known). */
  key: string;
  name: string;
  x: number;
  /** True for the pilot whose report card this is. */
  you: boolean;
}

/** A labelled vertical reference on a distribution. */
export interface ScoreDistributionMarker {
  x: number;
  label: string;
  /** True for the viewing pilot's own position. */
  you?: boolean;
}

/**
 * How the field's distances were spread, with the parameters that judge them.
 *
 * Distance validity asks whether the field as a whole got far enough, and its
 * formula is a ratio of areas — printing that arithmetic is honest but tells
 * a reader nothing they can picture. The strip is the picture: one dot per
 * pilot, against the minimum distance they must beat to score at all, the
 * nominal distance the day is measured against, and their own.
 *
 * A strip of individual dots rather than binned bars, matching the takeoff
 * lane on the field-analysis day profile. Bars force a bucket width, and at
 * this scale the buckets read as an arbitrary grid rather than as the shape of
 * the field — you see the container, not the data. One dot per pilot has no
 * such parameter: where the field bunched, the dots overlap and darken, and
 * "how many are near me" is answered by looking rather than by counting bars.
 */
export interface ScoreDistributionChart {
  kind: 'distribution';
  xLabel: string;
  xUnit: ScoreChartXUnit;
  /** Every flying pilot, one dot each. */
  points: ScoreDistributionPoint[];
  markers: ScoreDistributionMarker[];
  caption: string;
}

/** Any chart an explanation can carry. */
export type ScoreChart =
  | ScoreCurveChart
  | ScoreValidityChart
  | ScoreDistributionChart;

export type ScoreExplanationSectionId =
  | 'flight'
  | 'validity'
  | 'distance'
  | 'time'
  | 'leading'
  | 'arrival'
  | 'penalty'
  | 'total'
  | 'comparison';

export interface ScoreExplanationSection {
  id: ScoreExplanationSectionId;
  title: string;
  /** One-line section summary. */
  summary?: string;
  /** The points this section contributed, when it is a point component. */
  points?: number;
  /**
   * The points this component (or, on the total section, the day) had on
   * offer, so a UI can render "143.4 of 156.2 pts" and make a not-maxed
   * component scannable without reading any formula. Absent on the sections
   * it doesn't apply to (penalties, the narrative).
   */
  pointsAvailable?: number;
  /**
   * Where this pilot placed on the section's own input — "2nd fastest of 12
   * through the speed section" — pre-worded here so every UI says the same
   * thing. Ranked by the input (time, distance, coefficient, arrival order),
   * NOT by points: that is what a pilot means by the question, and it stays
   * honest when a §12.1/§12.3.5 reduction reorders the points.
   */
  rank?: string;
  /**
   * Where the site's GAP explainer covers this section, e.g.
   * `/scoring/gap#time-points`. A UI that has such a page renders it as a
   * "how this works" link on the section header; one that doesn't (the CLI)
   * ignores it. Kept here rather than in the UI so the anchor lives beside
   * the prose it complements and the two cannot drift apart.
   */
  docHref?: string;
  /**
   * This component's scoring function with the field on it. Optional
   * throughout: a UI that can't draw is unaffected, and a section returns
   * none when the curve would not explain this pilot's own points.
   */
  chart?: ScoreChart;
  items: ScoreExplanationItem[];
}

export interface ScoreExplanation {
  format: 'gap' | 'open_distance';
  /** One-sentence outcome, e.g. "Made goal in 1:42:07 — 845 points". */
  headline: string;
  /**
   * The winner's bridging sentence, shown under the headline: why the top
   * score is still short of the points on offer ("of the 1000 points on
   * offer, 46.9 went untaken — mostly time"). Set only when this pilot leads
   * the class and points were left; every other pilot's version of the
   * question is the gap to the leader, which the comparison section answers.
   */
  headlineNote?: string;
  sections: ScoreExplanationSection[];
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * The published (authoritative) score for the pilot — snake_case so the
 * competition API's PilotScoreEntry can be passed straight through.
 */
export interface ScoreEntryInput {
  /** The API's stable per-pilot id — how the charts find this pilot among the
   * class. Absent on payloads that predate the charts. */
  comp_pilot_id?: string;
  made_goal: boolean;
  reached_ess: boolean;
  /** Scored distance in metres (minimum-distance floor already applied). */
  flown_distance: number;
  speed_section_time: number | null;
  distance_points: number;
  distance_linear_points: number;
  distance_difficulty_points: number;
  time_points: number;
  leading_points: number;
  arrival_points: number;
  penalty_points: number;
  penalty_reason: string | null;
  total_score: number;
  /** Seconds started before the first start gate (S7F §12.2), when early. */
  early_start_seconds?: number | null;
  /** How the early start reshaped the score — see engine PilotScore. */
  early_start_outcome?: 'pg_launch_to_sss' | 'hg_penalty' | 'hg_min_distance' | null;
  /** Automatic jump-the-gun penalty points deducted (HG early starts). */
  jump_the_gun_penalty?: number | null;
  /** Stopped tasks (S7F §12.3.6): altitude-bonus metres folded into
   * flown_distance for a pilot still flying at the stop. */
  stopped_altitude_bonus?: number | null;
  /** The pilot's leading coefficient (S7F §11.3), lower is better — the sole
   * input to leading points. Null/absent when leading isn't scored, or on a
   * payload cached before it was published. */
  leading_coefficient?: number | null;
  /** Position in the ESS arrival order (1-based) — with the size of the ESS
   * field, the whole input to the §11.4 arrival formula. */
  arrival_position?: number | null;
  /** When the pilot reached ESS (epoch ms). What the arrival order is sorted
   * by: wall-clock time, not speed. */
  ess_time_ms?: number | null;
}

/**
 * Whole-class stopped-task outcome (S7F §12.3), as published by the
 * competition API (ClassScore.stopped). Present when the task was stopped.
 */
export interface StoppedClassInput {
  stop_time_ms: number;
  scored_window_seconds: number | null;
  minimum_run_seconds: number;
  requirement_met: boolean;
  stopped_validity: number;
  time_points_reduction: number;
  num_landed_before_stop: number;
}

/**
 * The §11.3.1 leading clock the class's coefficients were measured against,
 * as published by the competition API (ClassScore.leading_times).
 *
 * Optional like every other transparency block: a payload cached before it
 * existed simply doesn't say where the land-out tail ended.
 */
export interface LeadingTimesInput {
  /** The clock's origin: the first start gate, else the field's first start. */
  first_start_ms: number;
  /** When the last pilot reached ESS, or null when nobody did. */
  last_ess_ms: number | null;
  /** When the last landed-out pilot landed, or null when nobody landed out. */
  last_outlanding_ms: number | null;
  /** The task's goal deadline (§8.3.c), or null. */
  deadline_ms: number | null;
  /** The task stop time (§12.3.1) on a stopped task, else null. */
  stop_time_ms: number | null;
  /** maxTime = min(max(lastOutlandingTime, lastESStime), taskDeadline). */
  max_time_ms: number;
  /** Which of the times above `max_time_ms` came from. */
  max_time_source:
    | 'last_outlanding'
    | 'last_ess'
    | 'deadline'
    | 'stop'
    | 'fallback';
}

/**
 * The field-level numbers the validity and weight formulas were evaluated
 * from, as published by the competition API (ClassScore.validity_inputs).
 *
 * Optional throughout the explainer: score rows cached before this existed
 * are still served by the stale-first store, and every section that uses
 * these must degrade to the bare percentages rather than fail.
 */
export interface ValidityInputsInput {
  /** Pilots present at launch (flew + present-but-did-not-fly), S7F §9.1. */
  num_present: number;
  /** Pilots who flew — the launch-validity numerator. */
  num_flying: number;
  num_in_goal: number;
  num_reached_ess: number;
  /** Best scored distance in the class, metres. */
  best_distance: number;
  /** Best speed-section time in the class, seconds; null when nobody scored one. */
  best_time: number | null;
  /** numInGoal ÷ numFlying — the input to the weight split. */
  goal_ratio: number;
  /** The optimized task distance, metres. */
  task_distance: number;
  /** Mean of each flying pilot's distance over the minimum, metres. The
   * distance-validity ratio's numerator, pre-divided by the pilot count. */
  mean_distance_over_minimum: number;
  /** The weight fractions the available points were split by (S7F §10). */
  weights: { distance: number; time: number; leading: number; arrival: number };
}

/** One scored pilot in the class. The four fields the validity and best-in-class
 * arithmetic needs are required; the rest let the explainer compare this pilot
 * against the field, and are absent on payloads cached before they existed. */
export interface ClassPilotInput {
  /** The API's stable per-pilot id, used to tell this pilot apart from the
   * rest of the field. Absent on payloads that predate the charts. */
  comp_pilot_id?: string;
  flown_distance: number;
  speed_section_time: number | null;
  made_goal: boolean;
  reached_ess: boolean;
  pilot_name?: string;
  rank?: number;
  total_score?: number;
  distance_points?: number;
  time_points?: number;
  leading_points?: number;
  arrival_points?: number;
  /** The pilot's leading coefficient (S7F §11.3), lower is better. */
  leading_coefficient?: number | null;
  /** Position in the ESS arrival order (1-based), or null. */
  arrival_position?: number | null;
  /** When the pilot reached ESS (epoch ms), or null — what the order sorts by. */
  ess_time_ms?: number | null;
  /** Set when a HARD data-quality check withheld this pilot's tracklog: they
   * are seated at 0 and must not be read as a scored result. */
  track_excluded?: { reasons: string[] } | null;
}

/** The pilot's class context — the field the score was computed against. */
export interface ClassContextInput {
  task_validity: {
    launch: number;
    distance: number;
    time: number;
    /** Stopped-task validity (S7F §12.3.3), when the task was stopped. */
    stopped?: number;
    task: number;
  };
  available_points: {
    distance: number;
    time: number;
    leading: number;
    arrival: number;
    total: number;
  };
  /** Every scored pilot in the class (including this one). */
  pilots: ClassPilotInput[];
  /** The numbers behind the validity factors and the weight split. */
  validity_inputs?: ValidityInputsInput;
  /** The §11.3.1 leading clock, when the class scored leading points. */
  leading_times?: LeadingTimesInput;
  /** Present when the task was scored as stopped (S7F §12.3). */
  stopped?: StoppedClassInput;
}

export interface ExplainGapScoreInput {
  /**
   * The task the turnpoint sequence was resolved against — after any
   * distance-origin trim (see {@link taskForDistanceOrigin}), so that
   * `result.sequence[].taskIndex` lines up with `task.turnpoints`.
   */
  task: XCTask;
  /** The pilot's resolved turnpoint sequence (transparency data). */
  result: TurnpointSequenceResult;
  /** The published score being explained. */
  entry: ScoreEntryInput;
  /** The class the pilot was scored in. */
  classContext: ClassContextInput;
  /** The comp's GAP parameters (defaults applied for missing fields). */
  params?: Partial<GAPParameters>;
  /** Time formatter — defaults to UTC HH:MM:SS. */
  formatTime?: (d: Date) => string;
}

/** Time/altitude for an open-distance anchor when fixes aren't at hand. */
export interface OpenDistanceAnchorInfo {
  timeMs?: number;
  altitude?: number;
}

export interface ExplainOpenDistanceInput {
  /** The task (first turnpoint is the launch cylinder). */
  task: XCTask;
  /** The scored geometry, or null when the flight could not be scored. */
  geometry: OpenDistanceGeometry | null;
  /** The pilot's fixes — used to timestamp the furthest anchor. */
  fixes?: IGCFix[];
  /**
   * Anchor time/altitude supplied directly (e.g. from the competition API's
   * analysis endpoint, which has the fixes server-side). Takes precedence
   * over the `fixes` lookup.
   */
  anchorInfo?: {
    origin?: OpenDistanceAnchorInfo;
    furthest?: OpenDistanceAnchorInfo;
  };
  /** The published score being explained. */
  entry: Pick<
    ScoreEntryInput,
    'flown_distance' | 'penalty_points' | 'penalty_reason' | 'total_score'
  >;
  formatTime?: (d: Date) => string;
  /**
   * True for a manual flight (issue #306): a track-less pilot whose landing
   * point was recorded by an official. The scored line is the same
   * cylinder-edge measurement a track gets, but the endpoint is the recorded
   * landing, so the wording is adjusted and no fix times are shown.
   */
  manual?: boolean;
}

// ---------------------------------------------------------------------------
// Manual flight explanation
// ---------------------------------------------------------------------------

export interface ExplainManualFlightInput {
  /**
   * The scoring task (already trimmed for the distance origin) — the same
   * frame as `geometry.lastReachedIndex`, so turnpoint labels line up.
   */
  task: XCTask;
  /** The made-good geometry from {@link ManualFlightGeometry}. */
  geometry: ManualFlightGeometry;
  /** The published score being explained. */
  entry: ScoreEntryInput;
  /** The class the pilot was scored in. */
  classContext: ClassContextInput;
  /** The comp's GAP parameters (defaults applied for missing fields). */
  params?: Partial<GAPParameters>;
}
