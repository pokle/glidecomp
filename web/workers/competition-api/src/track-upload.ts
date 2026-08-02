/**
 * The parts of a track upload that every upload route shares.
 *
 * There are three of them now — self, on-behalf and anonymous — and the
 * storage half of each was already the same forty lines copied twice. A third
 * copy is how this file's behaviour starts to differ per caller without
 * anybody deciding that it should, so the R2 put, the insert-or-replace, and
 * the assessment that runs beside them live here instead.
 *
 * What deliberately does NOT live here: `audit()` and
 * `bumpAndRevalidateScores()`. Both are "part of done" for a mutating route
 * and both must stay visible at the call site, where a reviewer can see that
 * they happen — burying them in a helper is how a future route silently skips
 * one and serves stale scores forever.
 */

import { parseIGC, parseXCTask, assessTrackQuality, summariseFlight } from "@glidecomp/engine";
import type { IGCFile, TrackQualityReport, FlightSummary } from "@glidecomp/engine";

/** Above this a task stops being a competition and starts being a denial of service. */
export const MAX_PILOTS_PER_TASK = 250;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The wire shape the upload routes return alongside the stored track. */
export interface TrackQualityUploadResult {
  hard_failed: boolean;
  findings: { id: string; severity: string; title: string; detail: string }[];
}

/**
 * What the file says about the flight, on the wire.
 *
 * Returned by every upload route so the pilot can check they sent the right
 * file — the scores are a background revalidation away, and this is the only
 * moment at which yesterday's tracklog is still cheap to catch.
 *
 * Instants are ISO-8601 strings to match `uploaded_at`; the engine works in
 * epoch milliseconds and the conversion happens here.
 */
export interface FlightSummaryWire {
  flight_date: string | null;
  takeoff_at: string | null;
  landing_at: string | null;
  duration_seconds: number | null;
  first_fix_at: string | null;
  last_fix_at: string | null;
  track_length_m: number | null;
  track_length_airborne_only: boolean;
  max_altitude_m: number | null;
  max_altitude_above_takeoff_m: number | null;
  fix_count: number;
  median_fix_interval_seconds: number | null;
  header_pilot_name: string | null;
  header_glider_type: string | null;
  header_glider_id: string | null;
  header_competition_id: string | null;
}

const toIso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

export function toFlightSummaryWire(summary: FlightSummary): FlightSummaryWire {
  return {
    flight_date: summary.flightDate,
    takeoff_at: toIso(summary.takeoffMs),
    landing_at: toIso(summary.landingMs),
    duration_seconds: summary.durationSeconds,
    first_fix_at: toIso(summary.firstFixMs),
    last_fix_at: toIso(summary.lastFixMs),
    track_length_m:
      summary.trackLengthMeters === null ? null : Math.round(summary.trackLengthMeters),
    track_length_airborne_only: summary.trackLengthIsAirborneOnly,
    max_altitude_m:
      summary.maxAltitudeMeters === null ? null : Math.round(summary.maxAltitudeMeters),
    max_altitude_above_takeoff_m:
      summary.maxAltitudeAboveTakeoffMeters === null
        ? null
        : Math.round(summary.maxAltitudeAboveTakeoffMeters),
    fix_count: summary.fixCount,
    median_fix_interval_seconds: summary.medianFixIntervalSeconds,
    header_pilot_name: summary.headerPilotName,
    header_glider_type: summary.headerGliderType,
    header_glider_id: summary.headerGliderId,
    header_competition_id: summary.headerCompetitionId,
  };
}

/**
 * Parse an uploaded tracklog ONCE.
 *
 * Every consumer downstream — the header pilot name, the quality assessment
 * and the flight summary — takes the result of this call. Parsing is the most
 * expensive thing on the upload path, and the routes used to do it twice.
 *
 * Returns null for a file the parser cannot read. That is not an error here:
 * the file is still stored, and scoring will skip it in the same way.
 */
