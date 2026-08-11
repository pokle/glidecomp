/**
 * Behavioural field analysis across a whole task field — the 26 metrics behind
 * the public `/comp/:id/analysis` pages. See
 * docs/2026-07-18-field-analysis-plan.md.
 */

import {
  buildFieldContext,
  evaluateField,
  scoreTask,
  type FieldAnalysisReport,
  type PilotFlight,
} from "@glidecomp/engine";
import { encodeId } from "./sqids";
import { mapWithConcurrency, TRACK_FETCH_CONCURRENCY } from "./lib/concurrency";
import {
  computeTaskScore,
  hardFindingTitles,
  partitionByQuality,
  resolveTaskScoringConfig,
} from "./scoring";
import { fetchIgcFixes } from "./scoring/track-store";

/**
 * How many tracks one field analysis may hold in memory at once.
 *
 * Unlike scoring, field analysis needs EVERY pilot's raw fixes simultaneously
 * (the detectors plus a cross-pilot time grid), and a Worker isolate that
 * exceeds its 128 MB budget is killed with no useful error. This cap turns
 * that silent death into an explicit, explainable message on the row. Raise
 * it only with a measurement; the escape hatch for very large fields is to
 * move the compute off the request path entirely (queue consumer/container).
 */
export const MAX_FIELD_ANALYSIS_TRACKS = 80;

/** A task shape field analysis cannot describe — surfaced as a 422, not a 500. */
export class FieldAnalysisUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldAnalysisUnsupported";
  }
}

/** One pilot class's field-analysis report plus what the comp aggregate needs. */
export interface FieldAnalysisClass {
  pilot_class: string;
  report: FieldAnalysisReport;
  /** trackFile → cross-task pilot key (`cp:<comp_pilot_id>`). Exact, unlike
   * the CLI's filename heuristic, and survives pilot renames. */
  pilot_key_by_track_file: Record<string, string>;
  /** Per-pilot official totals — feeds aggregateComp's comp scores. */
  totals: { trackFile: string; pilotName: string; totalScore: number }[];
  /** Pilots in this class the analysis could not include, and why. Shown in
   * the UI so nobody reads the correlations as covering the whole field. */
  excluded: { pilot_name: string; reason: string }[];
}

/** The stored/served field-analysis blob for one task. */
export interface TaskFieldAnalysisResponse {
  task_id: string;
  comp_id: string;
  task_date: string;
  classes: FieldAnalysisClass[];
}

/**
 * Compute the behavioural field analysis for one task, per pilot class.
 *
 * Two things make this materially different from computeTaskScore:
 *
 * 1. It needs every pilot's RAW fixes at once — buildFieldContext runs the
 *    thermal/glide/circle detectors and builds a cross-pilot time grid — so
 *    the track_analysis cache (which stores scalars, not fixes) is no help
 *    and every track is a cold R2 GET + gunzip + parseIGC.
 *
 * 2. It re-scores through the engine's scoreTask() instead of reusing the
 *    stored scores. buildFieldContext reads PilotScore.turnpointResult, and
 *    the path computeTaskScore takes (scoreFlights) deliberately drops it to
 *    keep the hot scoring path light. Both run from resolveTaskScoringConfig,
 *    so the parameters cannot drift.
 *
 * Correlations are measured against OFFICIAL ranks (from computeTaskScore),
 * not the re-score's tracked-pilots-only ranks: manual flights (issue #306)
 * count toward the published scores but have no fixes to analyse, so
 * ranking within the tracked subset would correlate against a leaderboard
 * nobody recognises. Those pilots land in `excluded` for disclosure.
 */
