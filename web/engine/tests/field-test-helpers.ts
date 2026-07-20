/**
 * Test factory for field-analysis metric tests.
 *
 * FROZEN after Stage 0 (docs/2026-07-18-field-analysis-plan.md): the Stage 1
 * metric packages import from here but must not edit this file.
 *
 * `makeTestField` runs the REAL foundation pass (detectors, grid, gaggles,
 * shared thermals, working band, phases) over hand-built fixes, with only the
 * GAP score result faked — so metric tests exercise the same context shape
 * production uses, without needing a full scoreable task.
 */

import type { IGCFix } from '../src/igc-parser';
import type { XCTask } from '../src/xctsk-parser';
import {
  DEFAULT_GAP_PARAMETERS,
  type PilotFlight,
  type PilotScore,
  type TaskScoreResult,
} from '../src/gap-scoring';
import type { TurnpointSequenceResult } from '../src/turnpoint-sequence';
import { buildFieldContext, type FieldContext } from '../src/field-analysis';
import { createFix, BASE_TIME } from './test-helpers';

export { createFix, BASE_TIME };

/** Base point for synthetic tasks/tracks (near Corryong, matters only for geo math). */
export const TEST_ORIGIN = { lat: -36.2, lon: 147.9 };

/** Degrees of latitude per metre at TEST_ORIGIN (WGS84 series, close enough for tests). */
export const DEG_LAT_PER_M = 1 / 111_132;
/** Degrees of longitude per metre at TEST_ORIGIN. */
export const DEG_LON_PER_M = 1 / (111_320 * Math.cos((TEST_ORIGIN.lat * Math.PI) / 180));

/**
 * A minimal race task around TEST_ORIGIN: TAKEOFF, SSS 5 km east, ESS 15 km
 * east, goal 16 km east. Enough structure for legs/SSS-cylinder logic.
 */
export function makeTestTask(): XCTask {
  const tp = (eastMeters: number, radius: number, name: string, type?: 'TAKEOFF' | 'SSS' | 'ESS') => ({
    ...(type ? { type } : {}),
    radius,
    waypoint: {
      name,
      lat: TEST_ORIGIN.lat,
      lon: TEST_ORIGIN.lon + eastMeters * DEG_LON_PER_M,
      altSmoothed: 300,
    },
  });
  return {
    taskType: 'CLASSIC',
    version: 1,
    turnpoints: [
      tp(0, 400, 'LAUNCH', 'TAKEOFF'),
      tp(5_000, 2_000, 'START', 'SSS'),
      tp(15_000, 1_000, 'END', 'ESS'),
      tp(16_000, 400, 'GOAL'),
    ],
    sss: { type: 'RACE', direction: 'ENTER' },
    goal: { type: 'CYLINDER' },
  };
}

export interface TestPilotSpec {
  name: string;
  fixes: IGCFix[];
  /** Overrides merged over the fake PilotScore (rank defaults to spec order). */
  score?: Partial<PilotScore>;
  /** Overrides merged over the fake (empty) TurnpointSequenceResult. */
  turnpointResult?: Partial<TurnpointSequenceResult>;
}

/** A fake TurnpointSequenceResult: pilot never started, nothing reached. */
export function makeEmptyTurnpointResult(
  overrides?: Partial<TurnpointSequenceResult>,
): TurnpointSequenceResult {
  return {
    crossings: [],
    sequence: [],
    sssReaching: null,
    essReaching: null,
    madeGoal: false,
    lastTurnpointReached: -1,
    bestProgress: null,
    taskDistance: 0,
    flownDistance: 0,
    legs: [],
    speedSectionTime: null,
    ...overrides,
  };
}