export function parseUploadedIgc(igcText: string): IGCFile | null {
  try {
    return parseIGC(igcText);
  } catch {
    return null;
  }
}

/**
 * The pilot name the file itself claims, for display beside the roster name.
 * Never used to decide whose track this is.
 */
export function igcPilotNameOf(igc: IGCFile | null): string | null {
  if (!igc) return null;
  return igc.header.pilot || igc.header.competitionId || null;
}

export function flightSummaryOf(igc: IGCFile | null): FlightSummaryWire | null {
  if (!igc) return null;
  try {
    return toFlightSummaryWire(summariseFlight(igc));
  } catch {
    // A summary is a courtesy. Never fail an upload over one.
    return null;
  }
}

/**
 * Assess an uploaded tracklog against its task (engine track-quality.ts).
 *
 * Upload NEVER blocks on the result — this is not igc-validation.ts, which
 * rejects (SEC-11 size/gzip guards) and returns 400. A data-quality finding is
 * information: the file is kept, the flags are surfaced to the uploader and
 * the scorekeeper, and a HARD verdict withholds the track from scoring on the
 * read path, where an admin can overrule it (FAI S7A §4.4.6). Do not merge
 * the two concerns.
 *
 * The verdict is deliberately NOT written to track_analysis here: this handler
 * has no resolveTaskScoringConfig and duplicating that geometry hash is how
 * the two paths drift. The bumpAndRevalidateScores the routes already call
 * recomputes and caches it within seconds.
 *
 * Returns null when there is nothing to assess (no route saved yet, or an
 * unparseable file — the latter is already handled downstream).
 */
