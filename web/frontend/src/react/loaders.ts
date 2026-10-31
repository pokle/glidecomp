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
import type {
  CompAnalysisData,
  TaskAnalysisData,
} from "./analysis/types";
import type { WaypointFileRecord } from "@glidecomp/engine";
import type { AuditEntry, AuditResponse } from "./comp/types";
import { todayInZone } from "./lib/format";
import { fetchWithRetry, retry } from "./lib/retry";

export type FetchFn = (path: string, init?: RequestInit) => Promise<Response>;

/** Three months — the ceiling on how long a stable page may be cached. */
export const MAX_PUBLIC_MAX_AGE_S = 90 * 24 * 60 * 60;

/**
 * Age-based cache lifetime (seconds) for a materialized, stale-first SSR page.
 * Mirror of the worker's score-store.ts:publicMaxAgeSeconds — keep them in
 * step. A page whose scores/analysis have sat unchanged for a while is
 * unlikely to change soon, so shared caches may hold it for roughly as long as
 * it has already been stable (now − computedAt), capped at three months. A
 * stale or not-yet-computed page gets 0: it must be revalidated every time.
 */
export function publicMaxAgeSeconds(
  computedAt: string | null,
  stale: boolean,
  nowMs: number
): number {
  if (stale || !computedAt) return 0;
  const ageMs = nowMs - Date.parse(computedAt);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 0;
  return Math.min(Math.floor(ageMs / 1000), MAX_PUBLIC_MAX_AGE_S);
}

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
export type { CompListEntry } from "./comp/types";
import type { CompListEntry } from "./comp/types";

export interface CompetitionsLoaderData {
  comps: CompListEntry[];
}

export function loadCompetitions(f: FetchFn): Promise<CompetitionsLoaderData> {
  return getJson<CompetitionsLoaderData>(f, "/api/comp");
}

// ── /comp/:compId ────────────────────────────────────────────────────────────

export type { CompScores } from "./comp/types";
import type { CompScores } from "./comp/types";


