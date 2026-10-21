/**
 * Hang-gliding Class 2 scores no arrival points (FAI S7F 2026 §11,
 * issue #601).
 *
 * §11: "HG Class ≠ 2: ArrivalWeight = (1 − DistanceWeight) × 12.5%;
 * HG Class = 2: ArrivalWeight = 0", and TimeWeight is the remainder. GlideComp
 * models it as a per-field flag (`GAPParameters.hgClass2`) the backend sets
 * per pilot class from the comp's stored Class 2 list.
 */
import { describe, it, expect } from 'bun:test';
import {
  scoreFlights,
  calculateWeights,
  scoresArrival,
  storedHgClass2Classes,
  gapParamsForClass,
  defaultsFor,
  type FlightScoringData,
} from '../src/gap-scoring';
import { destinationPoint } from '../src/geo';
import type { XCTask } from '../src/xctsk-parser';

const SSS_CENTER = { lat: -36.0, lon: 147.0 };
const ESS = destinationPoint(SSS_CENTER.lat, SSS_CENTER.lon, 20000, 0);
const task: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  turnpoints: [
    { type: 'SSS', radius: 2000, waypoint: { name: 'Start', ...SSS_CENTER } },
    { type: 'ESS', radius: 1000, waypoint: { name: 'Goal', lat: ESS.lat, lon: ESS.lon } },
  ],
};
const T0 = Date.UTC(2026, 0, 10, 2, 0, 0);

function flight(overrides: Partial<FlightScoringData>): FlightScoringData {
  return {
    pilotName: 'p', trackFile: 'p.igc',
    flownDistance: 19000, madeGoal: true, reachedESS: true,
    speedSectionTime: 3600,
    sssTimeMs: T0, essTimeMs: T0 + 3600 * 1000,
    leading: { kind: 'none' },
    ...overrides,
  };
}

/** Two goal pilots a minute apart and a land-out: arrival positions differ. */
function field(): FlightScoringData[] {
  return [
    flight({ trackFile: 'first.igc' }),
    flight({
      trackFile: 'second.igc', speedSectionTime: 3660,
      essTimeMs: T0 + 3660 * 1000,
    }),
    flight({
      trackFile: 'landout.igc', madeGoal: false, reachedESS: false,
      flownDistance: 9000, speedSectionTime: null, essTimeMs: null,
    }),
  ];
}

const params = {
  ...defaultsFor('hg'),
  useLeading: false,
  nominalDistance: 19000,
  minimumDistance: 2000,
  useDistanceDifficulty: false,
};

describe('calculateWeights — HG Class 2 (§11)', () => {
  it('ArrivalWeight is 0 and time takes the whole remainder', () => {
    for (const goalRatio of [0, 0.3, 0.7, 1]) {
      const c1 = calculateWeights({ goalRatio, scoring: 'HG' });
      const c2 = calculateWeights({ goalRatio, scoring: 'HG', hgClass2: true });
      expect(c2.arrival).toBe(0);
      expect(c2.distance).toBe(c1.distance);
      expect(c2.leading).toBe(c1.leading);
      expect(c2.time).toBeCloseTo(c1.time + c1.arrival, 12);
      expect(c2.distance + c2.time + c2.leading).toBeCloseTo(1, 12);
    }
  });

  it('matches the spec figure: default LTR 17.5%, 30% in goal', () => {
    // DistanceWeight(0.3) = 0.9 − 1.665·0.3 + 1.713·0.09 − 0.587·0.027
    const dw = 0.9 - 1.665 * 0.3 + 1.713 * 0.09 - 0.587 * 0.027;
    const w = calculateWeights({ goalRatio: 0.3, scoring: 'HG', hgClass2: true });
    expect(w.distance).toBeCloseTo(dw, 12);
    expect(w.leading).toBeCloseTo((1 - dw) * 0.175, 12);
    expect(w.time).toBeCloseTo((1 - dw) * (1 - 0.175), 12);
  });

  it('nobody at ESS: unchanged — no time and no arrival either way', () => {
    const c2 = calculateWeights({ goalRatio: 0, scoring: 'HG', hgClass2: true, numReachedESS: 0 });
    expect(c2.time).toBe(0);
    expect(c2.arrival).toBe(0);
  });

  it('has no effect on paragliding', () => {
    const pg = calculateWeights({ goalRatio: 0.3, scoring: 'PG' });
    const pg2 = calculateWeights({ goalRatio: 0.3, scoring: 'PG', hgClass2: true });
    expect(pg2).toEqual(pg);
  });
});

