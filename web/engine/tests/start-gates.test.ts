/**
 * Start gates (FAI S7F §6.3.3, §8.3.1, §8.7) and early starts (§12.2).
 *
 * Covers the gate-time helpers, gate snapping in the turnpoint sequence,
 * and the sport-specific early-start scoring (PG launch→SSS clamp, HG
 * jump-the-gun penalty). Whole-field parity with AirScore's published
 * gated-race results lives in airscore-parity.test.ts.
 */
import { describe, it, expect } from 'bun:test';
import {
  parseTimeOfDayUTC,
  resolveTimeOfDayNear,
  resolveStartGates,
  gateIndexForCrossing,
} from '../src/time-gates';
import {
  resolveTurnpointSequence,
  reviveTurnpointSequenceResult,
  type TurnpointSequenceResultJSON,
} from '../src/turnpoint-sequence';
import { scoreFlights, type FlightScoringData } from '../src/gap-scoring';
import { getOptimizedSegmentDistances } from '../src/task-optimizer';
import { destinationPoint, calculateBearingRadians } from '../src/geo';
import type { XCTask, SSSConfig } from '../src/xctsk-parser';
import { createFix, BASE_TIME, type IGCFix } from './test-helpers';

// ---------------------------------------------------------------------------
// Gate-time helpers
// ---------------------------------------------------------------------------

describe('parseTimeOfDayUTC', () => {
  it('parses the XCTrack HH:MM:SSZ format', () => {
    expect(parseTimeOfDayUTC('13:30:00Z')).toBe(13 * 3600 + 30 * 60);
    expect(parseTimeOfDayUTC('03:45:15Z')).toBe(3 * 3600 + 45 * 60 + 15);
  });

  it('tolerates missing Z and missing seconds', () => {
    expect(parseTimeOfDayUTC('13:30:00')).toBe(13 * 3600 + 30 * 60);
    expect(parseTimeOfDayUTC('13:30')).toBe(13 * 3600 + 30 * 60);
  });

  it('rejects garbage and out-of-range values', () => {
    expect(parseTimeOfDayUTC('')).toBeNull();
    expect(parseTimeOfDayUTC('gates')).toBeNull();
    expect(parseTimeOfDayUTC('25:00:00Z')).toBeNull();
    expect(parseTimeOfDayUTC('12:61:00Z')).toBeNull();
  });
});

describe('resolveTimeOfDayNear', () => {
  const noonJan15 = Date.parse('2024-01-15T12:00:00Z');

  it('places the time on the reference day when nearby', () => {
    expect(resolveTimeOfDayNear(13 * 3600 + 1800, noonJan15)).toBe(
      Date.parse('2024-01-15T13:30:00Z'),
    );
  });

  it('wraps forward across UTC midnight', () => {
    // Reference 23:50 Jan 14, gate 01:30 → Jan 15 01:30 (not Jan 14).
    const ref = Date.parse('2024-01-14T23:50:00Z');
    expect(resolveTimeOfDayNear(1 * 3600 + 1800, ref)).toBe(
      Date.parse('2024-01-15T01:30:00Z'),
    );
  });

  it('wraps backward across UTC midnight', () => {
    // Reference 00:10 Jan 15, gate 23:30 → Jan 14 23:30 (not Jan 15).
    const ref = Date.parse('2024-01-15T00:10:00Z');
    expect(resolveTimeOfDayNear(23 * 3600 + 1800, ref)).toBe(
      Date.parse('2024-01-14T23:30:00Z'),
    );
  });
});

function raceTask(timeGates?: string[], type: SSSConfig['type'] = 'RACE'): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    turnpoints: [
      { type: 'SSS', radius: 2000, waypoint: { name: 'Start', lat: -36, lon: 147 } },
    ],
    sss: { type, direction: 'EXIT', timeGates },
  };
}

describe('resolveStartGates', () => {
  const ref = Date.parse('2024-01-15T10:00:00Z');

  it('resolves, sorts and dedupes RACE gates', () => {
    const gates = resolveStartGates(raceTask(['10:45:00Z', '10:30:00Z', '10:45:00Z']), ref);
    expect(gates).toEqual([
      Date.parse('2024-01-15T10:30:00Z'),
      Date.parse('2024-01-15T10:45:00Z'),
    ]);
  });

  it('returns null for elapsed-time tasks, missing gates and unparseable gates', () => {
    expect(resolveStartGates(raceTask(['10:30:00Z'], 'ELAPSED-TIME'), ref)).toBeNull();
    expect(resolveStartGates(raceTask(undefined), ref)).toBeNull();
    expect(resolveStartGates(raceTask([]), ref)).toBeNull();
    expect(resolveStartGates(raceTask(['bogus']), ref)).toBeNull();
  });

  it('treats a lone 00:00:00Z gate as the no-gates placeholder', () => {
    expect(resolveStartGates(raceTask(['00:00:00Z']), ref)).toBeNull();
    // ...but keeps a midnight gate that sits among real ones.
    expect(resolveStartGates(raceTask(['00:00:00Z', '00:15:00Z']), Date.parse('2024-01-15T00:10:00Z')))
      .toHaveLength(2);
  });
});