export interface CompDetailLoaderData {
  comp: CompDetailData;
  /** null when scores are unavailable (no scored tasks yet, or a transient error). */
  scores: CompScores | null;
  scoresEtag: string | null;
  /** "today" as YYYY-MM-DD in the comp timezone, computed server-side so that
   *  "has this comp finished flying?" — which decides whether the scores or
   *  the tasks lead the page — is deterministic across server and client. */
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
  // Compute "today" here (it needs the comp's own timezone) so it is a single
  // value baked into the SSR HTML and reused by the client on hydration.
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

// ── /comp/:compId/scores.pdf ─────────────────────────────────────────────────

/** One task as the results record shows it: its route and its scores. */
export interface ResultsRecordTask {
  task: TaskDetailData;
  /** null when the task has no route, so nothing was scored. */
  score: TaskScoreData | null;
}

export interface ResultsRecordLoaderData {
  comp: CompDetailData;
  /** null when no task has been scored yet. */
  scores: CompScores | null;
  /** Every task, in the comp's own order. */
  tasks: ResultsRecordTask[];
  /** The comp's audit log, newest first. */
  audit: AuditEntry[];
  /** True when the log was longer than the record carries (AUDIT_MAX_PAGES). */
  auditTruncated: boolean;
}

/** 200 entries a page (the route's maximum) × 50 pages = 10,000 entries. */
const AUDIT_PAGE_SIZE = 200;
const AUDIT_MAX_PAGES = 50;

/**
 * Everything the results record (`/comp/:id/scores.pdf`) prints: the comp,
 * its scores, every task's route and per-class results, and the audit log.
 *
 * Unlike the page loaders, a missing piece is NOT degraded to an empty
 * section. The file is a record someone keeps, so a task whose scores failed
 * to load must fail the whole export rather than leave a record that quietly
 * lacks a day (issue #481: a failure to ask is not an answer). Every request
 * goes through `fetchWithRetry` first, which retries a 5xx or a dropped
 * request and hands a 4xx straight back.
 */
export async function loadResultsRecord(
  f: FetchFn,
  compId: string
): Promise<ResultsRecordLoaderData> {
  const cid = encodeURIComponent(compId);
  const get = (path: string) => fetchWithRetry(() => f(path));

  const compRes = await get(`/api/comp/${cid}`);
  if (compRes.status === 404 || compRes.status === 400) throw new NotFoundError(`/api/comp/${cid}`);
  if (!compRes.ok) throw new Error(`/api/comp/${cid} -> ${compRes.status}`);
  const comp = (await compRes.json()) as CompDetailData;

  const [scores, tasks, auditLog] = await Promise.all([
    (async () => {
      const res = await get(`/api/comp/${cid}/scores`);
      // 404 here means "no scored task yet" for a comp that does exist.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`/api/comp/${cid}/scores -> ${res.status}`);
      return (await res.json()) as CompScores;
    })(),
    Promise.all(
      comp.tasks.map(async (summary): Promise<ResultsRecordTask> => {
        const tid = encodeURIComponent(summary.task_id);
        const [taskRes, scoreRes] = await Promise.all([
          get(`/api/comp/${cid}/task/${tid}`),
          summary.has_xctsk ? get(`/api/comp/${cid}/task/${tid}/score`) : null,
        ]);
        if (!taskRes.ok) throw new Error(`task ${summary.task_id} -> ${taskRes.status}`);
        const task = (await taskRes.json()) as TaskDetailData;
        // 422 is the route's own "this task has no route" — a real answer.
        if (!scoreRes || scoreRes.status === 422) return { task, score: null };
        if (!scoreRes.ok) throw new Error(`task ${summary.task_id} score -> ${scoreRes.status}`);
        return { task, score: (await scoreRes.json()) as TaskScoreData };
      })
    ),
    (async () => {
      const entries: AuditEntry[] = [];
      let before: number | null = null;
      for (let page = 0; page < AUDIT_MAX_PAGES; page++) {
        const query: string =
          `limit=${AUDIT_PAGE_SIZE}` + (before != null ? `&before=${before}` : "");
        const res = await get(`/api/comp/${cid}/audit?${query}`);
        if (!res.ok) throw new Error(`/api/comp/${cid}/audit -> ${res.status}`);
        const body = (await res.json()) as AuditResponse;
        entries.push(...body.entries);
        if (!body.has_more || body.next_before == null) return { entries, truncated: false };
        before = body.next_before;
      }
      return { entries, truncated: true };
    })(),
  ]);

  return {
    comp,
    scores,
    tasks,
    audit: auditLog.entries,
    auditTruncated: auditLog.truncated,
  };
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
  // Four concurrent DB-backed calls; retry each through a transient D1 blip so
  // one hiccup doesn't 404 the whole page (see lib/retry). This page is always
  // reached via a link that had the pilot, so retrying even a 404 is safe.
  const [comp, task, score, analysis] = await Promise.all([
    retry(() => getJson<CompDetailData>(f, `/api/comp/${cid}`)),
    retry(() => getJson<TaskDetailData>(f, `/api/comp/${cid}/task/${tid}`)),
    retry(() => getJson<TaskScoreData>(f, `/api/comp/${cid}/task/${tid}/score`)),
    retry(() =>
      getJson<PilotAnalysisData>(
        f,
        `/api/comp/${cid}/task/${tid}/pilot/${pid}/analysis`
      )
    ),
  ]);
  return { comp, task, score, analysis };
}

// ── /comp/:compId/analysis ───────────────────────────────────────────────────

export interface CompAnalysisLoaderData {
  /** GET /api/comp/:id/analysis — the aggregate, or a pending placeholder
   *  (pending_task_count > 0) while the first per-task computes run. */
  analysis: CompAnalysisData;
  analysisEtag: string | null;
  /** null when the comp fetch fails (cosmetic — name + timezone only). */
  comp: CompDetailData | null;
}

export async function loadCompAnalysis(
  f: FetchFn,
  compId: string
): Promise<CompAnalysisLoaderData> {
  const cid = encodeURIComponent(compId);
  const [analysisRes, compRes] = await Promise.all([
    f(`/api/comp/${cid}/analysis`),
    f(`/api/comp/${cid}`),
  ]);
  // 404/400 (missing, or a test comp hidden from this visitor) → real 404.
  if (analysisRes.status === 404 || analysisRes.status === 400)
    throw new NotFoundError(`/api/comp/${cid}/analysis`);
  if (!analysisRes.ok) throw new Error(`task-analysis -> ${analysisRes.status}`);
  const analysis = (await analysisRes.json()) as CompAnalysisData;
  const analysisEtag = analysisRes.headers.get("ETag");
  const comp = compRes.ok ? ((await compRes.json()) as CompDetailData) : null;
  return { analysis, analysisEtag, comp };
}

// ── /comp/:compId/task/:taskId/analysis ──────────────────────────────────────

export interface TaskAnalysisLoaderData {
  /** GET /api/comp/:id/task/:id/analysis. A warm report, a `pending`
   *  placeholder (cold — a background compute was just scheduled), or an
   *  `error` body (422: the task has no route to analyse). */
  analysis: TaskAnalysisData;
  analysisEtag: string | null;
  /** null when the fetch fails (cosmetic — heading + breadcrumb names). */
  task: TaskDetailData | null;
  comp: CompDetailData | null;
}

export async function loadTaskAnalysis(
  f: FetchFn,
  compId: string,
  taskId: string
): Promise<TaskAnalysisLoaderData> {
  const cid = encodeURIComponent(compId);
  const tid = encodeURIComponent(taskId);
  const [analysisRes, taskRes, compRes] = await Promise.all([
    f(`/api/comp/${cid}/task/${tid}/analysis`),
    f(`/api/comp/${cid}/task/${tid}`),
    f(`/api/comp/${cid}`),
  ]);
  if (analysisRes.status === 404 || analysisRes.status === 400)
    throw new NotFoundError(`/api/comp/${cid}/task/${tid}/analysis`);
  let analysis: TaskAnalysisData;
  if (analysisRes.status === 422) {
    // Task exists but has no route to analyse — a real, renderable page (the
    // "No analysis for this task" state), not a 404. Mirror the client fetch.
    const body = (await analysisRes.json()) as { error?: string };
    analysis = {
      task_id: taskId,
      comp_id: compId,
      classes: [],
      computed_at: null,
      stale: false,
      pending: false,
      error: body.error ?? "This task cannot be analysed",
    };
  } else if (!analysisRes.ok) {
    throw new Error(`task-analysis -> ${analysisRes.status}`);
  } else {
    analysis = (await analysisRes.json()) as TaskAnalysisData;
  }
  const analysisEtag = analysisRes.headers.get("ETag");
  const task = taskRes.ok ? ((await taskRes.json()) as TaskDetailData) : null;
  const comp = compRes.ok ? ((await compRes.json()) as CompDetailData) : null;
  return { analysis, analysisEtag, task, comp };
}
