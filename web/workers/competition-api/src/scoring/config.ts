/**
 * Resolving a task's scoring inputs from D1 — the single place that decides
 * WHICH parameters, WHICH route and WHICH field a task is scored with.
 *
 * Two entry points over one implementation:
 *
 * - {@link resolveTaskGeometry} — the parameters alone, from one D1 row. What
 *   the per-pilot transparency endpoint needs, and all it should pay for.
 * - {@link resolveTaskScoringConfig} — the geometry plus the roster, the
 *   tracks, the scored classes, the DNF counts and the stored quality
 *   verdicts. What the scorer and the field analysis need.
 *
 * Anything that resolves these by hand instead will drift the moment somebody
 * touches the GAP defaults, and the drift is silent.
 */

import {
  parseXCTask,
  taskForDistanceOrigin,
  calculateOptimizedTaskDistance,
  resolveCompGapParams,
  resolveTaskStop,
  resolveGoalAltitude,
  stoppedGlideRatio,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type StopResolutionOptions,
  type TrackQualityContext,
  type TrackQualityReport,
} from "@glidecomp/engine";
import { qualityGeomHash } from "./geom-hash";
import { loadTrackAnalyses } from "./track-store";
import type {
  ExcludedPilot,
  ScoredTrackRow,
  ScoringTaskRow,
  TaskQualityMemo,
  TaskScoringConfig,
  TaskScoringGeometry,
} from "./types";

/**
 * Merge a task's stored GAP-parameter overrides over the comp's stored
 * params, returning the combined JSON (or null when neither stored any).
 *
 * task.gap_params (migration 0021) exists for imported AirScore history,
 * where the published formula varies per task inside one comp (nominal
 * distances per class, departure/arrival flags per task). Task values win
 * field-by-field; a field no task pinned still follows the comp settings
 * dialog. Every scoring read path merges through here so the published
 * score, the transparency narrative, the field analysis and the 3D pack
 * all resolve identical parameters.
 */
export function mergeStoredGapParamsJson(
  compJson: string | null,
  taskJson: string | null
): string | null {
  if (!taskJson) return compJson;
  if (!compJson) return taskJson;
  return JSON.stringify({ ...JSON.parse(compJson), ...JSON.parse(taskJson) });
}

/** Load the task + comp row every scoring path starts from, with the task's
 * GAP overrides already merged over the comp's. Null when the task doesn't
 * exist or carries no route to score against. */
