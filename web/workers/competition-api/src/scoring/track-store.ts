/**
 * The per-track analysis store (`track_analysis`) and the R2 reads behind it.
 *
 * Every expensive per-track result — the turnpoint scan, the open distance,
 * the data-quality verdict, the transparency payload — is field-independent,
 * so it is cached per track and reused across recomputes. Only tracks that are
 * new or changed are fetched from R2, decompressed and re-parsed.
 */

import {
  assessTrackQuality,
  parseIGC,
  unreadableTrackReport,
  type IGCFile,
  type IGCFix,
  type TrackQualityReport,
} from "@glidecomp/engine";
import type { ScoredTrackRow, TaskQualityMemo } from "./types";

/** The kinds of per-track analysis rows `track_analysis` holds. */
export type AnalysisVariant = "gap" | "od" | "pilot-detail" | "quality";

export interface TrackAnalysisWrite {
  task_track_id: number;
  variant: AnalysisVariant;
  geom_hash: string;
  uploaded_at: string;
  payload_json: string;
}

export interface StoredAnalysis {
  uploaded_at: string;
  payload_json: string;
}

/**
 * Load every stored analysis of one variant for a task's tracks that was
 * computed from the given task geometry, keyed by task_track_id. Callers
 * must still check the entry's uploaded_at against the track's current
 * uploaded_at — a re-uploaded track invalidates only its own row.
 */
export async function loadTrackAnalyses(
  db: D1Database,
  taskId: number,
  variant: AnalysisVariant,
  geomHash: string
): Promise<Map<number, StoredAnalysis>> {
  const rows = await db
    .prepare(
      `SELECT ta.task_track_id, ta.uploaded_at, ta.payload_json
       FROM track_analysis ta
       JOIN task_track tt ON tt.task_track_id = ta.task_track_id
       WHERE tt.task_id = ? AND ta.variant = ? AND ta.geom_hash = ?`
    )
    .bind(taskId, variant, geomHash)
    .all<{ task_track_id: number; uploaded_at: string; payload_json: string }>();
  return new Map(
    rows.results.map((r) => [
      r.task_track_id,
      { uploaded_at: r.uploaded_at, payload_json: r.payload_json },
    ])
  );
}

/**
 * Persist freshly computed per-track analyses in one transactional batch.
 * The conflict guard keeps an out-of-order writer (a slow compute finishing
 * after the track was re-uploaded and re-analyzed) from replacing a newer
 * analysis with an older one for the same geometry. Best-effort: a failure
 * (e.g. a track deleted mid-compute) only costs a recompute next time.
 */
export async function saveTrackAnalyses(
  db: D1Database,
  writes: TrackAnalysisWrite[]
): Promise<void> {
  if (writes.length === 0) return;
  try {
    await db.batch(
      writes.map((w) =>
        db
          .prepare(
            `INSERT INTO track_analysis (task_track_id, variant, geom_hash, uploaded_at, payload_json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(task_track_id, variant) DO UPDATE SET
               geom_hash = excluded.geom_hash,
               uploaded_at = excluded.uploaded_at,
               payload_json = excluded.payload_json
             WHERE excluded.uploaded_at > track_analysis.uploaded_at
                OR excluded.geom_hash != track_analysis.geom_hash`
          )
          .bind(w.task_track_id, w.variant, w.geom_hash, w.uploaded_at, w.payload_json)
      )
    );
  } catch (err) {
    console.error("track_analysis batch write failed", err);
  }
}

/** One track's R2 object, read: the parsed file, or why it holds no flight.
 * Null only when the object is missing. */
export type IgcRead = { igc: IGCFile } | { unreadable: string };

/** Fetch, decompress and parse one track's IGC from R2, keeping apart the two
 * ways it can hold nothing to score: a missing object (null) and a file that
 * is there but holds no flight (`unreadable`) — the latter is a HARD
 * data-quality verdict, not a reason to drop the pilot. */
export async function readIgcObject(
  r2: R2Bucket,
  igcFilename: string
): Promise<IgcRead | null> {
  const object = await r2.get(igcFilename);
  if (!object) return null;
  const compressed = await object.arrayBuffer();
  let igcText: string;
  try {
    const decompressedStream = new Response(compressed).body!.pipeThrough(
      new DecompressionStream("gzip")
    );
    const decompressed = await new Response(decompressedStream).arrayBuffer();
    igcText = new TextDecoder().decode(decompressed);
  } catch {
    console.warn(`Undecompressable IGC: ${igcFilename}`);
    return { unreadable: "the file could not be decompressed" };
  }
  let igc;
  try {
    igc = parseIGC(igcText);
  } catch {
    console.warn(`Unparseable IGC: ${igcFilename}`);
    return { unreadable: "the file could not be read as an IGC tracklog" };
  }
  if (igc.fixes.length === 0) {
    return { unreadable: "the file has no position fixes (B records)" };
  }
  return { igc };
}

