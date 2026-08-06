/**
 * Computing a task's published scores.
 *
 * Two formats, two algorithms, one envelope. They share the resolved config,
 * the per-track cache and the class-shaping helpers, and nothing else — GAP
 * resolves a turnpoint sequence per pilot and runs the S7F formula, open
 * distance measures one straight line from the take-off cylinder. Keeping them
 * as separate functions is what lets each read as the thing it is.
 */

import {
  resolveTurnpointSequence,
  scoreFlights,
  scoreOpenDistanceFlights,
  openDistanceForFlight,
  toFlightScoringData,
  manualOpenDistanceGeometry,
  computeLeadingAggregate,
  resolveScoredWindowEnds,
  type IGCFix,
  type FlightScoringData,
  type OpenDistanceFlightData,
  type StopResolutionOptions,
} from "@glidecomp/engine";
import { encodeId } from "../sqids";
import { manualFlightToScoringData, manualFlightKey } from "../manual-flight-store";
import { mapWithConcurrency, TRACK_FETCH_CONCURRENCY } from "../lib/concurrency";
import { gapGeomHash, odGeomHash } from "./geom-hash";
import { excludedPilotsByClass, resolveTaskScoringConfig } from "./config";
import {
  buildClassScore,
  emptyClassScore,
  pilotMetaByTrackFile,
  validityInputs,
  type PilotMeta,
} from "./class-score";
import {
  canUseStored,
  fetchIgcFixes,
  isKnownWithheld,
  loadTrackAnalyses,
  openTrackForScoring,
  saveTrackAnalyses,
  type TrackAnalysisWrite,
} from "./track-store";
import type {
  CachedFlightAnalysis,
  ClassScore,
  ExcludedPilot,
  ScoredTrackRow,
  TaskScoreResponse,
  TaskScoringConfig,
} from "./types";

/** One pilot ready to be scored, with everything the response needs. */
interface AnalyzedPilot<F> extends PilotMeta {
  flight: F;
  pilot_class: string;
  /** The underlying track row — null for manual (track-less) flights. */
  track: ScoredTrackRow | null;
}

/**
 * Compute scores for a task by gathering each pilot's flight analysis, then
 * running the scoring formula per pilot class.
 *
 * Each pilot's analysis (the expensive tracklog scan) is independent of the
 * rest of the field, so it is stored per-track in the track_analysis table and
 * reused across recomputes; only tracks that are new or changed are fetched
 * from R2, decompressed and re-parsed, and those run with bounded concurrency.
 *
 * Penalties are applied after scoring — deducted from totalScore, floored at 0,
 * then pilots are re-ranked within their class.
 */
export async function computeTaskScore(
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string,
  // A pre-resolved config, when the caller already has one. Field analysis
  // passes its own so the official ranks it overlays are guaranteed to come
  // from the SAME parameters/geometry as its re-score — two independent
  // resolutions could straddle a concurrent task edit — and so the compute
  // doesn't pay the D1 queries twice.
  cfg?: TaskScoringConfig
): Promise<TaskScoreResponse> {
  // Kept as one object, not just destructured: `config.quality` is a mutable
  // memo this pass FILLS (it is the only one holding the parsed IGCs), and
  // computeTaskFieldAnalysis reads it back from the very same object after
  // calling us. Destructuring away the config would drop those verdicts on
  // the floor whenever the caller didn't supply a cfg.
  const config = cfg ?? (await resolveTaskScoringConfig(taskId, db));

  const classes =
    config.scoringFormat === "open_distance"
      ? await scoreOpenDistanceTask(config, taskId, db, r2, alphabet)
      : await scoreGapTask(config, taskId, db, r2, alphabet);

  return {
    task_id: encodeId(alphabet, config.taskRow.task_id),
    comp_id: encodeId(alphabet, config.taskRow.comp_id),
    task_date: config.taskRow.task_date,
    scoring_format: config.scoringFormat,
    classes,
  };
}

/** The active manual flights (issue #306) of a task's scored classes. */
async function loadManualFlights(
  db: D1Database,
  taskId: number,
  scoredClasses: Set<string>
) {
  const rows = await db
    .prepare(
      `SELECT mf.comp_pilot_id, mf.last_reached_tp_index, mf.landing_lat,
              mf.landing_lon, mf.duration_seconds,
              cp.registered_pilot_name AS pilot_name, cp.pilot_class
       FROM task_manual_flight mf
       JOIN comp_pilot cp ON cp.comp_pilot_id = mf.comp_pilot_id
       WHERE mf.task_id = ? AND mf.active = 1`
    )
    .bind(taskId)
    .all<{
      comp_pilot_id: number;
      last_reached_tp_index: number;
      landing_lat: number;
      landing_lon: number;
      duration_seconds: number | null;
      pilot_name: string;
      pilot_class: string;
    }>();
  return rows.results.filter((m) => scoredClasses.has(m.pilot_class));
}

