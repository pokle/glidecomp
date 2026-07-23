/**
 * Route loaders for the public SSR routes. Each is parameterized by a
 * `FetchFn` so the same code runs on the server (over the COMPETITION_API
 * service binding, forwarding the visitor's cookie) and in the browser
 * (window.fetch with credentials). Loaders fetch raw string paths — not the
 * Hono client — so they stay origin-agnostic (the server has no page origin).
 *
 * The returned shapes mirror what each page already fetches in useEffect, so a
 * page can seed its state from a loader result and render identically to its
 * post-fetch state (see lib/initial-data.tsx).
 */
import type {
  CompDetailData,
  TaskDetailData,
  TaskScoreData,
  PilotAnalysisData,
} from "./comp/types";
import type { WaypointFileRecord } from "@glidecomp/engine";
import type { ClassStanding, TaskInfo } from "../scores-views";
import { todayInZone } from "./lib/format";

export type FetchFn = (path: string, init?: RequestInit) => Promise<Response>;

/** Thrown when an upstream API returns 404 so the SSR layer can emit a real 404. */
export class NotFoundError extends Error {
  constructor(path: string) {
    super(`Not found: ${path}`);
    this.name = "NotFoundError";
  }
}

async function getJson<T>(f: FetchFn, path: string): Promise<T> {
  const res = await f(path);
  // 404 = missing (or a test comp hidden from this visitor); 400 = an
  // undecodable id sqid ("Invalid comp_id"). Both mean "no such page" for these
  // by-id GETs, so surface a real 404 rather than the generic error fallback.
  if (res.status === 404 || res.status === 400) throw new NotFoundError(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

// ── /comp ──────────────────────────────────────────────────────────────────

/** One row of GET /api/comp (presentational fields only). */
export interface CompListEntry {
  comp_id: string;
  name: string;
  category: string;
  creation_date: string;
  pilot_classes: string[];
  scoring_format?: string;
  is_admin: boolean;
  test: boolean;
  first_task_date: string | null;
  last_task_date: string | null;
}

export interface CompetitionsLoaderData {
  comps: CompListEntry[];
}

export function loadCompetitions(f: FetchFn): Promise<CompetitionsLoaderData> {
  return getJson<CompetitionsLoaderData>(f, "/api/comp");
}

// ── /comp/:compId ────────────────────────────────────────────────────────────

/** GET /api/comp/:id/scores — whole-comp standings (see CompScoresSection). */
export interface CompScores {
  comp_id: string;
  tasks: TaskInfo[];
  standings: ClassStanding[];
  computed_at: string | null;
  stale: boolean;
}

export interface CompDetailLoaderData {
  comp: CompDetailData;
  /** null when scores are unavailable (no scored tasks yet, or a transient error). */
  scores: CompScores | null;
  scoresEtag: string | null;
  /** "today" as YYYY-MM-DD in the comp timezone, computed server-side so the
   *  today's-task hero selection is deterministic across server and client. */
  today: string;
}

export async function loadCompDetail(
  f: FetchFn,
  compId: string
): Promise<CompDetailLoaderData> {
  const [comp, scoresRes] = await Promise.all([
    getJson<CompDetailData>(f, `/api/comp/${encodeURIComponent(compId)}`),
    f(`/api/comp/${encodeURIComponent(compId)}/scores`),
  ]);
  let scores: CompScores | null = null;
  let scoresEtag: string | null = null;
  if (scoresRes.ok) {
    scores = (await scoresRes.json()) as CompScores;
    scoresEtag = scoresRes.headers.get("ETag");
  }
  // Compute the hero's "today" here (needs the comp's own timezone) so it is a
  // single value baked into the SSR HTML and reused by the client on hydration.
  return { comp, scores, scoresEtag, today: todayInZone(comp.timezone) };
}

// ── /comp/:compId/scores ─────────────────────────────────────────────────────

export interface CompScoresLoaderData {
  comp: CompDetailData;
  /** null when scores are unavailable (no scored tasks yet, or a transient error). */
  scores: CompScores | null;
  scoresEtag: string | null;
}

export async function loadCompScores(
  f: FetchFn,
  compId: string
): Promise<CompScoresLoaderData> {
  const cid = encodeURIComponent(compId);
  const [comp, scoresRes] = await Promise.all([
    getJson<CompDetailData>(f, `/api/comp/${cid}`),
    f(`/api/comp/${cid}/scores`),
  ]);
  let scores: CompScores | null = null;
  let scoresEtag: string | null = null;
  if (scoresRes.ok) {
    scores = (await scoresRes.json()) as CompScores;
    scoresEtag = scoresRes.headers.get("ETag");
  }
  return { comp, scores, scoresEtag };
}

// ── /comp/:compId/waypoints ──────────────────────────────────────────────────

export interface CompWaypointsLoaderData {
  /** GET /api/comp/:id — the API adds a server-computed `is_admin` flag. */
  comp: CompDetailData & { is_admin?: boolean };
  waypoints: WaypointFileRecord[];
}

export async function loadCompWaypoints(
  f: FetchFn,
  compId: string
): Promise<CompWaypointsLoaderData> {
  const cid = encodeURIComponent(compId);
  const [comp, wpRes] = await Promise.all([
    getJson<CompDetailData & { is_admin?: boolean }>(f, `/api/comp/${cid}`),
    f(`/api/comp/${cid}/waypoints`),
  ]);
  // The waypoint set is non-critical: a failed fetch renders the empty state.
  const waypoints = wpRes.ok
    ? ((await wpRes.json()) as { waypoints: WaypointFileRecord[] }).waypoints
    : [];
  return { comp, waypoints };
}

// ── /comp/:compId/task/:taskId ───────────────────────────────────────────────

export interface TaskDetailLoaderData {
  task: TaskDetailData;
  /** null when the comp fetch fails (non-critical — used for the admin check + name). */
  comp: CompDetailData | null;
  /** null when scores are unavailable. */
  score: TaskScoreData | null;
}

export async function loadTaskDetail(
  f: FetchFn,
  compId: string,
  taskId: string
): Promise<TaskDetailLoaderData> {
  const cid = encodeURIComponent(compId);
  const tid = encodeURIComponent(taskId);
  const [task, compRes, scoreRes] = await Promise.all([
    getJson<TaskDetailData>(f, `/api/comp/${cid}/task/${tid}`),
    f(`/api/comp/${cid}`),
    f(`/api/comp/${cid}/task/${tid}/score`),
  ]);
  const comp = compRes.ok ? ((await compRes.json()) as CompDetailData) : null;
  const score = scoreRes.ok ? ((await scoreRes.json()) as TaskScoreData) : null;
  return { task, comp, score };
}

// ── /comp/:compId/task/:taskId/pilot/:pilotId ────────────────────────────────

export interface PilotScoreLoaderData {
  comp: CompDetailData;
  task: TaskDetailData;
  score: TaskScoreData;
  analysis: PilotAnalysisData;
}

export async function loadPilotScoreDetail(
  f: FetchFn,
  compId: string,
  taskId: string,
  pilotId: string
): Promise<PilotScoreLoaderData> {
  const cid = encodeURIComponent(compId);
  const tid = encodeURIComponent(taskId);
  const pid = encodeURIComponent(pilotId);
  const [comp, task, score, analysis] = await Promise.all([
    getJson<CompDetailData>(f, `/api/comp/${cid}`),
    getJson<TaskDetailData>(f, `/api/comp/${cid}/task/${tid}`),
    getJson<TaskScoreData>(f, `/api/comp/${cid}/task/${tid}/score`),
    getJson<PilotAnalysisData>(
      f,
      `/api/comp/${cid}/task/${tid}/pilot/${pid}/analysis`
    ),
  ]);
  return { comp, task, score, analysis };
}
