/**
 * The shapes the scoring path produces and consumes.
 *
 * Kept free of imports from the rest of `scoring/` so the geometry-hash
 * builders can describe what they hash without depending on the resolver that
 * produces it (which in turn depends on them).
 */

import type {
  XCTask,
  TrackQualityContext,
  TrackQualityReport,
  GAPParameters,
  LeadingAggregate,
  StopResolutionOptions,
  resolveTaskStop,
} from "@glidecomp/engine";

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface PilotScoreEntry {
  rank: number;
  comp_pilot_id: string;
  pilot_name: string;
  made_goal: boolean;
  reached_ess: boolean;
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
  early_start_seconds: number | null;
  /** How the early start reshaped the score — see engine PilotScore. */
  early_start_outcome: "pg_launch_to_sss" | "hg_penalty" | "hg_min_distance" | null;
  /** Automatic jump-the-gun penalty points deducted (HG early starts). */
  jump_the_gun_penalty: number | null;
  /** Stopped tasks (S7F §12.3.6): altitude-bonus metres folded into
   * flown_distance for a pilot still flying at the stop. Null otherwise. */
  stopped_altitude_bonus: number | null;
  /**
   * The pilot's leading coefficient (S7F §11.3) — lower is better. It is the
   * sole input to leading points, and without it the score-details page can
   * only assert the points rather than show where they came from. Null when
   * the competition doesn't score leading, and on an excluded pilot.
   */
  leading_coefficient: number | null;
  /**
   * Where the pilot came in the ESS arrival order (1-based) — with
   * `validity_inputs.num_reached_ess`, the whole input to the §11.4 arrival
   * formula. Null when arrival isn't scored or the pilot never reached ESS.
   */
  arrival_position: number | null;
  /**
   * When the pilot reached the end of the speed section (epoch ms), or null.
   * This is what the arrival order is sorted by — WALL-CLOCK time, not speed
   * — so publishing it lets a reader check the order rather than trust it,
   * and makes a tie visible instead of implying an order the data can't
   * support.
   */
  ess_time_ms: number | null;
  /**
   * Set when this pilot's tracklog failed a HARD data-quality check
   * (track-quality.ts) and was withheld from scoring: they hold a place in
   * the standings at 0 rather than vanishing from the results. Null for every
   * normally-scored pilot.
   */
  track_excluded?: { reasons: string[] } | null;
}

/** A pilot whose tracklog was withheld from scoring, to be seated last. */
export interface ExcludedPilot {
  comp_pilot_id: number;
  pilot_name: string;
  reasons: string[];
}

/** Whole-class stopped-task outcome (S7F §12.3) — see engine StoppedTaskScore. */
export interface ClassStoppedInfo {
  stop_time_ms: number;
  scored_window_seconds: number | null;
  minimum_run_seconds: number;
  requirement_met: boolean;
  stopped_validity: number;
  time_points_reduction: number;
  num_landed_before_stop: number;
}

/**
 * The field-level numbers the validity factors and the weight split were
 * computed from — everything `calculateTaskValidity` and `calculateWeights`
 * were handed, so a reader can check the percentages rather than take them
 * on trust.
 *
 * GAP only: open distance hardcodes every validity at 1, so there is nothing
 * to show and the field is absent.
 */
export interface ClassValidityInputs {
  /** Pilots present at launch (flew + present-but-did-not-fly), S7F §9.1. */
  num_present: number;
  num_flying: number;
  num_in_goal: number;
  num_reached_ess: number;
  best_distance: number;
  best_time: number | null;
  goal_ratio: number;
  task_distance: number;
  /** Mean of each flying pilot's distance over the minimum, metres — the
   * distance-validity ratio's numerator, already divided by the pilot count. */
  mean_distance_over_minimum: number;
  weights: { distance: number; time: number; leading: number; arrival: number };
}

export interface ClassScore {
  pilot_class: string;
  task_validity: { launch: number; distance: number; time: number; task: number; stopped?: number };
  available_points: { distance: number; time: number; leading: number; arrival: number; total: number };
  pilots: PilotScoreEntry[];
  /** The numbers behind `task_validity` and the available-points split. */
  validity_inputs?: ClassValidityInputs;
  /**
   * The fully-resolved GAP parameters this class was actually scored with —
   * per-category defaults, the comp's saved settings, and the task's own
   * overrides (migration 0021), merged exactly as the scorer merged them,
   * with "auto" nominal distance already resolved.
   *
   * Published so the score-details page can name the formula that scored the
   * task instead of re-deriving one from the comp record alone: on an
   * imported AirScore comp the two genuinely differ per task, and the page
   * was printing prose about a formula the task wasn't scored with.
   * Absent for open distance, which ignores GAP parameters entirely.
   */
  gap_params?: GAPParameters;
  /** Present when the task was scored as stopped (S7F §12.3). */
  stopped?: ClassStoppedInfo;
}

export interface TaskScoreResponse {
  task_id: string;
  comp_id: string;
  task_date: string;
  /** How the task was scored — lets the UI pick the right columns. */
  scoring_format: "gap" | "open_distance";
  classes: ClassScore[];
}

// ---------------------------------------------------------------------------
// Resolved scoring inputs
// ---------------------------------------------------------------------------

/** The task + comp columns every scoring path reads, with the task's GAP
 * overrides already merged over the comp's (see `mergeStoredGapParamsJson`). */
