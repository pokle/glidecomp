// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * FieldContext construction — runs every detector ONCE per pilot and builds
 * the cross-pilot structures (shared time grid, gaggles, shared thermals,
 * working band) that metric computers read. Metrics never re-run detectors;
 * this is the single expensive pass.
 */

import type { XCTask } from '../xctsk-parser';
import { getEffectiveSSSIndex } from '../xctsk-parser';
import type { PilotFlight, PilotScore, TaskScoreResult } from '../gap-scoring';
import type { FixIndexDetails, ThermalSegment, GlideSegment } from '../event-types';
import type { CircleDetectionResult } from '../circle-detector';
import { detectCircles } from '../circle-detector';
import { detectTakeoffLanding } from '../takeoff-landing-detector';
import { detectThermals, detectGlides } from '../flight-phase-detectors';
import { detectGaggles, DEFAULT_GAGGLE_PARAMS, type StartCylinder } from '../cluster-detector';
import { DEFAULT_THRESHOLDS } from '../thresholds';
import { getOptimizedSegmentDistances } from '../task-optimizer';
import { localEastNorth } from '../geo';
import type { IGCFix } from '../igc-parser';
import { buildTimeGrid } from './resample';
import { clusterSharedThermals } from './shared-thermals';
import { partitionPhases } from './phase-partition';
import { estimateWorkingBand } from './working-band';
import type { FieldContext, LegInfo, PilotAnalysisContext } from './types';

export interface BuildFieldContextOptions {
  /** Shared-grid resolution; default 10 s (= DEFAULT_GAGGLE_PARAMS.stepSeconds). */
  stepSeconds?: number;
  /**
   * Competition IANA zone for presentational hour/clock labels only (see
   * FieldContext.timeZone). Undefined → UTC. Never affects any computation.
   */
  timeZone?: string;
}

/**
 * Build the analysed field from scored flights.
 *
 * `flights` and `scoreResult.pilotScores` are paired by trackFile (project
 * rule); score entries with no matching flight are skipped. Pilots end up
 * sorted by rank ascending, and their index doubles as the grid frames'
 * `PilotState.pilot` id.
 */
export function buildFieldContext(
  task: XCTask,
  flights: PilotFlight[],
  scoreResult: TaskScoreResult,
  category: 'hg' | 'pg',
  opts?: BuildFieldContextOptions,
): FieldContext {
  if (task.turnpoints.length === 0) {
    throw new Error('buildFieldContext: task has no turnpoints');
  }
  const origin = {
    lat: task.turnpoints[0].waypoint.lat,
    lon: task.turnpoints[0].waypoint.lon,
  };
  const stepSeconds = opts?.stepSeconds ?? DEFAULT_GAGGLE_PARAMS.stepSeconds;

  const flightByTrack = new Map<string, PilotFlight>();
  for (const f of flights) flightByTrack.set(f.trackFile, f);
  const rankedScores = [...scoreResult.pilotScores].sort((a, b) => a.rank - b.rank);

  // --- per-pilot detector pass (indices offset back to the full fix array) ---
  const analysed: Omit<PilotAnalysisContext, 'track'>[] = [];
  for (const score of rankedScores) {
    const flight = flightByTrack.get(score.trackFile);
    if (!flight || flight.fixes.length === 0) continue;
    analysed.push(analysePilot(flight, score, analysed.length));
  }

  const { grid, tracks } = buildTimeGrid(
    analysed.map((p) => ({
      fixes: p.fixes,
      takeoffIndex: p.takeoffIndex,
      landingIndex: p.landingIndex,
    })),
    origin,
    stepSeconds,
  );

  const pilots: PilotAnalysisContext[] = analysed.map((p, i) => ({ ...p, track: tracks[i] }));

  const gaggles = detectGaggles(
    grid.frames,
    { ...DEFAULT_GAGGLE_PARAMS, stepSeconds },
    { startCylinder: startCylinderFor(task, origin) },
  );

  const sharedThermals = clusterSharedThermals(pilots);
  const workingBand = estimateWorkingBand(pilots);

  const segmentDistances = getOptimizedSegmentDistances(task);
  const legs: LegInfo[] = segmentDistances.map((d, i) => ({
    fromTaskIndex: i,
    toTaskIndex: i + 1,
    optimizedMeters: d,
  }));

  return {
    task,
    category,
    scoreResult,
    pilots,
    grid,
    gaggles,
    sharedThermals,
    workingBand,
    legs,
    origin,
    timeZone: opts?.timeZone,
  };
}

