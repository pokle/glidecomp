/**
 * The per-pilot scoring-transparency payload behind
 * `GET /api/comp/:comp_id/task/:task_id/pilot/:comp_pilot_id/analysis` — the
 * evidence the report card explains a score from.
 */

import {
  cleanAltitudes,
  fixAltitude,
  assessTrackQuality,
  manualFlightGeometry,
  manualOpenDistanceGeometry,
  openDistanceGeometryForFlight,
  resolveScoredWindowEnds,
  resolveTurnpointSequence,
  type AltitudeCleaningReport,
  type StopResolutionOptions,
  type TrackQualityReport,
  type TurnpointSequenceResultJSON,
} from "@glidecomp/engine";
import { encodeId } from "./sqids";
import { resolveTaskGeometry } from "./scoring";
import { gapGeomHash, pilotDetailGeomHash } from "./scoring/geom-hash";
import { fetchIgcFile, saveTrackAnalyses } from "./scoring/track-store";
import type { CachedFlightAnalysis, TaskScoringGeometry } from "./scoring/types";

/**
 * Feeds the score-details page's explanation without the browser having to
 * download and re-analyze the raw tracklog: for GAP it carries the full
 * turnpoint-sequence result (every cylinder crossing with time/coords,
 * selection reasons, legs, best progress); for open distance the scored
 * line's endpoints with times. Computed by the same engine code the scorer
 * runs, from the same inputs, so the narrative always matches the score.
 */
export interface PilotAnalysisResponse {
  comp_pilot_id: string;
  scoring_format: "gap" | "open_distance";
  /** GAP transparency data (dates as ISO strings on the wire). */
  turnpoint_result: TurnpointSequenceResultJSON | null;
  /** Open-distance scored line, endpoints enriched with fix time/altitude. */
  open_distance: {
    /** Scored straight-line distance in metres (0 = never left launch). */
    distance: number;
    origin: OpenDistanceAnchorPoint | null;
    furthest: OpenDistanceAnchorPoint | null;
  } | null;
  /**
   * Manual flight geometry for a track-less pilot (issue #306): the landing
   * point and the routed made-good line to goal, so the score-details page
   * shows the same evidence as a landed-out track. All indices are in the
   * scoring (distance-origin-trimmed) frame. Null for tracked pilots.
   */
  manual_flight: {
    last_reached_tp_index: number;
    landing: { lat: number; lon: number };
    made_good: number;
    distance_to_goal: number;
    made_goal: boolean;
    route_to_goal: Array<{ lat: number; lon: number }>;
  } | null;
  /**
   * What the engine's altitude plausibility pass repaired in this pilot's
   * track (GPS glitches cross-checked against the barometric channel) —
   * surfaced on the score-details page so a cleaned track is never silently
   * different from its raw file. Null for track-less (manual) pilots.
   */
  altitude_cleaning: AltitudeCleaningReport | null;
  /**
   * What the data-quality checks made of this tracklog (track-quality.ts).
   * Present for every tracked pilot, findings empty when clean, so the page
   * can surface SOFT findings too. Null for track-less (manual) pilots.
   * Optional on the wire because rows cached before the field existed are
   * still valid.
   */
  track_quality?: TrackQualityReport | null;
}

export interface OpenDistanceAnchorPoint {
  latitude: number;
  longitude: number;
  /** Null for a manual flight (no tracklog → no fix time / altitude). */
  time_ms: number | null;
  altitude: number | null;
}

/** The cacheable (comp-pilot-independent) part of {@link PilotAnalysisResponse}. */
type PilotAnalysisPayload = Pick<
  PilotAnalysisResponse,
  "turnpoint_result" | "open_distance" | "altitude_cleaning" | "track_quality"
>;

/**
 * Recover one pilot's §13.4.4 equalized scored-window end for a stopped
 * multi-gate / elapsed-time task, from the cached per-track analyses
 * computeTaskScore wrote (variant "gap", the stop-aware pass-1 hash) for the
 * pilot's class. Returns null when the common window applies (single-gate
 * race, nobody started) or when the cached field isn't available yet — the
 * caller then clips at the stop time, which is exact for single-gate races.
 */
