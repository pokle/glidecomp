/**
 * Shared types + helpers for the React comp detail / task detail pages.
 * Ported from src/comp-detail.ts — the shapes mirror the competition-api
 * serialisers exactly.
 */
import type {
  GAPParameters,
  TurnpointSequenceResultJSON,
  XCTask,
} from "@glidecomp/engine";

/** How a competition's tasks are scored (see competition-api migration 0009). */
export type ScoringFormat = "gap" | "open_distance";

/** How a competition's per-task scores are aggregated into scores
 * (migration 0022). "total" = sum of task scores; "ftv" = Fixed Total
 * Validity (S7F §15) — best tasks kept up to a fixed validity. */
export type SeriesScoring = "total" | "ftv";

/** Where scored distance begins (GAPParameters.distanceOrigin). Mirrors the
 * engine's DistanceOrigin; kept local so the UI needn't re-export it. */
export type DistanceOriginValue = "takeoff" | "start";

/**
 * The stored comp gap_params allow a null nominalDistance ("auto: 70% of
 * task distance"), unlike the engine type where it's always a number.
 */
export type CompGapParams = Omit<GAPParameters, "nominalDistance"> & {
  nominalDistance: number | null;
};

export interface CompDetailData {
  comp_id: string;
  name: string;
  category: string;
  creation_date: string;
  close_date: string | null;
  test: boolean;
  pilot_classes: string[];
  default_pilot_class: string;
  gap_params: CompGapParams | null;
  scoring_format: ScoringFormat;
  /** Series-scoring method for scores (migration 0022). */
  series_scoring: SeriesScoring;
  /** FTV discard fraction (0<f<1); null = auto-derive from task count. */
  ftv_factor: number | null;
  /**
   * Comp-local IANA zone (e.g. "Australia/Melbourne") for displaying times;
   * scoring runs on UTC regardless. Null until the first saved route derives
   * it from the task location (or an organizer sets it in Settings).
   */
  timezone: string | null;
  open_igc_upload: boolean;
  /** Off means only an admin can add pilots; on means a pilot joins by uploading. */
  open_registration: boolean;
  tasks: TaskSummary[];
  admins: Array<{ email: string; name: string }>;
  pilot_count: number;
  /** Size of the comp's shared waypoint set (0 when none uploaded yet). */
  waypoint_count: number;
  /** True once an admin has saved the comp's settings at least once
   * (setup-guide signal; existing comps are grandfathered as reviewed). */
  settings_reviewed: boolean;
  class_coverage_warnings: Array<{
    date: string;
    missing_classes?: string[];
    inconsistent_groupings?: boolean;
  }>;
}

export interface TaskSummary {
  task_id: string;
  name: string;
  task_date: string;
  has_xctsk: boolean;
  pilot_classes: string[];
  /** GAP task defined without an SSS-typed turnpoint (scoring falls back to the first turnpoint). */
  missing_sss: boolean;
  /** GAP task defined without an ESS-typed turnpoint (speed section falls back to goal). */
  missing_ess: boolean;
  /** GAP task with a LINE goal — informational (scored against the goal line). */
  line_goal: boolean;
  /**
   * Enough of the route to draw the task's compact diagram (TaskDiagram) in
   * the comp's task list: a trimmed XCTask carrying turnpoint coordinates,
   * radii and types plus the start direction and goal type. Null when no
   * route is set. May be absent from responses cached before it existed.
   */
  route?: XCTask | null;
}

export interface TaskDetailData {
  task_id: string;
  comp_id: string;
  name: string;
  task_date: string;
  creation_date: string;
  xctsk: XCTask | null;
  /** Stopped tasks (S7F §12.3): the recorded stop announcement time (ISO
   * UTC), or null when the task ran to completion. */
  stop_announcement_time: string | null;
  /** The organizer's free-text account of the day's conditions. Public to
   * read, comp-admin writable. Empty string when unset — never null, so no
   * caller has to distinguish "no notes" from "not loaded". */
  weather_notes: string;
  /** The organiser has closed THIS task for submissions (migration 0028).
   * Distinct from the comp's close_date, which closes everything. Organisers
   * can still upload; everyone else is refused. */
  submissions_closed: boolean;
  pilot_classes: string[];
  track_count: number;
}

export interface TrackInfo {
  task_track_id: string;
  comp_pilot_id: string;
  pilot_name: string;
  igc_pilot_name: string | null;
  pilot_class: string;
  uploaded_at: string;
  file_size: number;
  penalty_points: number;
  penalty_reason: string | null;
  uploaded_by_name: string | null;
  /** True when the uploader is someone other than the pilot the track belongs to. */
  uploaded_on_behalf: boolean;
  /** False when superseded (DNF/Absent/Present or a manual flight) — retained,
   * not scored, restorable (issue #306). */
  active: boolean;
}

/**
 * A manual flight report for a track-less pilot (issue #306) —
 * GET /api/comp/:comp_id/task/:task_id/manual-flight. `computed_distance`
 * is the engine's made-good in metres.
 */