/**
 * Score every class of a task, seating the pilots each class's withheld
 * tracklogs belong to at the bottom. Shared by both formats: the difference
 * between them is entirely in how `scoreClass` turns flights into a result.
 *
 * One class at a time, deliberately: the stopped-task equalization pass
 * re-reads tracklogs from R2, and a multi-class task must never hold two
 * fields' worth of decompressed tracks at once.
 */
async function scoreEachClass<F>(
  config: TaskScoringConfig,
  analyzedPilots: AnalyzedPilot<F>[],
  alphabet: string,
  scoreClass: (
    pilotClass: string,
    pilots: AnalyzedPilot<F>[],
    excluded: ExcludedPilot[]
  ) => Promise<ClassScore> | ClassScore
): Promise<ClassScore[]> {
  const excludedByClass = excludedPilotsByClass(config.quality, config.scoredTracks);
  const classScores: ClassScore[] = [];
  for (const pilotClass of config.scoredClasses) {
    const classPilots = analyzedPilots.filter((p) => p.pilot_class === pilotClass);
    const excluded = excludedByClass.get(pilotClass) ?? [];
    classScores.push(
      classPilots.length === 0
        ? emptyClassScore(pilotClass, excluded, alphabet)
        : await scoreClass(pilotClass, classPilots, excluded)
    );
  }
  return classScores;
}

/**
 * Launch validity (S7F §9.1) deliberately EXCLUDES pilots whose tracklog was
 * withheld — they count as neither flying nor present-but-did-not-fly.
 *
 * Both §9.1 buckets assert a fact about this task, at this site, on this day.
 * A tracklog that is not this flight establishes neither, so counting it would
 * be inventing a fact. The decisive argument is blast radius: this is an
 * automatic heuristic, not a scorekeeper's ruling, and if a withheld pilot
 * moved into numPresent then a single false positive would reduce EVERY other
 * pilot's points. Kept out of both counts, the detector can only ever change
 * the one pilot's own score.
 *
 * The scorekeeper keeps the S7F lever, already built and audited: marking the
 * pilot Did Not Fly puts them into dnfByClass; Absent leaves them out. To
 * count them as present instead, the change is one term here (+ the class's
 * withheld count) — see the AirScore parity run before doing it.
 */
function numPresentIn(
  config: TaskScoringConfig,
  pilotClass: string,
  numFlying: number
): number {
  return numFlying + (config.dnfByClass.get(pilotClass) ?? 0);
}

// ---------------------------------------------------------------------------
// Open distance
// ---------------------------------------------------------------------------

/**
 * Score each pilot on how far they flew from the take-off cylinder exit.
 *
 * Each pilot's open distance is field-independent, so — like the GAP path — it
 * is stored per track in track_analysis and reused across recomputes. Open
 * distance needs the raw fixes (not the GAP turnpoint analysis), so it uses
 * its own variant holding just the computed distance.
 */
async function scoreOpenDistanceTask(
  config: TaskScoringConfig,
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string
): Promise<ClassScore[]> {
  const geomHash = await odGeomHash(config);
  const stored = await loadTrackAnalyses(db, taskId, "od", geomHash);
  const writes: TrackAnalysisWrite[] = [];

  const analyzed = await mapWithConcurrency(
    config.scoredTracks,
    TRACK_FETCH_CONCURRENCY,
    async (track): Promise<AnalyzedPilot<OpenDistanceFlightData> | null> => {
      if (isKnownWithheld(track, config.quality)) return null;

      const hit = stored.get(track.task_track_id);
      let distance: number;
      if (canUseStored(track, config.quality, hit)) {
        distance = (JSON.parse(hit.payload_json) as { distance: number }).distance;
      } else {
        const igc = await openTrackForScoring(r2, track, config.quality, writes);
        if (!igc) return null;
        distance = openDistanceForFlight(config.xcTask, {
          pilotName: track.pilot_name,
          trackFile: track.igc_filename,
          fixes: igc.fixes,
        });
        writes.push({
          task_track_id: track.task_track_id,
          variant: "od",
          geom_hash: geomHash,
          uploaded_at: track.uploaded_at,
          payload_json: JSON.stringify({ distance }),
        });
      }

      return {
        flight: {
          pilotName: track.pilot_name,
          trackFile: track.igc_filename,
          distance,
        },
        comp_pilot_id: track.comp_pilot_id,
        pilot_class: track.pilot_class,
        penalty_points: track.penalty_points,
        penalty_reason: track.penalty_reason,
        track,
      };
    }
  );
  await saveTrackAnalyses(db, writes);
  const analyzedPilots = analyzed.filter((p) => p !== null) as NonNullable<
    (typeof analyzed)[number]
  >[];

  // Manual flights (issue #306) on an open-distance task: the made-good is
  // the straight-line distance from the take-off cylinder edge to the landing
  // point. Cheap to compute (no R2 / tracklog), inline and uncached; scored
  // as numFlying like any tracked pilot.
  for (const m of await loadManualFlights(db, taskId, config.scoredClasses)) {
    const od = manualOpenDistanceGeometry(config.xcTask, {
      lat: m.landing_lat,
      lon: m.landing_lon,
    });
    analyzedPilots.push({
      flight: {
        pilotName: m.pilot_name,
        trackFile: manualFlightKey(m.comp_pilot_id),
        distance: od.distance,
      },
      comp_pilot_id: m.comp_pilot_id,
      pilot_class: m.pilot_class,
      penalty_points: 0,
      penalty_reason: null,
      track: null,
    });
  }

  return scoreEachClass(
    config,
    analyzedPilots,
    alphabet,
    (pilotClass, classPilots, excluded) => {
      const result = scoreOpenDistanceFlights(
        classPilots.map((p) => p.flight),
        numPresentIn(config, pilotClass, classPilots.length)
      );
      return buildClassScore(
        pilotClass,
        result,
        pilotMetaByTrackFile(classPilots),
        alphabet,
        excluded
      );
    }
  );
}