describe('gateIndexForCrossing', () => {
  const gates = [1000, 2000, 3000];
  it('picks the last gate at or before the crossing', () => {
    expect(gateIndexForCrossing(gates, 999)).toBe(-1); // early start
    expect(gateIndexForCrossing(gates, 1000)).toBe(0);
    expect(gateIndexForCrossing(gates, 2999)).toBe(1);
    expect(gateIndexForCrossing(gates, 99999)).toBe(2); // after last gate
  });
});

// ---------------------------------------------------------------------------
// Gate snapping in the turnpoint sequence
// ---------------------------------------------------------------------------

// BASE_TIME is 10:00:00 UTC — gate times below are relative to that.
const SSS_CENTER = { lat: -36, lon: 147 };
const SSS_RADIUS = 2000;
const ESS_CENTER = destinationPoint(SSS_CENTER.lat, SSS_CENTER.lon, 10000, 0); // 10 km north
const ESS_RADIUS = 1000;

function gatedTask(sss?: Partial<SSSConfig>): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    turnpoints: [
      { type: 'SSS', radius: SSS_RADIUS, waypoint: { name: 'Start', ...SSS_CENTER } },
      { type: 'ESS', radius: ESS_RADIUS, waypoint: { name: 'Goal', lat: ESS_CENTER.lat, lon: ESS_CENTER.lon } },
    ],
    sss: { type: 'RACE', direction: 'EXIT', timeGates: ['10:30:00Z', '10:45:00Z'], ...sss },
  };
}

/**
 * A flight that sits at the start-cylinder centre, exits northward at
 * `exitMinutes` after BASE_TIME, and reaches the ESS ~20 min later.
 * Optionally re-enters and exits again at `reExitMinutes`.
 */
function flightExitingAt(exitMinutes: number, reExitMinutes?: number): IGCFix[] {
  const bearingN = calculateBearingRadians(
    SSS_CENTER.lat, SSS_CENTER.lon, ESS_CENTER.lat, ESS_CENTER.lon,
  );
  const inside = destinationPoint(SSS_CENTER.lat, SSS_CENTER.lon, SSS_RADIUS - 200, bearingN);
  const outside = destinationPoint(SSS_CENTER.lat, SSS_CENTER.lon, SSS_RADIUS + 200, bearingN);
  const fixes: IGCFix[] = [
    createFix(0, SSS_CENTER.lat, SSS_CENTER.lon),
    createFix(exitMinutes * 60 - 60, inside.lat, inside.lon),
    createFix(exitMinutes * 60 + 60, outside.lat, outside.lon),
  ];
  let last = exitMinutes;
  if (reExitMinutes !== undefined) {
    fixes.push(
      createFix(reExitMinutes * 60 - 180, inside.lat, inside.lon), // back inside
      createFix(reExitMinutes * 60 - 60, inside.lat, inside.lon),
      createFix(reExitMinutes * 60 + 60, outside.lat, outside.lon), // out again
    );
    last = reExitMinutes;
  }
  const essEdge = destinationPoint(ESS_CENTER.lat, ESS_CENTER.lon, ESS_RADIUS + 500, bearingN + Math.PI);
  fixes.push(
    createFix((last + 19) * 60, essEdge.lat, essEdge.lon),
    createFix((last + 20) * 60, ESS_CENTER.lat, ESS_CENTER.lon),
  );
  return fixes;
}

const gate1 = BASE_TIME.getTime() + 30 * 60 * 1000; // 10:30
const gate2 = BASE_TIME.getTime() + 45 * 60 * 1000; // 10:45