export interface ManualFlightEntry {
  task_manual_flight_id: string;
  comp_pilot_id: string;
  pilot_name?: string;
  last_reached_tp_index: number;
  landing_lat: number;
  landing_lon: number;
  made_goal: boolean;
  duration_seconds: number | null;
  computed_distance: number;
  active: boolean;
  set_by_name: string;
  set_at: string;
}

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
  early_start_seconds?: number | null;
  /** How the early start reshaped the score. */
  early_start_outcome?: "pg_launch_to_sss" | "hg_penalty" | "hg_min_distance" | null;
  /** Automatic jump-the-gun penalty points deducted (HG early starts). */
  jump_the_gun_penalty?: number | null;
  /** Stopped tasks (S7F §12.3.6): altitude-bonus metres folded into
   * flown_distance for a pilot still flying at the stop. */
  stopped_altitude_bonus?: number | null;
  /** The pilot's leading coefficient (S7F §11.3), lower is better — the sole
   * input to leading points. Null when leading isn't scored; absent on
   * payloads cached before it was published. */
  leading_coefficient?: number | null;
  /** Position in the ESS arrival order (1-based) — with the ESS field size,
   * the whole input to the §11.4 arrival formula. Null when arrival isn't
   * scored or the pilot never reached ESS; absent on older payloads. */
  arrival_position?: number | null;
  /** When the pilot reached ESS (epoch ms). What the arrival order sorts by:
   * wall-clock time, not speed. */
  ess_time_ms?: number | null;
  /** Set when a HARD data-quality check withheld this pilot's tracklog from
   * scoring: they hold a place in the scores at 0 rather than vanishing.
   * Null/absent for every normally-scored pilot. */
  track_excluded?: { reasons: string[] } | null;
}

/** The numbers behind a class's validity factors and weight split — see the
 * API's ClassValidityInputs. Absent for open distance and on payloads cached
 * before it existed, so every consumer must degrade without it. */
export interface ClassValidityInputs {
  num_present: number;
  num_flying: number;
  num_in_goal: number;
  num_reached_ess: number;
  best_distance: number;
  best_time: number | null;
  goal_ratio: number;
  task_distance: number;
  mean_distance_over_minimum: number;
  weights: { distance: number; time: number; leading: number; arrival: number };
}

/**
 * The §11.3.1 leading clock the class's coefficients were measured against —
 * see the API's ClassLeadingTimes. `max_time_ms` is where a landed-out
 * pilot's leading graph ends, and it is the whole field's number, not the
 * pilot's: min(max(last land-out, last ESS), deadline).
 */
export interface ClassLeadingTimes {
  first_start_ms: number;
  last_ess_ms: number | null;
  last_outlanding_ms: number | null;
  deadline_ms: number | null;
  stop_time_ms: number | null;
  max_time_ms: number;
  max_time_source: "last_outlanding" | "last_ess" | "deadline" | "stop" | "fallback";
}

/** Whole-class stopped-task outcome (S7F §12.3) — see the API's ClassStoppedInfo. */
export interface ClassStoppedInfo {
  stop_time_ms: number;
  scored_window_seconds: number | null;
  minimum_run_seconds: number;
  requirement_met: boolean;
  stopped_validity: number;
  time_points_reduction: number;
  num_landed_before_stop: number;
}