async function loadScoringTaskRow(
  taskId: number,
  db: D1Database
): Promise<ScoringTaskRow | null> {
  const taskRow = await db
    .prepare(
      `SELECT t.task_id, t.comp_id, t.task_date, t.xctsk, t.stop_announcement_time,
              t.gap_params AS task_gap_params,
              c.category, c.timezone, c.gap_params, c.scoring_format, c.creation_date
       FROM task t
       JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<ScoringTaskRow & { task_gap_params: string | null }>();

  if (!taskRow || !taskRow.xctsk) return null;
  taskRow.gap_params = mergeStoredGapParamsJson(
    taskRow.gap_params,
    taskRow.task_gap_params
  );
  return taskRow;
}

/** Derive every scoring parameter from a task+comp row. Pure — no I/O. */
function geometryFromRow(taskRow: ScoringTaskRow): TaskScoringGeometry {
  const scoringFormat: "gap" | "open_distance" =
    taskRow.scoring_format === "open_distance" ? "open_distance" : "gap";

  const xcTask = parseXCTask(taskRow.xctsk);
  const storedGapParams: Partial<GAPParameters> | null = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : null;
  // A comp that hasn't saved its scoring settings falls back to the official
  // per-category FAI defaults (leading/arrival/difficulty as the S7F formula
  // uses them) rather than the raw HG-shaped engine baseline (issue #343).
  // resolveCompGapParams also keeps the pre-#258 time-points exponent for a
  // comp that saved a leadingFormula before the exponent was decoupled.
  const category = taskRow.category === "pg" ? "pg" : "hg";
  // Pass the comp's creation time so a PG comp with no pinned leading-weight
  // formula defaults to S7F-2024 when created on/after the cutoff, and to
  // GAP2020/AirScore parity when created before it (issue #257).
  const compCreatedAtMs = Date.parse(taskRow.creation_date);
  const gapParams: Partial<GAPParameters> = resolveCompGapParams(
    category,
    storedGapParams,
    Number.isNaN(compCreatedAtMs) ? null : compCreatedAtMs
  );

  // Default nominalDistance to 70% of task distance when the comp hasn't
  // pinned one (the per-category defaults carry the engine baseline, so key
  // off the *stored* value's absence). Only relevant to GAP — open distance
  // ignores GAP parameters entirely.
  if (scoringFormat === "gap" && storedGapParams?.nominalDistance == null) {
    gapParams.nominalDistance = calculateOptimizedTaskDistance(xcTask) * 0.7;
  }

  // Resolve the parameters that shape per-pilot analysis. distanceOrigin trims
  // the task; useLeading + leadingFormula shape the cached leading aggregate.
  const distanceOrigin = gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin;
  const useLeading = gapParams.useLeading ?? DEFAULT_GAP_PARAMETERS.useLeading;
  const leadingFormula = gapParams.leadingFormula ?? DEFAULT_GAP_PARAMETERS.leadingFormula;
  const scoringTask = taskForDistanceOrigin(xcTask, distanceOrigin);

  // Stopped tasks (issue #264, S7F §12.3): derive the task stop time from
  // the recorded announcement (PG: minus scoreBackTime; HG: minus one gate
  // interval) and the per-flight stop context. GAP only — open distance has
  // no stopped-task concept in the spec.
  const fullGapParams: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...gapParams };
  const stopAnnouncementMs = taskRow.stop_announcement_time
    ? Date.parse(taskRow.stop_announcement_time)
    : NaN;
  const stopCtx =
    scoringFormat === "gap" && Number.isFinite(stopAnnouncementMs)
      ? resolveTaskStop(scoringTask, stopAnnouncementMs, fullGapParams)
      : null;
  const stopBase: StopResolutionOptions | null = stopCtx
    ? {
        stopTimeMs: stopCtx.stopTimeMs,
        glideRatio: stoppedGlideRatio(fullGapParams.scoring),
        goalAltitude: resolveGoalAltitude(scoringTask),
      }
    : null;

  return {
    taskRow,
    xcTask,
    scoringTask,
    scoringFormat,
    category,
    gapParams,
    fullGapParams,
    distanceOrigin,
    useLeading,
    leadingFormula,
    stopCtx,
    stopBase,
  };
}

/**
 * Resolve just the parameters a task is scored with — one D1 query.
 *
 * Returns null when the task doesn't exist or has no route: both mean "there
 * is nothing to score", and the callers that reach here (the per-pilot
 * transparency endpoint) answer 404 either way.
 */
export async function resolveTaskGeometry(
  taskId: number,
  db: D1Database
): Promise<TaskScoringGeometry | null> {
  const taskRow = await loadScoringTaskRow(taskId, db);
  return taskRow ? geometryFromRow(taskRow) : null;
}

/** Resolve a task's scoring parameters, roster and tracks. Throws when the
 * task doesn't exist. */
export async function resolveTaskScoringConfig(
  taskId: number,
  db: D1Database
): Promise<TaskScoringConfig> {
  const taskRow = await loadScoringTaskRow(taskId, db);
  if (!taskRow) throw new Error("Task not found");
  const geometry = geometryFromRow(taskRow);

  // Load all active tracks joined with pilot info, grouped by class. A
  // superseded track (active = 0 — e.g. a pilot later marked DNF, or replaced
  // by a manual flight) is retained but NOT scored (issue #306).
  const tracks = await db
    .prepare(
      `SELECT tt.task_track_id, tt.comp_pilot_id, tt.igc_filename, tt.uploaded_at,
              tt.penalty_points, tt.penalty_reason, tt.quality_override,
              cp.registered_pilot_name AS pilot_name,
              cp.pilot_class
       FROM task_track tt
       JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
       WHERE tt.task_id = ? AND tt.active = 1
       ORDER BY tt.task_track_id`
    )
    .bind(taskId)
    .all<ScoredTrackRow>();

  // Load task classes
  const taskClasses = await db
    .prepare("SELECT pilot_class FROM task_class WHERE task_id = ?")
    .bind(taskId)
    .all<{ pilot_class: string }>();

  const scoredClasses = new Set(taskClasses.results.map((r) => r.pilot_class));
  const scoredTracks = tracks.results.filter((t) => scoredClasses.has(t.pilot_class));

  // Launch validity (FAI S7F §9.1): "pilots present" = pilots who took off
  // (have a track = numFlying) + pilots present who did not fly ("Did Not
  // Fly"). Absent and Present-default pilots without a track are excluded, so
  // numPresent per class = numFlying + numDNF. Count DNF pilots WITHOUT a
  // track — a pilot with a track already counts as flying and never carries a
  // DNF status (uploading a track sets them to Landed).
  const dnfRows = await db
    .prepare(
      `SELECT cp.pilot_class, COUNT(*) AS n
       FROM task_pilot_status tps
       JOIN comp_pilot cp ON cp.comp_pilot_id = tps.comp_pilot_id
       WHERE tps.task_id = ? AND tps.status_key = 'dnf'
         AND NOT EXISTS (
           SELECT 1 FROM task_track tt
           WHERE tt.task_id = tps.task_id
             AND tt.comp_pilot_id = tps.comp_pilot_id
             AND tt.active = 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM task_manual_flight mf
           WHERE mf.task_id = tps.task_id
             AND mf.comp_pilot_id = tps.comp_pilot_id
             AND mf.active = 1
         )
       GROUP BY cp.pilot_class`
    )
    .bind(taskId)
    .all<{ pilot_class: string; n: number }>();
  const dnfByClass = new Map(dnfRows.results.map((r) => [r.pilot_class, r.n]));

  // Data-quality verdicts (track-quality.ts). Seeded from track_analysis so
  // this function stays pure-D1 — the misses are filled by computeTaskScore,
  // which is already holding the parsed IGC.
  const qualityContext: TrackQualityContext = {
    task: geometry.xcTask,
    taskDate: taskRow.task_date,
    timeZone: taskRow.timezone ?? undefined,
    category: geometry.category,
  };
  const qualityHash = await qualityGeomHash(geometry);
  const storedQuality = await loadTrackAnalyses(db, taskId, "quality", qualityHash);
  const uploadedAtById = new Map(scoredTracks.map((t) => [t.task_track_id, t.uploaded_at]));
  const qualityByTrackId = new Map<number, TrackQualityReport>();
  for (const [trackId, row] of storedQuality) {
    // A re-uploaded track invalidates only its own verdict.
    if (row.uploaded_at !== uploadedAtById.get(trackId)) continue;
    qualityByTrackId.set(trackId, JSON.parse(row.payload_json) as TrackQualityReport);
  }

  return {
    ...geometry,
    scoredClasses,
    scoredTracks,
    dnfByClass,
    quality: {
      geomHash: qualityHash,
      byTrackId: qualityByTrackId,
      context: qualityContext,
    },
  };
}

/**
 * Split a class's tracks into those that may be scored and those a HARD
 * data-quality finding withholds (S7A §4.4.2/§4.4.6 — see track-quality.ts).
 *
 * A track whose verdict is not yet known stays in `scored`: the per-track
 * pass below assesses it while it has the fixes open and drops it there. A
 * stale or missing verdict must never silently withhold a pilot.
 */
export function partitionByQuality(
  tracks: ScoredTrackRow[],
  quality: TaskQualityMemo
): {
  scored: ScoredTrackRow[];
  excluded: { track: ScoredTrackRow; report: TrackQualityReport }[];
} {
  const scored: ScoredTrackRow[] = [];
  const excluded: { track: ScoredTrackRow; report: TrackQualityReport }[] = [];
  for (const track of tracks) {
    const report = quality.byTrackId.get(track.task_track_id);
    if (report?.hardFailed && !track.quality_override) excluded.push({ track, report });
    else scored.push(track);
  }
  return { scored, excluded };
}

/** The hard findings' titles — what the scores and the analysis basis show
 * as the reason a track was withheld. */
export function hardFindingTitles(report: TrackQualityReport): string[] {
  return report.findings.filter((f) => f.severity === "hard").map((f) => f.title);
}

/**
 * The withheld pilots of each class, ready to be seated at the bottom of the
 * scores. Call AFTER the per-track pass has filled `quality.byTrackId`.
 */
export function excludedPilotsByClass(
  quality: TaskQualityMemo,
  tracks: ScoredTrackRow[]
): Map<string, ExcludedPilot[]> {
  const byClass = new Map<string, ExcludedPilot[]>();
  for (const { track, report } of partitionByQuality(tracks, quality).excluded) {
    const list = byClass.get(track.pilot_class) ?? [];
    list.push({
      comp_pilot_id: track.comp_pilot_id,
      pilot_name: track.pilot_name,
      reasons: hardFindingTitles(report),
    });
    byClass.set(track.pilot_class, list);
  }
  return byClass;
}