/** Fetch, decompress and parse one track's IGC from R2 (null on failure —
 * missing object, unparseable file, or no fixes). Returns the WHOLE parsed
 * file: the data-quality checks (track-quality.ts) need the header's date,
 * which fetchIgcFixes used to discard. */
export async function fetchIgcFile(
  r2: R2Bucket,
  igcFilename: string
): Promise<IGCFile | null> {
  const read = await readIgcObject(r2, igcFilename);
  return read && "igc" in read ? read.igc : null;
}

/** Just the fixes. Kept for the callers that genuinely want nothing else —
 * notably task analysis, which holds a whole field's tracklogs at once and
 * should drop the IGCFile wrapper immediately. */
export async function fetchIgcFixes(
  r2: R2Bucket,
  igcFilename: string
): Promise<IGCFix[] | null> {
  return (await fetchIgcFile(r2, igcFilename))?.fixes ?? null;
}

/**
 * Whether a warm stored analysis may be used for this track — the data-quality
 * interlock, in one place.
 *
 * Two rules, and they pull in opposite directions, which is exactly why this
 * is a function rather than a condition written out at each call site:
 *
 * - A KNOWN hard failure short-circuits everything. The track is withheld
 *   (unless a scorekeeper overrode it, S7A §4.4.6), so it costs no R2 read at
 *   all.
 * - An UNKNOWN verdict must force the R2 read even when the scoring analysis
 *   is warm. Otherwise the verdict would never be learned: the cached scalar
 *   would satisfy every future pass and the track would be scored forever
 *   without anyone having looked at whether it should be.
 */
function qualityGate(
  track: ScoredTrackRow,
  quality: TaskQualityMemo
): { withheld: boolean; verdictKnown: boolean } {
  const report = quality.byTrackId.get(track.task_track_id);
  return {
    withheld: !!report && isWithheld(report, track),
    verdictKnown: report !== undefined,
  };
}

/** Whether a verdict withholds this track: any HARD finding a scorekeeper has
 * not overridden (S7A §4.4.6) — except a file that holds no flight, which no
 * override can score, so it stays withheld (and seated) regardless. */
export function isWithheld(report: TrackQualityReport, track: ScoredTrackRow): boolean {
  if (!report.hardFailed) return false;
  if (report.findings.some((f) => f.id === "no-fixes")) return true;
  return !track.quality_override;
}

/** True when this track is already known to be withheld from scoring. */
export function isKnownWithheld(
  track: ScoredTrackRow,
  quality: TaskQualityMemo
): boolean {
  return qualityGate(track, quality).withheld;
}

/** True when a warm stored analysis may be trusted for this track: the
 * verdict is known, the row exists, and it was written for this upload. */
export function canUseStored(
  track: ScoredTrackRow,
  quality: TaskQualityMemo,
  hit: StoredAnalysis | undefined
): hit is StoredAnalysis {
  return (
    qualityGate(track, quality).verdictKnown &&
    hit !== undefined &&
    hit.uploaded_at === track.uploaded_at
  );
}

/**
 * Fetch a track's IGC for scoring, learning and persisting its data-quality
 * verdict on the way (FAI S7A §4.4.2).
 *
 * Returns null when there is nothing to score: the object is missing, or the
 * file holds no flight, or it just hard-failed and no scorekeeper has
 * overridden it. The verdict is memoized into `quality.byTrackId` — this is
 * the only pass that holds the parsed IGC, so it is the only one that can
 * learn it — and queued onto `writes` so the next pass gets it for free.
 *
 * A file that holds no flight (unparseable, or no fixes) gets the HARD
 * `no-fixes` verdict, overwriting any verdict stored before that finding
 * existed, so the pilot is seated at 0 with the reason instead of vanishing
 * from the scores. No override can score it: there is nothing to score.
 */
export async function openTrackForScoring(
  r2: R2Bucket,
  track: ScoredTrackRow,
  quality: TaskQualityMemo,
  writes: TrackAnalysisWrite[]
): Promise<IGCFile | null> {
  const read = await readIgcObject(r2, track.igc_filename);
  if (!read) return null;

  if ("unreadable" in read) {
    remember(track, quality, writes, unreadableTrackReport(read.unreadable));
    return null;
  }
  const { igc } = read;

  if (qualityGate(track, quality).verdictKnown) return igc;

  const report = assessTrackQuality(igc.fixes, igc.header, quality.context);
  remember(track, quality, writes, report);
  return isWithheld(report, track) ? null : igc;
}

function remember(
  track: ScoredTrackRow,
  quality: TaskQualityMemo,
  writes: TrackAnalysisWrite[],
  report: TrackQualityReport
): void {
  quality.byTrackId.set(track.task_track_id, report);
  writes.push({
    task_track_id: track.task_track_id,
    variant: "quality",
    geom_hash: quality.geomHash,
    uploaded_at: track.uploaded_at,
    payload_json: JSON.stringify(report),
  });
}
