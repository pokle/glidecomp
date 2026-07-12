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
  /**
   * Comp-local IANA zone (e.g. "Australia/Melbourne") for displaying times;
   * scoring runs on UTC regardless. Null until the first saved route derives
   * it from the task location (or an organizer sets it in Settings).
   */
  timezone: string | null;
  open_igc_upload: boolean;
  tasks: TaskSummary[];
  admins: Array<{ email: string; name: string }>;
  pilot_count: number;
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
  /** GAP task with a LINE goal — not supported by scoring yet, scored as a cylinder (issue #330). */
  line_goal: boolean;
}

export interface TaskDetailData {
  task_id: string;
  comp_id: string;
  name: string;
  task_date: string;
  creation_date: string;
  xctsk: XCTask | null;
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
}

export interface ClassScore {
  pilot_class: string;
  task_validity: { launch: number; distance: number; time: number; task: number };
  available_points: {
    distance: number;
    time: number;
    leading: number;
    arrival: number;
    total: number;
  };
  pilots: PilotScoreEntry[];
}

export interface TaskScoreData {
  task_id: string;
  comp_id: string;
  task_date: string;
  scoring_format: ScoringFormat;
  classes: ClassScore[];
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

/**
 * The comp/task GET right after this same session's create/update write can
 * transiently 500 (e.g. D1 lock contention under the write that just
 * happened) even though the write itself succeeded. Retry once before
 * treating it as a real failure — a 404 is left alone since that's a
 * genuine "not found", not a transient error.
 */
export async function fetchWithRetry<T extends { ok: boolean; status: number }>(
  fetcher: () => Promise<T>
): Promise<T> {
  const res = await fetcher();
  if (res.ok || res.status === 404) return res;
  await new Promise((resolve) => setTimeout(resolve, 400));
  return fetcher();
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