function analysePilot(
  flight: PilotFlight,
  score: PilotScore,
  pilotIndex: number,
): Omit<PilotAnalysisContext, 'track'> {
  const { fixes } = flight;

  // Takeoff/landing anchor the analysed window, like detectFlightEvents does.
  let takeoffIndex = 0;
  let landingIndex = fixes.length - 1;
  for (const ev of detectTakeoffLanding(fixes, DEFAULT_THRESHOLDS)) {
    const fixIndex = (ev.details as FixIndexDetails | undefined)?.fixIndex;
    if (fixIndex === undefined) continue;
    if (ev.type === 'takeoff') takeoffIndex = fixIndex;
    if (ev.type === 'landing') landingIndex = fixIndex;
  }
  if (landingIndex <= takeoffIndex) {
    takeoffIndex = 0;
    landingIndex = fixes.length - 1;
  }

  // Detectors run on the airborne slice (matching detectFlightEvents), then
  // every fix index is offset back into the full array.
  const flightFixes = fixes.slice(takeoffIndex, landingIndex + 1);
  const slicedThermals = detectThermals(flightFixes, DEFAULT_THRESHOLDS);
  const slicedGlides = detectGlides(flightFixes, slicedThermals, DEFAULT_THRESHOLDS);
  const slicedCircles = detectCircles(flightFixes);

  const thermals: ThermalSegment[] = slicedThermals.map((t) => ({
    ...t,
    startIndex: t.startIndex + takeoffIndex,
    endIndex: t.endIndex + takeoffIndex,
  }));
  const glides: GlideSegment[] = slicedGlides.map((g) => ({
    ...g,
    startIndex: g.startIndex + takeoffIndex,
    endIndex: g.endIndex + takeoffIndex,
  }));
  const circles: CircleDetectionResult = {
    circlingSegments: slicedCircles.circlingSegments.map((s) => ({
      ...s,
      startIndex: s.startIndex + takeoffIndex,
      endIndex: s.endIndex + takeoffIndex,
    })),
    circles: slicedCircles.circles.map((c) => ({
      ...c,
      startIndex: c.startIndex + takeoffIndex,
      endIndex: c.endIndex + takeoffIndex,
      strongestLiftFixIndex: c.strongestLiftFixIndex + takeoffIndex,
    })),
    bearingRates: slicedCircles.bearingRates,
  };

  const phases = partitionPhases(fixes, thermals, circles, takeoffIndex, landingIndex);

  return {
    pilotName: score.pilotName,
    trackFile: score.trackFile,
    pilotIndex,
    fixes,
    score,
    thermals,
    glides,
    circles,
    phases,
    takeoffIndex,
    landingIndex,
    sssMs: score.turnpointResult.sssReaching?.time.getTime() ?? null,
    essMs: score.turnpointResult.essReaching?.time.getTime() ?? null,
  };
}

/**
 * The SSS cylinder in grid ENU, for detectGaggles' pre-start exclusion
 * (everyone loiters together in the start cylinder — that's not a gaggle).
 * Frame convention: x = east, z = south = −north.
 */
function startCylinderFor(
  task: XCTask,
  origin: { lat: number; lon: number },
): StartCylinder | null {
  const sssIndex = getEffectiveSSSIndex(task);
  if (sssIndex < 0) return null;
  const tp = task.turnpoints[sssIndex];
  const { east, north } = localEastNorth(origin.lat, origin.lon, tp.waypoint.lat, tp.waypoint.lon);
  return { x: east, z: -north, radius: tp.radius };
}

/** Convenience for tests: total airborne seconds of a pilot context. */
export function airborneSeconds(p: { fixes: IGCFix[]; takeoffIndex: number; landingIndex: number }): number {
  if (p.landingIndex <= p.takeoffIndex) return 0;
  return (
    (p.fixes[p.landingIndex].time.getTime() - p.fixes[p.takeoffIndex].time.getTime()) / 1000
  );
}