// ---------------------------------------------------------------------------
// GAP
// ---------------------------------------------------------------------------

/** The compact, field-independent part of a resolved flight — the geometric
 * fields only. The pilot name/id come fresh from the DB each run, so renames
 * and penalties never invalidate a cached entry. */
function toCachedAnalysis(flight: FlightScoringData): CachedFlightAnalysis {
  return {
    flownDistance: flight.flownDistance,
    madeGoal: flight.madeGoal,
    reachedESS: flight.reachedESS,
    speedSectionTime: flight.speedSectionTime,
    sssTimeMs: flight.sssTimeMs,
    essTimeMs: flight.essTimeMs,
    startTimeMs: flight.startTimeMs ?? null,
    ...(flight.earlyStartSeconds !== undefined
      ? { earlyStartSeconds: flight.earlyStartSeconds }
      : {}),
    ...(flight.landedBeforeStop !== undefined
      ? { landedBeforeStop: flight.landedBeforeStop }
      : {}),
    ...(flight.stoppedAltitudeBonus !== undefined
      ? { stoppedAltitudeBonus: flight.stoppedAltitudeBonus }
      : {}),
    ...(flight.leadingAggregate ? { leadingAggregate: flight.leadingAggregate } : {}),
  };
}

async function scoreGapTask(
  config: TaskScoringConfig,
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string
): Promise<ClassScore[]> {
  const { scoringTask, stopBase, useLeading, leadingFormula } = config;
  const geomHash = await gapGeomHash(config);
  const stored = await loadTrackAnalyses(db, taskId, "gap", geomHash);
  const writes: TrackAnalysisWrite[] = [];

  /** Resolve one track's scoring inputs against the task (stop-aware). */
  const resolveGapFlight = (
    track: ScoredTrackRow,
    fixes: IGCFix[],
    stop: StopResolutionOptions | null
  ): FlightScoringData => {
    const result = resolveTurnpointSequence(
      scoringTask, fixes, stop ? { stop } : undefined,
    );
    // Base (field-independent) analysis, without retaining the heavy
    // tracklog. Leading comps additionally capture the per-track leading
    // scan as an aggregate, so a later upload doesn't re-scan the field.
    const base = toFlightScoringData(
      { pilotName: track.pilot_name, trackFile: track.igc_filename, fixes },
      result,
      false
    );
    const leadingAggregate = useLeading
      ? computeLeadingAggregate(
          fixes, scoringTask, result.sequence,
          base.sssTimeMs, base.essTimeMs, leadingFormula
        )
      : undefined;
    return leadingAggregate ? { ...base, leadingAggregate } : base;
  };

  // Gather each pilot's scoring inputs — from the per-track analysis store
  // when possible, otherwise by fetching + decompressing + parsing the IGC
  // from R2 and resolving its turnpoint sequence. Bounded concurrency
  // overlaps R2 latency while capping peak memory from decompressed
  // tracklogs. For a stopped task this pass scores every pilot against the
  // stop-time window — exact for single-start-gate races; the multi-gate
  // per-pilot equalization happens in the class loop below (§12.3.4).
  const analyzed = await mapWithConcurrency(
    config.scoredTracks,
    TRACK_FETCH_CONCURRENCY,
    async (track): Promise<AnalyzedPilot<FlightScoringData> | null> => {
      if (isKnownWithheld(track, config.quality)) return null;

      const hit = stored.get(track.task_track_id);
      let flight: FlightScoringData;
      if (canUseStored(track, config.quality, hit)) {
        flight = {
          pilotName: track.pilot_name,
          trackFile: track.igc_filename,
          ...(JSON.parse(hit.payload_json) as CachedFlightAnalysis),
        };
      } else {
        const igc = await openTrackForScoring(r2, track, config.quality, writes);
        if (!igc) return null;
        flight = resolveGapFlight(track, igc.fixes, stopBase);
        writes.push({
          task_track_id: track.task_track_id,
          variant: "gap",
          geom_hash: geomHash,
          uploaded_at: track.uploaded_at,
          payload_json: JSON.stringify(toCachedAnalysis(flight)),
        });
      }

      return {
        flight,
        comp_pilot_id: track.comp_pilot_id,
        pilot_class: track.pilot_class,
        penalty_points: track.penalty_points,
        penalty_reason: track.penalty_reason,
        track,
      };
    }
  );
  await saveTrackAnalyses(db, writes);
  const analyzedPilots = analyzed.filter((p) => p !== null) as NonNullable<
    (typeof analyzed)[number]
  >[];

  // Manual flights (issue #306): track-less pilots recorded by an admin.
  // Their made-good is cheap to compute (no R2 fetch, no tracklog scan), so
  // build the synthetic scoring inputs inline against the same scoring task —
  // recomputed live so a later route edit rescales them.
  const offset = config.xcTask.turnpoints.length - scoringTask.turnpoints.length;
  for (const m of await loadManualFlights(db, taskId, config.scoredClasses)) {
    analyzedPilots.push({
      flight: manualFlightToScoringData(scoringTask, offset, m.pilot_name, m.comp_pilot_id, {
        lastReachedTpIndex: m.last_reached_tp_index,
        landingLat: m.landing_lat,
        landingLon: m.landing_lon,
        durationSeconds: m.duration_seconds,
      }),
      comp_pilot_id: m.comp_pilot_id,
      pilot_class: m.pilot_class,
      penalty_points: 0,
      penalty_reason: null,
      track: null,
    });
  }

  return scoreEachClass(
    config,
    analyzedPilots,
    alphabet,
    async (pilotClass, classPilots, excluded) => {
      const classFlights = stopBase
        ? await equalizeStoppedWindows(classPilots, stopBase, r2, scoringTask, resolveGapFlight)
        : classPilots.map((p) => p.flight);

      const result = scoreFlights(
        scoringTask,
        classFlights,
        config.gapParams,
        numPresentIn(config, pilotClass, classPilots.length),
        config.stopCtx ? { stopTimeMs: config.stopCtx.stopTimeMs } : undefined
      );
      return buildClassScore(
        pilotClass,
        result,
        pilotMetaByTrackFile(classPilots),
        alphabet,
        excluded,
        {
          gap_params: config.fullGapParams,
          validity_inputs: validityInputs(result, config.fullGapParams),
        }
      );
    }
  );
}