describe('resolveTurnpointSequence with start gates', () => {
  it('snaps the start time to the last gate at or before the crossing', () => {
    const result = resolveTurnpointSequence(gatedTask(), flightExitingAt(40));
    expect(result.startGate).toBeDefined();
    expect(result.startGate!.index).toBe(0);
    expect(result.startGate!.gateCount).toBe(2);
    expect(result.startGate!.time.getTime()).toBe(gate1);
    expect(result.earlyStart).toBeUndefined();
    // Speed section runs from the gate, not the ~10:40 crossing (§8.7).
    expect(result.essReaching).not.toBeNull();
    expect(result.speedSectionTime).toBeCloseTo(
      (result.essReaching!.time.getTime() - gate1) / 1000, 3,
    );
  });

  it('gives pilots crossing after the last gate the last gate time', () => {
    const result = resolveTurnpointSequence(gatedTask(), flightExitingAt(50));
    expect(result.startGate!.index).toBe(1);
    expect(result.startGate!.time.getTime()).toBe(gate2);
  });

  it('ignores a pre-gate crossing when a later legal start exists', () => {
    // Exit at 10:20 (before the first gate), then re-start at 10:50.
    const result = resolveTurnpointSequence(gatedTask(), flightExitingAt(20, 50));
    expect(result.earlyStart).toBeUndefined();
    expect(result.sssReaching!.time.getTime()).toBeGreaterThanOrEqual(gate1);
    expect(result.startGate!.index).toBe(1); // 10:50 crossing → 10:45 gate
  });

  it('reports an early start when every crossing is before the first gate', () => {
    const result = resolveTurnpointSequence(gatedTask(), flightExitingAt(20));
    expect(result.earlyStart).toBeDefined();
    expect(result.earlyStart!.firstGateTime.getTime()).toBe(gate1);
    // Crossed ~10:20 → ~600 s early (interpolated crossing, so roughly).
    expect(result.earlyStart!.secondsEarly).toBeGreaterThan(500);
    expect(result.earlyStart!.secondsEarly).toBeLessThan(700);
    // The flight still resolves; the clock is anchored to the first gate.
    expect(result.startGate!.index).toBe(0);
    expect(result.essReaching).not.toBeNull();
    expect(result.speedSectionTime).toBeCloseTo(
      (result.essReaching!.time.getTime() - gate1) / 1000, 3,
    );
  });

  it('leaves elapsed-time tasks on the actual-crossing clock', () => {
    const result = resolveTurnpointSequence(
      gatedTask({ type: 'ELAPSED-TIME' }), flightExitingAt(40),
    );
    expect(result.startGate).toBeUndefined();
    expect(result.speedSectionTime).toBeCloseTo(
      (result.essReaching!.time.getTime() - result.sssReaching!.time.getTime()) / 1000, 3,
    );
  });

  it('leaves races without usable gates on the actual-crossing clock', () => {
    for (const timeGates of [undefined, [], ['00:00:00Z']] as const) {
      const result = resolveTurnpointSequence(
        gatedTask({ timeGates: timeGates as string[] | undefined }), flightExitingAt(40),
      );
      expect(result.startGate).toBeUndefined();
      expect(result.speedSectionTime).toBeCloseTo(
        (result.essReaching!.time.getTime() - result.sssReaching!.time.getTime()) / 1000, 3,
      );
    }
  });

  it('round-trips startGate and earlyStart through JSON', () => {
    const result = resolveTurnpointSequence(gatedTask(), flightExitingAt(20));
    const json = JSON.parse(JSON.stringify(result)) as TurnpointSequenceResultJSON;
    const revived = reviveTurnpointSequenceResult(json);
    expect(revived.startGate!.time.getTime()).toBe(result.startGate!.time.getTime());
    expect(revived.earlyStart!.crossingTime.getTime()).toBe(result.earlyStart!.crossingTime.getTime());
    expect(revived.earlyStart!.firstGateTime.getTime()).toBe(gate1);
    expect(revived.earlyStart!.secondsEarly).toBe(result.earlyStart!.secondsEarly);
  });
});

// ---------------------------------------------------------------------------
// Early-start scoring (§12.2)
// ---------------------------------------------------------------------------

// A takeoff→SSS→goal task so PG early starters have a launch→SSS leg to keep.
const TAKEOFF = destinationPoint(SSS_CENTER.lat, SSS_CENTER.lon, 6000, Math.PI); // 6 km south
const scoringTask: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    { type: 'TAKEOFF', radius: 400, waypoint: { name: 'Launch', lat: TAKEOFF.lat, lon: TAKEOFF.lon } },
    { type: 'SSS', radius: SSS_RADIUS, waypoint: { name: 'Start', ...SSS_CENTER } },
    { type: 'ESS', radius: ESS_RADIUS, waypoint: { name: 'Goal', lat: ESS_CENTER.lat, lon: ESS_CENTER.lon } },
  ],
  sss: { type: 'RACE', direction: 'EXIT', timeGates: ['10:30:00Z'] },
};
const launchToSss = getOptimizedSegmentDistances(scoringTask)[0];