async function resolvePilotStopWindow(
  db: D1Database,
  geometry: TaskScoringGeometry,
  compPilotId: number
): Promise<number | null> {
  const rows = await db
    .prepare(
      `SELECT tt.comp_pilot_id, ta.payload_json
       FROM track_analysis ta
       JOIN task_track tt ON tt.task_track_id = ta.task_track_id
       JOIN comp_pilot cp ON cp.comp_pilot_id = tt.comp_pilot_id
       WHERE tt.task_id = ? AND tt.active = 1
         AND ta.variant = 'gap' AND ta.geom_hash = ?
         AND ta.uploaded_at = tt.uploaded_at
         AND cp.pilot_class = (
           SELECT pilot_class FROM comp_pilot WHERE comp_pilot_id = ?
         )`
    )
    .bind(geometry.taskRow.task_id, await gapGeomHash(geometry), compPilotId)
    .all<{ comp_pilot_id: number; payload_json: string }>();
  if (rows.results.length === 0) return null;
  const starts = rows.results.map((r) => {
    const cached = JSON.parse(r.payload_json) as CachedFlightAnalysis;
    return cached.startTimeMs ?? cached.sssTimeMs ?? null;
  });
  const ends = resolveScoredWindowEnds(
    geometry.scoringTask,
    starts,
    geometry.stopBase!.stopTimeMs
  );
  if (!ends) return null;
  const idx = rows.results.findIndex((r) => r.comp_pilot_id === compPilotId);
  return idx >= 0 ? ends[idx] : null;
}

/**
 * Compute one pilot's scoring-transparency analysis for a task.
 *
 * Runs off {@link resolveTaskGeometry} — the SAME resolution the scorer uses,
 * rather than a second hand-rolled one — so the narrative can never be built
 * on different parameters than the published score. Stored per track in
 * track_analysis (variant "pilot-detail"): any xctsk / scoring-format /
 * distance-origin change rolls the geometry hash, and a re-upload mismatches
 * on uploaded_at. Returns null when the task or the pilot's track doesn't
 * exist.
 */
export async function computePilotAnalysis(
  taskId: number,
  compPilotId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string
): Promise<PilotAnalysisResponse | null> {
  const geometry = await resolveTaskGeometry(taskId, db);
  if (!geometry) return null;
  const { xcTask, scoringTask, scoringFormat } = geometry;

  const track = await db
    .prepare(
      `SELECT task_track_id, igc_filename, uploaded_at
       FROM task_track
       WHERE task_id = ? AND comp_pilot_id = ? AND active = 1`
    )
    .bind(taskId, compPilotId)
    .first<{ task_track_id: number; igc_filename: string; uploaded_at: string }>();

  if (!track) {
    return manualFlightAnalysis(db, geometry, compPilotId, alphabet);
  }

  // Stopped tasks (S7F §13.4): mirror the scorer's stop context so the
  // transparency narrative matches the published score exactly. The pilot's
  // §13.4.4 equalized window (multi-gate/elapsed tasks) is recovered from the
  // cached analyses the scorer wrote — best effort: when they're not available
  // yet the stop time is used (exact for single-gate races).
  let stopOptions: StopResolutionOptions | null = geometry.stopBase;
  let appliedWindowEnd: number | null = null;
  if (geometry.stopBase) {
    const windowEndMs = await resolvePilotStopWindow(db, geometry, compPilotId);
    if (windowEndMs !== null && windowEndMs < geometry.stopBase.stopTimeMs) {
      appliedWindowEnd = windowEndMs;
      stopOptions = { ...geometry.stopBase, windowEndMs };
    }
  }

  const geomHash = await pilotDetailGeomHash(geometry, appliedWindowEnd);

  const hit = await db
    .prepare(
      `SELECT geom_hash, uploaded_at, payload_json FROM track_analysis
       WHERE task_track_id = ? AND variant = 'pilot-detail'`
    )
    .bind(track.task_track_id)
    .first<{ geom_hash: string; uploaded_at: string; payload_json: string }>();

  let payload: PilotAnalysisPayload | null =
    hit && hit.geom_hash === geomHash && hit.uploaded_at === track.uploaded_at
      ? (JSON.parse(hit.payload_json) as PilotAnalysisPayload)
      : null;

  if (!payload) {
    const igc = await fetchIgcFile(r2, track.igc_filename);
    if (!igc) return null;
    const fixes = igc.fixes;
    // Idempotent second pass (parseIGC already annotated the fixes): rebuilds
    // the same repair report so it can ride in the cached payload.
    const altitude_cleaning = cleanAltitudes(fixes);
    // Recomputed rather than read from the "quality" variant: this endpoint
    // resolves only the task geometry and never loads the field's stored
    // verdicts, and the assessment is cheap next to the turnpoint scan it sits
    // beside. Both paths call the same pure function on the same inputs, so
    // they agree.
    const track_quality = assessTrackQuality(fixes, igc.header, {
      task: xcTask,
      taskDate: geometry.taskRow.task_date,
      timeZone: geometry.taskRow.timezone ?? undefined,
      category: geometry.category,
    });

    if (scoringFormat === "open_distance") {
      const geo = openDistanceGeometryForFlight(xcTask, {
        pilotName: "",
        trackFile: track.igc_filename,
        fixes,
      });
      const furthestFix = geo ? fixes[geo.furthest.fixIndex] : null;
      payload = {
        turnpoint_result: null,
        open_distance: geo
          ? {
              distance: geo.distance,
              // The origin is the cylinder edge toward the furthest fix — a
              // derived point, not a track fix, so it has no time/altitude.
              origin: {
                latitude: geo.origin.latitude,
                longitude: geo.origin.longitude,
                time_ms: null,
                altitude: null,
              },
              furthest: {
                latitude: geo.furthest.latitude,
                longitude: geo.furthest.longitude,
                time_ms: furthestFix!.time.getTime(),
                altitude: fixAltitude(furthestFix!),
              },
            }
          : { distance: 0, origin: null, furthest: null },
        altitude_cleaning,
        track_quality,
      };
    } else {
      const result = resolveTurnpointSequence(
        scoringTask, fixes,
        stopOptions ? { stop: stopOptions } : undefined,
      );
      // Round-trip through JSON so the payload is typed as the wire format
      // (Dates → ISO strings) — exactly what D1 stores and the client revives.
      payload = {
        turnpoint_result: JSON.parse(JSON.stringify(result)) as TurnpointSequenceResultJSON,
        open_distance: null,
        altitude_cleaning,
        track_quality,
      };
    }

    await saveTrackAnalyses(db, [
      {
        task_track_id: track.task_track_id,
        variant: "pilot-detail",
        geom_hash: geomHash,
        uploaded_at: track.uploaded_at,
        payload_json: JSON.stringify(payload),
      },
    ]);
  }

  return {
    comp_pilot_id: encodeId(alphabet, compPilotId),
    scoring_format: scoringFormat,
    ...payload,
    manual_flight: null,
  };
}