export async function assessUploadedTrack(
  db: D1Database,
  taskId: number,
  igc: IGCFile | null
): Promise<TrackQualityReport | null> {
  if (!igc || igc.fixes.length === 0) return null;

  const row = await db
    .prepare(
      `SELECT t.xctsk, t.task_date, c.category, c.timezone
       FROM task t JOIN comp c ON c.comp_id = t.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{
      xctsk: string | null;
      task_date: string;
      category: string;
      timezone: string | null;
    }>();
  if (!row) return null;

  try {
    return assessTrackQuality(igc.fixes, igc.header, {
      task: row.xctsk ? parseXCTask(row.xctsk) : undefined,
      taskDate: row.task_date,
      timeZone: row.timezone ?? undefined,
      category: row.category === "pg" ? "pg" : "hg",
    });
  } catch {
    return null;
  }
}

/** The wire form of a report, always present so the client has one shape. */
export function toUploadResult(
  report: TrackQualityReport | null
): TrackQualityUploadResult {
  return {
    hard_failed: report?.hardFailed ?? false,
    findings: (report?.findings ?? []).map((f) => ({
      id: f.id,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
    })),
  };
}

/** The audit sentence for a flagged upload — the audit log is the public
 * transparency record, so a silent flag is worse than a noisy one. */
export function qualityAuditLine(
  pilotName: string,
  report: TrackQualityReport
): string | null {
  if (report.findings.length === 0) return null;
  const detail = report.findings.map((f) => `${f.title}: ${f.detail}`).join(" ");
  return report.hardFailed
    ? `Uploaded track for ${pilotName} was flagged and excluded from scoring — ${detail} ` +
        `It scores 0 until a correct tracklog is uploaded or the scorekeeper accepts it.`
    : `Uploaded track for ${pilotName} was flagged for review — ${detail} It is still scored.`;
}

/**
 * Who is recorded as having done the upload.
 *
 * `userId` is null for an anonymous submission — there is no account to point
 * at, and inventing one would make the audit trail lie. The name still has to
 * say something true, so the anonymous routes pass a phrase rather than a
 * person.
 */
export interface TrackUploader {
  userId: string | null;
  name: string;
}

export interface StoredTrack {
  taskTrackId: number;
  r2Key: string;
  uploadedAt: string;
  fileSize: number;
  replaced: boolean;
  /** When the track being replaced was uploaded — null on a first upload. */
  previousUploadedAt: string | null;
}

/** Thrown when a task already holds MAX_PILOTS_PER_TASK tracks. */
export class TaskPilotLimitError extends Error {
  constructor() {
    super(`Maximum ${MAX_PILOTS_PER_TASK} pilots per task`);
    this.name = "TaskPilotLimitError";
  }
}

/**
 * Put the file in R2 and record it in D1, replacing this pilot's existing
 * track for the task if there is one.
 *
 * Identity is `(task_id, comp_pilot_id)`, so the R2 key is derived rather than
 * chosen by the caller — a submitter can never name an object. A replacement
 * preserves any penalty the scorekeeper applied and re-activates the row;
 * it does not count against the per-task pilot cap, because the pilot was
 * already there.
 *
 * The caller is still responsible for `bumpAndRevalidateScores()` and
 * `audit()`. See this module's header for why.
 */
export async function storeUploadedTrack(
  db: D1Database,
  r2: R2Bucket,
  opts: {
    compId: number;
    taskId: number;
    compPilotId: number;
    body: ArrayBuffer;
    igcPilotName: string | null;
    uploader: TrackUploader;
  }
): Promise<StoredTrack> {
  const { compId, taskId, compPilotId, body, igcPilotName, uploader } = opts;

  const existingTrack = await db
    .prepare(
      "SELECT task_track_id, igc_filename, uploaded_at FROM task_track WHERE task_id = ? AND comp_pilot_id = ?"
    )
    .bind(taskId, compPilotId)
    .first<{ task_track_id: number; igc_filename: string; uploaded_at: string }>();

  if (!existingTrack) {
    const pilotCount = await db
      .prepare("SELECT COUNT(*) as cnt FROM task_track WHERE task_id = ?")
      .bind(taskId)
      .first<{ cnt: number }>();
    if (pilotCount && pilotCount.cnt >= MAX_PILOTS_PER_TASK) {
      throw new TaskPilotLimitError();
    }
  }

  const r2Key = `c/${compId}/t/${taskId}/${compPilotId}.igc`;
  const now = new Date().toISOString();

  await r2.put(r2Key, body, {
    httpMetadata: {
      contentType: "application/octet-stream",
      contentEncoding: "gzip",
    },
  });

  if (existingTrack) {
    // The key is derived from comp_pilot_id, so this should never differ —
    // but an old row written under another scheme would otherwise leak an
    // orphaned object.
    if (existingTrack.igc_filename !== r2Key) {
      await r2.delete(existingTrack.igc_filename);
    }

    await db
      .prepare(
        `UPDATE task_track
         SET igc_filename = ?, uploaded_at = ?, file_size = ?, igc_pilot_name = ?,
             uploaded_by_user_id = ?, uploaded_by_name = ?, active = 1
         WHERE task_track_id = ?`
      )
      .bind(
        r2Key,
        now,
        body.byteLength,
        igcPilotName,
        uploader.userId,
        uploader.name,
        existingTrack.task_track_id
      )
      .run();

    return {
      taskTrackId: existingTrack.task_track_id,
      r2Key,
      uploadedAt: now,
      fileSize: body.byteLength,
      replaced: true,
      previousUploadedAt: existingTrack.uploaded_at,
    };
  }

  const inserted = await db
    .prepare(
      `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size, igc_pilot_name, uploaded_by_user_id, uploaded_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      taskId,
      compPilotId,
      r2Key,
      now,
      body.byteLength,
      igcPilotName,
      uploader.userId,
      uploader.name
    )
    .run();

  return {
    taskTrackId: inserted.meta.last_row_id,
    r2Key,
    uploadedAt: now,
    fileSize: body.byteLength,
    replaced: false,
    previousUploadedAt: null,
  };
}