describe('scoreFlights — HG Class 2', () => {
  it('no arrival points or positions, and the time points carry the share', () => {
    const c1 = scoreFlights(task, field(), params);
    const c2 = scoreFlights(task, field(), { ...params, hgClass2: true });

    expect(c1.availablePoints.arrival).toBeGreaterThan(0);
    expect(c2.availablePoints.arrival).toBe(0);
    expect(c2.availablePoints.time).toBeCloseTo(
      c1.availablePoints.time + c1.availablePoints.arrival, 6,
    );
    expect(c2.availablePoints.distance).toBe(c1.availablePoints.distance);

    for (const p of c2.pilotScores) {
      expect(p.arrivalPoints).toBe(0);
      // No arrival order is published for a field that scores no arrival.
      expect(p.arrivalPosition).toBeUndefined();
    }
    // The winner's total is the same day's points, re-split: first in goal
    // takes full time AND full arrival in Class 1, full (larger) time here.
    const win1 = c1.pilotScores.find((p) => p.trackFile === 'first.igc')!;
    const win2 = c2.pilotScores.find((p) => p.trackFile === 'first.igc')!;
    expect(win2.totalScore).toBeCloseTo(win1.totalScore, 0);
    // …but the second pilot loses less to the winner without arrival.
    const sec1 = c1.pilotScores.find((p) => p.trackFile === 'second.igc')!;
    const sec2 = c2.pilotScores.find((p) => p.trackFile === 'second.igc')!;
    expect(win2.totalScore - sec2.totalScore).toBeLessThan(win1.totalScore - sec1.totalScore);
  });
});

describe('scoresArrival', () => {
  it('is HG, switched on, and not Class 2', () => {
    expect(scoresArrival({ scoring: 'HG', useArrival: true })).toBe(true);
    expect(scoresArrival({ scoring: 'HG', useArrival: true, hgClass2: false })).toBe(true);
    expect(scoresArrival({ scoring: 'HG', useArrival: true, hgClass2: true })).toBe(false);
    expect(scoresArrival({ scoring: 'HG', useArrival: false })).toBe(false);
    expect(scoresArrival({ scoring: 'PG', useArrival: true })).toBe(false);
  });
});

describe('storedHgClass2Classes', () => {
  it('reads a list of class names', () => {
    expect(storedHgClass2Classes({ hgClass2Classes: ['rigid', 'Class 2'] })).toEqual([
      'rigid', 'Class 2',
    ]);
  });

  it('degrades a corrupt or absent value to no Class 2 classes', () => {
    expect(storedHgClass2Classes(null)).toEqual([]);
    expect(storedHgClass2Classes({})).toEqual([]);
    expect(storedHgClass2Classes({ hgClass2Classes: 'rigid' })).toEqual([]);
    expect(storedHgClass2Classes({ hgClass2Classes: ['rigid', 2, null] })).toEqual(['rigid']);
  });
});

describe('gapParamsForClass', () => {
  it('flags only the listed classes, and only for hang gliding', () => {
    const hg = defaultsFor('hg');
    expect(gapParamsForClass(hg, 'rigid', ['rigid']).hgClass2).toBe(true);
    // Unlisted: the very same object — no new key on a Class 1 payload.
    expect(gapParamsForClass(hg, 'open', ['rigid'])).toBe(hg);
    const pg = defaultsFor('pg');
    expect(gapParamsForClass(pg, 'rigid', ['rigid'])).toBe(pg);
  });
});