/**
 * Stopped multi-gate / elapsed-time tasks (§12.3.4): every pilot in the class
 * is scored for the duration the LAST-started pilot had.
 *
 * The equalized windows come from the stop-clipped first pass; affected tracks
 * are re-resolved live against their own window end. This path is rare (a
 * stopped task with multiple gates), so it deliberately does NOT write to the
 * per-track cache — overwriting the single-row-per-variant store with
 * per-window rows would thrash the common cache.
 */
async function equalizeStoppedWindows(
  classPilots: AnalyzedPilot<FlightScoringData>[],
  stopBase: StopResolutionOptions,
  r2: R2Bucket,
  scoringTask: Parameters<typeof resolveScoredWindowEnds>[0],
  resolveGapFlight: (
    track: ScoredTrackRow,
    fixes: IGCFix[],
    stop: StopResolutionOptions | null
  ) => FlightScoringData
): Promise<FlightScoringData[]> {
  const flights = classPilots.map((p) => p.flight);
  const starts = flights.map((f) => f.startTimeMs ?? f.sssTimeMs ?? null);
  const windowEnds = resolveScoredWindowEnds(scoringTask, starts, stopBase.stopTimeMs);
  if (!windowEnds) return flights;

  return mapWithConcurrency(flights, TRACK_FETCH_CONCURRENCY, async (flight, idx) => {
    const track = classPilots[idx].track;
    if (!track || windowEnds[idx] >= stopBase.stopTimeMs) return flight;
    const fixes = await fetchIgcFixes(r2, track.igc_filename);
    if (!fixes) return flight; // keep the stop-time-clipped pass 1
    return resolveGapFlight(track, fixes, { ...stopBase, windowEndMs: windowEnds[idx] });
  });
}
