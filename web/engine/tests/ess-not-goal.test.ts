/**
 * "ESS but not goal" (FAI S7F 2026 §13.2, issue #256).
 *
 * A pilot who reaches the end of the speed section but lands before goal
 * keeps only a configured share of their time and arrival points — reaching
 * goal "validates" the speed section. The scoring-system parameter is fixed
 * at 0 for paragliding (no goal → no time points) and defaults to 0.8 for
 * hang gliding. The best-time source is pinned per discipline (§9.4.1):
 * HG from all ESS pilots, PG goal-validated — independent of the factor.
 */
import { describe, it, expect } from 'bun:test';
import { scoreFlights, type FlightScoringData } from '../src/gap-scoring';
import { destinationPoint } from '../src/geo';
import type { XCTask } from '../src/xctsk-parser';

const SSS_CENTER = { lat: -36.0, lon: 147.0 };
const ESS = destinationPoint(SSS_CENTER.lat, SSS_CENTER.lon, 20000, 0); // 20 km north
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

const baseParams = {
  scoring: 'HG' as const, useLeading: false, useArrival: true,
  nominalDistance: 19000, minimumDistance: 2000, useDistanceDifficulty: false,
};

// A field with a goal pilot, an equally fast ESS-but-not-goal pilot, and a
// land-out — so time and arrival points exist and the docking is visible.
function field(): FlightScoringData[] {
  return [
    flight({ trackFile: 'goal.igc' }),
    flight({
      trackFile: 'ess-only.igc', madeGoal: false, flownDistance: 18000,
      essTimeMs: T0 + 3600 * 1000 + 60000, // arrives at ESS just after
    }),
    flight({
      trackFile: 'landout.igc', madeGoal: false, reachedESS: false,
      flownDistance: 9000, speedSectionTime: null, essTimeMs: null,
    }),
  ];
}

describe('ESS but not goal (S7F §12.1)', () => {
  it('HG: docks time and arrival points to the default 80%', () => {
    const result = scoreFlights(task, field(), baseParams);
    const goal = result.pilotScores.find(p => p.trackFile === 'goal.igc')!;
    const essOnly = result.pilotScores.find(p => p.trackFile === 'ess-only.igc')!;

    // Same speed-section time → same speed fraction; the ESS-only pilot
    // keeps exactly 80% of the goal pilot's time points.
    expect(goal.timePoints).toBeGreaterThan(0);
    expect(essOnly.timePoints).toBeCloseTo(goal.timePoints * 0.8, 0);

    // Arrival order still counts (2nd of 2 at ESS), but the points are
    // docked by the same factor.
    const arrFull = result.availablePoints.arrival;
    expect(goal.arrivalPoints).toBeCloseTo(arrFull, 0); // 1st at ESS → full
    expect(essOnly.arrivalPoints).toBeGreaterThan(0);
    expect(essOnly.arrivalPoints).toBeLessThan(goal.arrivalPoints * 0.81);

    // Distance points are untouched by §12.1.
    expect(essOnly.distancePoints).toBeGreaterThan(0);
  });

  it('HG: the factor is configurable (local regulations)', () => {
    const result = scoreFlights(task, field(), { ...baseParams, essNotGoalFactor: 0.5 });
    const goal = result.pilotScores.find(p => p.trackFile === 'goal.igc')!;
    const essOnly = result.pilotScores.find(p => p.trackFile === 'ess-only.igc')!;
    expect(essOnly.timePoints).toBeCloseTo(goal.timePoints * 0.5, 0);
  });

  it('HG factor 0: no time/arrival without goal; best time stays ESS-based (§9.4.1)', () => {
    const flights = field();
    // Make the ESS-only pilot the FASTEST. S7F 2026 §9.4.1 pins the HG best
    // time to all ESS pilots regardless of the ESS-but-not-goal factor, so
    // their time DOES set the best time — they just keep none of the points.
    flights[1].speedSectionTime = 3000;
    const result = scoreFlights(task, flights, { ...baseParams, essNotGoalFactor: 0 });
    const goal = result.pilotScores.find(p => p.trackFile === 'goal.igc')!;
    const essOnly = result.pilotScores.find(p => p.trackFile === 'ess-only.igc')!;
    expect(result.stats.bestTime).toBe(3000); // the ESS pilot's time
    expect(goal.timePoints).toBeLessThan(result.availablePoints.time); // beaten to ESS
    expect(goal.timePoints).toBeGreaterThan(0);
    expect(essOnly.timePoints).toBe(0);
    expect(essOnly.arrivalPoints).toBe(0);
    expect(essOnly.distancePoints).toBeGreaterThan(0); // distance untouched
  });

  it('HG default: a faster ESS-only pilot still sets the best time (AirScore parity)', () => {
    const flights = field();
    flights[1].speedSectionTime = 3000;
    const result = scoreFlights(task, flights, baseParams);
    expect(result.stats.bestTime).toBe(3000);
    const essOnly = result.pilotScores.find(p => p.trackFile === 'ess-only.igc')!;
    // Fastest overall → full speed fraction, then docked to 80%.
    expect(essOnly.timePoints).toBeCloseTo(result.availablePoints.time * 0.8, 0);
  });

  it('PG: the configured factor is ignored — no goal, no time points', () => {
    const flights = field();
    flights[1].speedSectionTime = 3000;
    const result = scoreFlights(task, flights, {
      ...baseParams, scoring: 'PG', useArrival: false, essNotGoalFactor: 0.8,
    });
    const essOnly = result.pilotScores.find(p => p.trackFile === 'ess-only.igc')!;
    expect(essOnly.timePoints).toBe(0);
    expect(result.stats.bestTime).toBe(3600); // goal-validated despite the faster ESS pilot
  });

  it('nobody in goal with factor 0: ESS-based best time, but nobody keeps points', () => {
    const flights = field().map(f =>
      f.madeGoal ? { ...f, madeGoal: false } : f,
    );
    const result = scoreFlights(task, flights, { ...baseParams, essNotGoalFactor: 0 });
    // §9.4.1: the HG best time still comes from the ESS pilots …
    expect(result.stats.bestTime).toBe(3600);
    // … but with factor 0 nobody validated their speed section, so no time
    // points are kept by anyone.
    for (const p of result.pilotScores) expect(p.timePoints).toBe(0);
  });

  it('nobody in goal with the default factor: ESS pilots still race for 80%', () => {
    const flights = field().map(f =>
      f.madeGoal ? { ...f, madeGoal: false } : f,
    );
    const result = scoreFlights(task, flights, baseParams);
    expect(result.stats.bestTime).toBe(3600);
    const fastest = result.pilotScores.find(p => p.trackFile === 'goal.igc')!;
    expect(fastest.timePoints).toBeCloseTo(result.availablePoints.time * 0.8, 0);
  });
});