function flight(overrides: Partial<FlightScoringData>): FlightScoringData {
  return {
    pilotName: 'p', trackFile: 'p.igc',
    flownDistance: 16000, madeGoal: true, reachedESS: true,
    speedSectionTime: 3600,
    sssTimeMs: gate1 + 5 * 60 * 1000, essTimeMs: gate1 + 65 * 60 * 1000,
    ...overrides,
  };
}

const baseParams = {
  scoring: 'HG' as const, useLeading: false, useArrival: false,
  nominalDistance: 16000, minimumDistance: 2000, useDistanceDifficulty: false,
};

describe('early-start scoring (§12.2)', () => {
  it('PG: early starters are scored only for the launch→SSS distance', () => {
    const result = scoreFlights(scoringTask, [
      flight({ trackFile: 'normal.igc' }),
      flight({ trackFile: 'early.igc', earlyStartSeconds: 120, speedSectionTime: 3500 }),
    ], { ...baseParams, scoring: 'PG' });
    const early = result.pilotScores.find(p => p.trackFile === 'early.igc')!;
    expect(early.earlyStartOutcome).toBe('pg_launch_to_sss');
    expect(early.flownDistance).toBeCloseTo(launchToSss, 0);
    expect(early.madeGoal).toBe(false);
    expect(early.timePoints).toBe(0);
    expect(early.speedSectionTime).toBeNull();
    expect(early.jumpTheGunPenalty).toBeUndefined();
    // The normal starter is unaffected.
    const normal = result.pilotScores.find(p => p.trackFile === 'normal.igc')!;
    expect(normal.madeGoal).toBe(true);
    expect(normal.earlyStartOutcome).toBeUndefined();
  });

  it('HG within the limit: complete flight scored, 1 point per X seconds deducted', () => {
    const result = scoreFlights(scoringTask, [
      flight({ trackFile: 'normal.igc' }),
      flight({ trackFile: 'early.igc', earlyStartSeconds: 120 }),
    ], baseParams);
    const early = result.pilotScores.find(p => p.trackFile === 'early.igc')!;
    const normal = result.pilotScores.find(p => p.trackFile === 'normal.igc')!;
    expect(early.earlyStartOutcome).toBe('hg_penalty');
    expect(early.jumpTheGunPenalty).toBe(60); // 120 s ÷ default factor 2
    expect(early.madeGoal).toBe(true); // complete flight still scored
    expect(early.totalScore).toBe(normal.totalScore - 60); // same flight otherwise
  });

  it('HG beyond the limit: scored for minimum distance only', () => {
    const result = scoreFlights(scoringTask, [
      flight({ trackFile: 'normal.igc' }),
      flight({ trackFile: 'early.igc', earlyStartSeconds: 301 }),
    ], baseParams);
    const early = result.pilotScores.find(p => p.trackFile === 'early.igc')!;
    expect(early.earlyStartOutcome).toBe('hg_min_distance');
    expect(early.flownDistance).toBe(baseParams.minimumDistance);
    expect(early.madeGoal).toBe(false);
    expect(early.timePoints).toBe(0);
  });

  it('HG penalty floors at the minimum-distance score, not zero', () => {
    const result = scoreFlights(scoringTask, [
      flight({ trackFile: 'normal.igc' }),
      // A hair under the limit with a brutal factor → penalty far exceeds
      // the raw score; §12.2 floors at the minimum-distance score.
      flight({ trackFile: 'early.igc', earlyStartSeconds: 299 }),
    ], { ...baseParams, jumpTheGunFactor: 0.1 });
    const early = result.pilotScores.find(p => p.trackFile === 'early.igc')!;
    const minDistanceFraction = baseParams.minimumDistance / 16000;
    const expectedFloor = result.availablePoints.distance * minDistanceFraction;
    expect(early.earlyStartOutcome).toBe('hg_penalty');
    expect(early.totalScore).toBe(Math.round(expectedFloor));
    expect(early.totalScore).toBeGreaterThan(0);
  });

  it('respects custom X and Y parameters', () => {
    const result = scoreFlights(scoringTask, [
      flight({ trackFile: 'a.igc', earlyStartSeconds: 100 }),
      flight({ trackFile: 'b.igc', earlyStartSeconds: 500 }),
    ], { ...baseParams, jumpTheGunFactor: 4, jumpTheGunMaxSeconds: 600 });
    const a = result.pilotScores.find(p => p.trackFile === 'a.igc')!;
    const b = result.pilotScores.find(p => p.trackFile === 'b.igc')!;
    expect(a.jumpTheGunPenalty).toBe(25); // 100 ÷ 4
    expect(b.earlyStartOutcome).toBe('hg_penalty'); // 500 < Y=600
    expect(b.jumpTheGunPenalty).toBe(125);
  });
});