/**
 * A pilot with no active track may still have a manual flight (issue #306).
 * The geometry is cheap — no R2, no tracklog — so it is computed inline and
 * uncached. Null when there is no manual flight either.
 */
async function manualFlightAnalysis(
  db: D1Database,
  geometry: TaskScoringGeometry,
  compPilotId: number,
  alphabet: string
): Promise<PilotAnalysisResponse | null> {
  const manual = await db
    .prepare(
      `SELECT last_reached_tp_index, landing_lat, landing_lon
       FROM task_manual_flight
       WHERE task_id = ? AND comp_pilot_id = ? AND active = 1`
    )
    .bind(geometry.taskRow.task_id, compPilotId)
    .first<{
      last_reached_tp_index: number;
      landing_lat: number;
      landing_lon: number;
    }>();
  if (!manual) return null;

  const landing = { lat: manual.landing_lat, lon: manual.landing_lon };

  // Open distance: the made-good is measured from the take-off cylinder edge
  // to the landing point. Return the same open_distance line a track does, so
  // the score-details page reuses the open-distance rendering.
  if (geometry.scoringFormat === "open_distance") {
    const od = manualOpenDistanceGeometry(geometry.xcTask, landing);
    return {
      comp_pilot_id: encodeId(alphabet, compPilotId),
      scoring_format: "open_distance",
      turnpoint_result: null,
      manual_flight: null,
      open_distance: {
        distance: od.distance,
        origin: { latitude: od.origin.lat, longitude: od.origin.lon, time_ms: null, altitude: null },
        furthest: { latitude: od.landing.lat, longitude: od.landing.lon, time_ms: null, altitude: null },
      },
      altitude_cleaning: null,
    };
  }

  const offset =
    geometry.xcTask.turnpoints.length - geometry.scoringTask.turnpoints.length;
  const scoringIndex = manual.last_reached_tp_index - offset;
  const geom = manualFlightGeometry(geometry.scoringTask, scoringIndex, landing);
  return {
    comp_pilot_id: encodeId(alphabet, compPilotId),
    scoring_format: "gap",
    turnpoint_result: null,
    open_distance: null,
    manual_flight: {
      last_reached_tp_index: scoringIndex,
      landing,
      made_good: geom.madeGood,
      distance_to_goal: geom.distanceToGoal,
      made_goal: geom.madeGoal,
      route_to_goal: geom.routeToGoal,
    },
    altitude_cleaning: null,
  };
}