export interface ClassScore {
  pilot_class: string;
  task_validity: {
    launch: number;
    distance: number;
    time: number;
    /** Stopped-task validity (S7F §12.3.3), present when the task was stopped. */
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
  pilots: PilotScoreEntry[];
  /** The numbers behind `task_validity` and the available-points split. */
  validity_inputs?: ClassValidityInputs;
  /**
   * The fully-resolved GAP parameters this class was actually scored with —
   * comp settings AND the task's own overrides (migration 0021), merged as
   * the scorer merged them, with "auto" nominal distance resolved. Prefer
   * this over re-deriving params from the comp record: on an imported
   * AirScore comp the two genuinely differ per task. Absent for open
   * distance and on payloads cached before it was published.
   */
  gap_params?: GAPParameters;
  /**
   * The §11.3.1 leading clock, when the class scored leading points: where a
   * landed-out pilot's graph was carried to, and which field time decided it.
   */
  leading_times?: ClassLeadingTimes;
  /** Present when the task was scored as stopped (S7F §12.3). */
  stopped?: ClassStoppedInfo;
}

export interface TaskScoreData {
  task_id: string;
  comp_id: string;
  task_date: string;
  scoring_format: ScoringFormat;
  class_scores: ClassScore[];
  /** ISO timestamp of when these scores were computed (stale-first store). */
  computed_at: string;
  /** True when newer inputs exist and a re-score is in flight or pending. */
  stale: boolean;
}

/** One endpoint of the scored open-distance line, with fix time/altitude.
 * time_ms / altitude are null for a manual flight (no tracklog). */
export interface OpenDistanceAnchorPointData {
  latitude: number;
  longitude: number;
  time_ms: number | null;
  altitude: number | null;
}

/**
 * Per-pilot scoring transparency from
 * GET /api/comp/:comp_id/task/:task_id/pilot/:comp_pilot_id/analysis —
 * the input to the score-details explanation, computed server-side by the
 * same engine code the scorer runs (no tracklog download needed).
 */
export interface PilotAnalysisData {
  comp_pilot_id: string;
  scoring_format: ScoringFormat;
  turnpoint_result: TurnpointSequenceResultJSON | null;
  open_distance: {
    distance: number;
    origin: OpenDistanceAnchorPointData | null;
    furthest: OpenDistanceAnchorPointData | null;
  } | null;
  /** Manual flight geometry for a track-less pilot (issue #306); indices in
   * the scoring (distance-origin-trimmed) frame. Null for tracked pilots. */
  manual_flight: {
    last_reached_tp_index: number;
    landing: { lat: number; lon: number };
    made_good: number;
    distance_to_goal: number;
    made_goal: boolean;
    route_to_goal: Array<{ lat: number; lon: number }>;
  } | null;
  /** What the engine's altitude plausibility pass repaired in this pilot's
   * track — disclosed on the score-details page. Null for manual flights;
   * may be absent in payloads cached before the field existed. */
  altitude_cleaning?: AltitudeCleaningData | null;
  /** What the data-quality checks made of this tracklog. Findings empty when
   * clean. Null for manual flights; may be absent in payloads cached before
   * the field existed. */
  track_quality?: TrackQualityData | null;
}

/** Wire shape of the engine's TrackQualityReport (track-quality.ts). */
export interface TrackQualityData {
  hardFailed: boolean;
  findings: Array<{
    id: string;
    severity: "hard" | "soft";
    title: string;
    /** The reader's sentence, rendered server-side so SSR and the client
     * agree byte for byte. */
    detail: string;
  }>;
}

/** Wire shape of the engine's AltitudeCleaningReport. */
export interface AltitudeCleaningData {
  totalFixCount: number;
  repairedFixCount: number;
  crossChecked: boolean;
  ranges: Array<{
    startIndex: number;
    endIndex: number;
    startTimeMs: number;
    endTimeMs: number;
    fixCount: number;
    maxCorrectionMeters: number;
    method: "cross-channel" | "rate";
  }>;
}

export interface AuditEntry {
  audit_id: number;
  timestamp: string;
  actor_name: string;
  subject_type: "comp" | "task" | "pilot" | "track";
  subject_id: string | null;
  subject_name: string | null;
  description: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  has_more: boolean;
  next_before: number | null;
}

export interface PilotStatusEntry {
  task_pilot_status_id: string;
  task_id: string;
  comp_pilot_id: string;
  pilot_name: string;
  status_key: string;
  status_label: string;
  note: string | null;
  set_by_name: string;
  set_at: string;
}

/** Minimal pilot shape used by the roll call and behalf-upload dropdowns. */
export interface PilotListEntry {
  comp_pilot_id: string;
  name: string;
  linked_email: string | null;
  pilot_class: string;
}

const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 400;

/**
 * The comp/task GET right after this same session's create/update write can
 * transiently 500 (e.g. D1 lock contention under the write that just
 * happened) even though the write itself succeeded. Retry before treating it
 * as a real failure.
 *
 * Only 5xx and dropped requests are retried. **Every 4xx is a real answer** and
 * is handed straight back: the server understood the request and declined it,
 * and asking twice more changes nothing. This used to read
 * `res.ok || res.status === 404` — 404 was the only 4xx spared, so a 401, a 403
 * or the 429 an API key gets when rate-limited cost three round trips and two
 * delays before returning the same verdict, and the retries pushed a
 * rate-limited caller further past its limit.
 *
 * A *dropped* request is retried too (issue #481). It used to escape as a
 * rejected promise: every caller wraps this in a try/catch that renders
 * "Competition not found", so a blip on the way to the API was reported to
 * the user as a missing competition — and stayed that way, since nothing
 * re-fetches.
 *
 * `signal` is for callers that supersede their own requests — the search box
 * types a new query over an old one. An abort is a decision, not a blip, so it
 * ends the retries immediately instead of costing three attempts and two
 * delays before the caller throws the answer away regardless.
 */
export async function fetchWithRetry<T extends { ok: boolean; status: number }>(
  fetcher: () => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  let lastRes: T | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
    }
    try {
      const res = await fetcher();
      if (res.status < 500) return res;
      lastRes = res;
    } catch (err) {
      if (options.signal?.aborted) throw err;
      lastErr = err;
    }
  }
  // Out of attempts. Prefer handing back the last real response — callers
  // read its status — and only re-raise when every attempt was dropped.
  if (lastRes !== undefined) return lastRes;
  throw lastErr;
}

export async function compressIgc(file: File): Promise<ArrayBuffer> {
  const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/**
 * Treat close_date as end-of-day local time (a date like "2026-12-31"
 * parsed by new Date() is midnight UTC, which is already past in UTC+
 * timezones).
 */
export function isPastCloseDate(closeDate: string | null): boolean {
  return (
    closeDate != null && closeDate !== "" && new Date() > new Date(closeDate + "T23:59:59")
  );
}

/** Relative time for audit entries, switching to a plain date after 30 days. */
export function formatAuditTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