function makePilotScore(
  trackFile: string,
  pilotName: string,
  rank: number,
  spec: TestPilotSpec,
): PilotScore {
  return {
    pilotName,
    trackFile,
    flownDistance: 0,
    speedSectionTime: null,
    madeGoal: false,
    reachedESS: false,
    distancePoints: 0,
    distanceLinearPoints: 0,
    distanceDifficultyPoints: 0,
    timePoints: 0,
    leadingPoints: 0,
    arrivalPoints: 0,
    totalScore: 0,
    rank,
    leadingCoefficient: Infinity,
    turnpointResult: makeEmptyTurnpointResult(spec.turnpointResult),
    ...spec.score,
  };
}

/**
 * Build a FieldContext from synthetic pilots. Rank = spec order (first spec
 * is rank 1) unless overridden via `score.rank`; trackFile = `<name>.igc`.
 */
export function makeTestField(
  specs: TestPilotSpec[],
  opts?: { task?: XCTask; stepSeconds?: number; timeZone?: string },
): FieldContext {
  const task = opts?.task ?? makeTestTask();
  const flights: PilotFlight[] = specs.map((s) => ({
    pilotName: s.name,
    trackFile: `${s.name}.igc`,
    fixes: s.fixes,
  }));
  const pilotScores = specs.map((s, i) => makePilotScore(`${s.name}.igc`, s.name, i + 1, s));
  const scoreResult: TaskScoreResult = {
    parameters: { ...DEFAULT_GAP_PARAMETERS },
    taskValidity: { launch: 1, distance: 1, time: 1, task: 1 },
    weights: { distance: 0.5, time: 0.5, leading: 0, arrival: 0 },
    availablePoints: { distance: 500, time: 500, leading: 0, arrival: 0, total: 1000 },
    pilotScores,
    stats: {
      numPresent: specs.length,
      numFlying: specs.length,
      numInGoal: 0,
      numReachedESS: 0,
      bestDistance: 0,
      bestTime: null,
      goalRatio: 0,
      taskDistance: 0,
    },
  };
  return buildFieldContext(task, flights, scoreResult, 'pg', {
    stepSeconds: opts?.stepSeconds,
    timeZone: opts?.timeZone,
  });
}

/**
 * A straight track segment: fixes every `intervalSeconds` for
 * `durationSeconds`, moving east at `speedMps`, climbing at `climbMps`.
 * Continues from (startSeconds, eastMeters, altitude).
 */
export function straightFixes(
  startSeconds: number,
  durationSeconds: number,
  eastMeters: number,
  altitude: number,
  speedMps: number,
  climbMps: number,
  intervalSeconds = 10,
): IGCFix[] {
  const fixes: IGCFix[] = [];
  for (let t = 0; t <= durationSeconds; t += intervalSeconds) {
    fixes.push(
      createFix(
        startSeconds + t,
        TEST_ORIGIN.lat,
        TEST_ORIGIN.lon + (eastMeters + speedMps * t) * DEG_LON_PER_M,
        altitude + climbMps * t,
      ),
    );
  }
  return fixes;
}

/**
 * A circling-climb segment: fixes every `intervalSeconds` on a 60 m-radius
 * circle centred at `eastMeters`, climbing at `climbMps` — reads as a thermal
 * to detectThermals and as circling to detectCircles.
 */
export function circlingFixes(
  startSeconds: number,
  durationSeconds: number,
  eastMeters: number,
  altitude: number,
  climbMps: number,
  intervalSeconds = 5,
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const radius = 60;
  const circleSeconds = 20; // one turn every 20 s — a tight thermal turn
  for (let t = 0; t <= durationSeconds; t += intervalSeconds) {
    const angle = (2 * Math.PI * t) / circleSeconds;
    fixes.push(
      createFix(
        startSeconds + t,
        TEST_ORIGIN.lat + radius * Math.sin(angle) * DEG_LAT_PER_M,
        TEST_ORIGIN.lon + (eastMeters + radius * Math.cos(angle)) * DEG_LON_PER_M,
        altitude + climbMps * t,
      ),
    );
  }
  return fixes;
}
