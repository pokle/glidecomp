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
}

export type ScoreExplanationSectionId =
  | 'flight'
  | 'validity'
  | 'distance'
  | 'time'
  | 'leading'
  | 'arrival'
  | 'penalty'
  | 'total';

export interface ScoreExplanationSection {
  id: ScoreExplanationSectionId;
  title: string;
  /** One-line section summary. */
  summary?: string;
  /** The points this section contributed, when it is a point component. */
  points?: number;
  items: ScoreExplanationItem[];
}

export interface ScoreExplanation {
  format: 'gap' | 'open_distance';
  /** One-sentence outcome, e.g. "Made goal in 1:42:07 — 845 points". */
  headline: string;
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
}

/** The pilot's class context — the field the score was computed against. */
export interface ClassContextInput {
  task_validity: { launch: number; distance: number; time: number; task: number };
  available_points: {
    distance: number;
    time: number;
    leading: number;
    arrival: number;
    total: number;
  };
  /** Every scored pilot in the class (including this one). */
  pilots: Array<{
    flown_distance: number;
    speed_section_time: number | null;
    made_goal: boolean;
    reached_ess: boolean;
  }>;
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