export interface ScoringTaskRow {
  task_id: number;
  comp_id: number;
  task_date: string;
  category: string;
  timezone: string | null;
  xctsk: string;
  stop_announcement_time: string | null;
  gap_params: string | null;
  scoring_format: string | null;
  creation_date: string;
}

/**
 * Everything that shapes HOW a task is scored, derived from one D1 row.
 *
 * Deliberately separate from {@link TaskScoringConfig}: this half is a pure
 * function of the task + comp record, so the per-pilot transparency endpoint
 * can resolve exactly the parameters the scorer used without also paying for
 * the roster, the track list and the stored quality verdicts it has no use
 * for. Both halves come from one implementation, so the two can never drift —
 * which matters most for the geometry hashes keyed off these fields (see
 * geom-hash.ts).
 */
export interface TaskScoringGeometry {
  taskRow: ScoringTaskRow;
  xcTask: XCTask;
  /** xcTask trimmed by the distance-origin convention — what scoreFlights sees. */
  scoringTask: XCTask;
  scoringFormat: "gap" | "open_distance";
  category: "hg" | "pg";
  gapParams: Partial<GAPParameters>;
  fullGapParams: GAPParameters;
  distanceOrigin: GAPParameters["distanceOrigin"];
  useLeading: boolean;
  leadingFormula: GAPParameters["leadingFormula"];
  stopCtx: ReturnType<typeof resolveTaskStop> | null;
  stopBase: StopResolutionOptions | null;
}

/** One active, scoreable track row joined with its pilot. */
export interface ScoredTrackRow {
  task_track_id: number;
  comp_pilot_id: number;
  igc_filename: string;
  uploaded_at: string;
  penalty_points: number;
  penalty_reason: string | null;
  pilot_name: string;
  pilot_class: string;
  /** 1 when a scorekeeper has ruled this track valid despite a HARD
   * data-quality finding (S7A §4.4.6 makes rejection the organiser's call,
   * so the automatic verdict must be overridable). */
  quality_override: number;
}

/**
 * Per-track data-quality verdicts (engine track-quality.ts), by task_track_id.
 *
 * A MUTABLE memo, and the same "pass cfg through so both passes provably
 * agree" contract as the rest of {@link TaskScoringConfig}:
 * resolveTaskScoringConfig seeds it from track_analysis (pure D1, no R2),
 * computeTaskScore fills the misses — it is the only pass that already has the
 * parsed IGC in hand — and computeTaskFieldAnalysis reads it afterwards for
 * free, because it calls computeTaskScore first. A track absent from
 * `byTrackId` has an UNKNOWN verdict, never an assumed-good one.
 */
export interface TaskQualityMemo {
  geomHash: string;
  byTrackId: Map<number, TrackQualityReport>;
  context: TrackQualityContext;
}

/**
 * Everything that shapes how a task is scored, resolved from D1 once — the
 * geometry plus the field it is scored over.
 *
 * Extracted so the field-analysis path (computeTaskFieldAnalysis) provably
 * scores against the SAME parameters as the published scores. Without a
 * shared resolution the two would drift silently the first time someone
 * touched the GAP defaults, and the analysis would correlate its metrics
 * against ranks nobody recognises.
 */
export interface TaskScoringConfig extends TaskScoringGeometry {
  scoredClasses: Set<string>;
  scoredTracks: ScoredTrackRow[];
  /** Per class: pilots marked DNF with neither a track nor a manual flight. */
  dnfByClass: Map<string, number>;
  quality: TaskQualityMemo;
}

/** Per-track analysis stored in D1 (`track_analysis`, variant "gap") — the
 * field-independent result of resolving one pilot's turnpoint sequence.
 * Keyed by task geometry + track identity, so it survives roster/penalty
 * edits and (crucially) new track submissions: only the newly-added track
 * misses the store, the rest of the field is reused instead of being
 * re-fetched, re-parsed and re-resolved.
 * Plain numbers/booleans only, so JSON round-trips losslessly.
 *
 * This is the backend's OWN storage shape, assembled field by field and
 * deliberately FLAT — it is not FlightScoringData. The engine's leading input
 * is a discriminated union; the two are converted at the boundary in
 * task-score.ts, so the union never reaches D1 and the stored rows need no
 * revive step. */
export interface CachedFlightAnalysis {
  flownDistance: number;
  madeGoal: boolean;
  reachedESS: boolean;
  speedSectionTime: number | null;
  sssTimeMs: number | null;
  essTimeMs: number | null;
  /** Seconds started before the first gate (S7F §12.2), when early. */
  earlyStartSeconds?: number;
  /** Official start time (gate-snapped in a gated race), epoch ms. Feeds the
   * stopped-task scored-window arithmetic (S7F §12.3.4). Absent in rows
   * cached before stopped tasks shipped — sssTimeMs is the fallback. */
  startTimeMs?: number | null;
  /** Stopped tasks: pilot landed before the stop (feeds §12.3.3 validity). */
  landedBeforeStop?: boolean;
  /** Stopped tasks: §12.3.6 altitude bonus folded into flownDistance (m). */
  stoppedAltitudeBonus?: number;
  /** Present only for leading-enabled comps — the per-track leading scan,
   * cached so a new upload doesn't force a re-scan of the whole field. Its
   * validity is tied to the task geometry + leading formula in the cache key. */
  leadingAggregate?: LeadingAggregate;
}