export async function computeTaskFieldAnalysis(
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string
): Promise<TaskFieldAnalysisResponse> {
  const cfg = await resolveTaskScoringConfig(taskId, db);

  if (cfg.scoringFormat === "open_distance") {
    // Field analysis is built around a turnpoint task: legs, speed sections,
    // start gates, ESS. An open-distance task has a single take-off cylinder
    // and none of that structure.
    throw new FieldAnalysisUnsupported(
      "Field analysis is not available for open-distance tasks"
    );
  }
  if (cfg.scoredTracks.length === 0) {
    throw new FieldAnalysisUnsupported(
      "Field analysis needs tracks — none have been submitted for this task yet"
    );
  }
  if (cfg.scoredTracks.length > MAX_FIELD_ANALYSIS_TRACKS) {
    throw new FieldAnalysisUnsupported(
      `Field analysis is limited to ${MAX_FIELD_ANALYSIS_TRACKS} tracks per task ` +
        `(this task has ${cfg.scoredTracks.length}); the whole field must be ` +
        `held in memory at once`
    );
  }

  // Official scores — the ranks every correlation is measured against, and
  // the totals the comp aggregate ranks on. Usually cheap: computeTaskScore
  // reads its per-track analyses from track_analysis rather than R2. Passing
  // cfg through pins both passes to one parameter resolution — a concurrent
  // task edit can't put the overlaid ranks on different geometry than the
  // re-score below.
  const official = await computeTaskScore(taskId, db, r2, alphabet, cfg);
  const trackFileByPilotId = new Map(
    cfg.scoredTracks.map((t) => [encodeId(alphabet, t.comp_pilot_id), t.igc_filename])
  );

  const classes: FieldAnalysisClass[] = [];

  for (const pilotClass of cfg.scoredClasses) {
    const allClassTracks = cfg.scoredTracks.filter((t) => t.pilot_class === pilotClass);
    if (allClassTracks.length === 0) continue;

    // computeTaskScore above has filled cfg.quality for every track, so the
    // verdicts are free here. A tracklog from another day or another country
    // corrupts far more than its own row: its hour buckets and takeoff
    // instants stretch every absolute-time surface in the report — one track
    // ten days out widened the shared day-profile axis from 5 hours to 262 —
    // and its air pollutes the wind and working-band estimates.
    const { scored: classTracks, excluded: qualityExcluded } = partitionByQuality(
      allClassTracks,
      cfg.quality
    );
    const qualityExcludedIds = new Set(
      qualityExcluded.map((e) => encodeId(alphabet, e.track.comp_pilot_id))
    );

    const officialClass = official.classes.find((c) => c.pilot_class === pilotClass);
    const excluded: { pilot_name: string; reason: string }[] = [];
    for (const e of qualityExcluded) {
      excluded.push({
        pilot_name: e.track.pilot_name,
        reason: `track failed a data-quality check: ${hardFindingTitles(e.report).join("; ")}`,
      });
    }
    // Officially-ranked pilots with no track (manual flight reports). They
    // can't be analysed, but they DID count toward the official launch
    // validity — remembered so the re-score's numPresent matches.
    //
    // A withheld pilot is ALSO absent from trackFileByPilotId, but must not
    // land here: they are neither a manual flight nor part of numPresent (see
    // the launch-validity note in scoring/task-score.ts), so counting them
    // would both mislabel them and put this pass's numPresent out of step with
    // the official one.
    let trackless = 0;
    for (const entry of officialClass?.pilots ?? []) {
      if (qualityExcludedIds.has(entry.comp_pilot_id)) continue;
      if (!trackFileByPilotId.has(entry.comp_pilot_id)) {
        trackless++;
        excluded.push({
          pilot_name: entry.pilot_name,
          reason: "scored from a manual flight report — no tracklog to analyse",
        });
      }
    }

    // One class at a time, so a multi-class task never holds two fields'
    // worth of decompressed tracklogs simultaneously.
    const flights: PilotFlight[] = [];
    const fixesPerTrack = await mapWithConcurrency(
      classTracks,
      TRACK_FETCH_CONCURRENCY,
      (track) => fetchIgcFixes(r2, track.igc_filename)
    );
    for (const [i, fixes] of fixesPerTrack.entries()) {
      const track = classTracks[i];
      if (!fixes) {
        excluded.push({
          pilot_name: track.pilot_name,
          reason: "tracklog missing or unreadable",
        });
        continue;
      }
      flights.push({
        pilotName: track.pilot_name,
        trackFile: track.igc_filename,
        fixes,
      });
    }
    if (flights.length === 0) continue;

    // scoreTask applies the distance-origin trim itself, so it takes the
    // untrimmed task — as does buildFieldContext, whose ENU origin is the
    // first turnpoint's waypoint. numPresent includes the trackless
    // (manual-flight) pilots so launch validity matches the official score's.
    const numPresent =
      flights.length + trackless + (cfg.dnfByClass.get(pilotClass) ?? 0);
    const result = scoreTask(
      cfg.xcTask,
      flights,
      cfg.gapParams,
      numPresent,
      cfg.stopCtx ? { stopAnnouncementMs: Date.parse(cfg.taskRow.stop_announcement_time!) } : {}
    );

    // Overlay the official rank/total on each re-scored pilot (paired by
    // trackFile — never by index, the two arrays sort differently), then
    // re-sort so buildFieldContext's rank ordering is the published one.
    // A pilot the OFFICIAL pass didn't score (e.g. its R2 read failed there
    // but succeeded here) is EXCLUDED rather than kept at the re-score's
    // tracked-subset rank — mixing the two scales would collide rank numbers
    // and silently distort every correlation.
    const officialByTrackFile = new Map(
      (officialClass?.pilots ?? []).flatMap((entry) => {
        const trackFile = trackFileByPilotId.get(entry.comp_pilot_id);
        return trackFile ? [[trackFile, entry] as const] : [];
      })
    );
    result.pilotScores = result.pilotScores.filter((ps) => {
      const entry = officialByTrackFile.get(ps.trackFile);
      if (!entry) {
        excluded.push({
          pilot_name: ps.pilotName,
          reason: "not in the official scores for this task",
        });
        return false;
      }
      ps.rank = entry.rank;
      ps.totalScore = entry.total_score;
      return true;
    });
    if (result.pilotScores.length === 0) continue;
    result.pilotScores.sort((a, b) => a.rank - b.rank);

    let report: FieldAnalysisReport;
    try {
      report = evaluateField(
        buildFieldContext(cfg.xcTask, flights, result, cfg.category)
      );
    } catch (err) {
      // One unanalysable class must not cost the others their report.
      console.error("field analysis failed for class", pilotClass, err);
      excluded.push({
        pilot_name: `(class ${pilotClass})`,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    classes.push({
      pilot_class: pilotClass,
      report,
      pilot_key_by_track_file: Object.fromEntries(
        classTracks.map((t) => [t.igc_filename, `cp:${t.comp_pilot_id}`])
      ),
      totals: result.pilotScores.map((ps) => ({
        trackFile: ps.trackFile,
        pilotName: ps.pilotName,
        totalScore: ps.totalScore,
      })),
      excluded,
    });
  }

  if (classes.length === 0) {
    throw new FieldAnalysisUnsupported(
      "No pilot class on this task had analysable tracks"
    );
  }

  return {
    task_id: encodeId(alphabet, cfg.taskRow.task_id),
    comp_id: encodeId(alphabet, cfg.taskRow.comp_id),
    task_date: cfg.taskRow.task_date,
    classes,
  };
}
