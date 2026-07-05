/**
 * Shared types + helpers for the React comp detail / task detail pages.
 * Ported from src/comp-detail.ts — the shapes mirror the competition-api
 * serialisers exactly.
 */
import type { GAPParameters, XCTask } from "@glidecomp/engine";

/** How a competition's tasks are scored (see competition-api migration 0009). */
export type ScoringFormat = "gap" | "open_distance";

export interface PilotStatusConfig {
  key: string;
  label: string;
  on_track_upload: "none" | "clear" | "set";
}

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
  open_igc_upload: boolean;
  pilot_statuses: PilotStatusConfig[];
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

/**
 * Slugify a human label into a stable ASCII key for pilot_statuses.
 * Matches the validator regex: lowercase letters/digits/underscores.
 */
export function slugifyStatusKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
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
