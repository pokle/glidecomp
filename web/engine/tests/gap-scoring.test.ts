import { describe, it, expect } from 'bun:test';
import {
  calculateLaunchValidity,
  calculateDistanceValidity,
  calculateTimeValidity,
  calculateTaskValidity,
  calculateWeights,
  calculateDistancePoints,
  calculateDistanceDifficulty,
  calculateDistancePointsHG,
  calculateSpeedFraction,
  calculateTimePoints,
  calculateLeadingCoefficient,
  calculateLeadingPoints,
  calculateArrivalPoints,
  applyMinimumDistance,
  scoreTask,
  scoreFlights,
  toFlightScoringData,
  taskForDistanceOrigin,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type PilotFlight,
  type FlightScoringData,
} from '../src/gap-scoring';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { calculateBearingRadians, destinationPoint } from '../src/geo';
import type { XCTask, SSSConfig, GoalConfig } from '../src/xctsk-parser';
import { createFix as createFixSeconds, BASE_TIME, type IGCFix } from './test-helpers';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createFix(timeMinutes: number, lat: number, lon: number, altitude = 1000) {
  return createFixSeconds(timeMinutes * 60, lat, lon, altitude);
}

interface TaskDef {
  name: string;
  lat: number;
  lon: number;
  radius: number;
  type?: 'TAKEOFF' | 'SSS' | 'ESS';
}

function createTask(
  defs: TaskDef[],
  sss?: Partial<SSSConfig>,
  goal?: Partial<GoalConfig>,
): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: defs.map(d => ({
      type: d.type,
      radius: d.radius,
      waypoint: { name: d.name, lat: d.lat, lon: d.lon },
    })),
    sss: {
      type: sss?.type ?? 'RACE',
      direction: sss?.direction ?? 'EXIT',
    },
    goal: {
      type: goal?.type ?? 'CYLINDER',
    },
  };
}

/**
 * Generate a track that flies through a list of waypoint cylinders in order.
 */
function createTrackThroughCylinders(
  waypoints: Array<{ lat: number; lon: number; radius: number }>,
  options?: {
    startTimeMinutes?: number;
    fixIntervalMinutes?: number;
    buffer?: number;
    altitude?: number;
    startLat?: number;
    startLon?: number;
  },
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const interval = options?.fixIntervalMinutes ?? 1;
  const buffer = options?.buffer ?? 200;
  const altitude = options?.altitude ?? 1000;
  let timeMin = options?.startTimeMinutes ?? 0;

  let currentLat = options?.startLat ?? waypoints[0].lat - 0.05;
  let currentLon = options?.startLon ?? waypoints[0].lon;

  fixes.push(createFix(timeMin, currentLat, currentLon, altitude));
  timeMin += interval;

  for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
    const wp = waypoints[wpIdx];
    const approachBearing = calculateBearingRadians(
      currentLat, currentLon, wp.lat, wp.lon,
    );

    const outsideApproach = destinationPoint(wp.lat, wp.lon, wp.radius + buffer, approachBearing + Math.PI);
    fixes.push(createFix(timeMin, outsideApproach.lat, outsideApproach.lon, altitude));
    timeMin += interval;

    const insideApproach = destinationPoint(wp.lat, wp.lon, Math.max(wp.radius - buffer, 0), approachBearing + Math.PI);
    fixes.push(createFix(timeMin, insideApproach.lat, insideApproach.lon, altitude));
    timeMin += interval;

    fixes.push(createFix(timeMin, wp.lat, wp.lon, altitude));
    timeMin += interval;

    let departureBearing: number;
    if (wpIdx < waypoints.length - 1) {
      departureBearing = calculateBearingRadians(wp.lat, wp.lon, waypoints[wpIdx + 1].lat, waypoints[wpIdx + 1].lon);
    } else {
      departureBearing = approachBearing;
    }

    const insideDepart = destinationPoint(wp.lat, wp.lon, Math.max(wp.radius - buffer, 0), departureBearing);
    fixes.push(createFix(timeMin, insideDepart.lat, insideDepart.lon, altitude));
    timeMin += interval;

    const outsideDepart = destinationPoint(wp.lat, wp.lon, wp.radius + buffer, departureBearing);
    fixes.push(createFix(timeMin, outsideDepart.lat, outsideDepart.lon, altitude));
    timeMin += interval;

    currentLat = outsideDepart.lat;
    currentLon = outsideDepart.lon;
  }

  return fixes;
}

// Standard 4-point task: SSS → TP1 → ESS → Goal
const standardTask = createTask([
  { name: 'SSS', lat: 47.0, lon: 11.0, radius: 1000, type: 'SSS' },
  { name: 'TP1', lat: 47.0, lon: 11.13, radius: 400 },
  { name: 'ESS', lat: 47.0, lon: 11.26, radius: 400, type: 'ESS' },
  { name: 'GOAL', lat: 47.0, lon: 11.26, radius: 400 },
]);

const standardWaypoints = standardTask.turnpoints.map(tp => ({
  lat: tp.waypoint.lat, lon: tp.waypoint.lon, radius: tp.radius,
}));

// ---------------------------------------------------------------------------
// Launch Validity
// ---------------------------------------------------------------------------

describe('calculateLaunchValidity', () => {
  it('returns ~1 when all pilots launch', () => {
    const lv = calculateLaunchValidity(100, 100, 0.96);
    expect(lv).toBeGreaterThan(0.99);
  });

  it('returns ~1 when numFlying >= nominalLaunch * numPresent', () => {
    const lv = calculateLaunchValidity(96, 100, 0.96);
    expect(lv).toBeGreaterThan(0.99);
  });

  it('is reduced when fewer pilots launch', () => {
    const lv = calculateLaunchValidity(50, 100, 0.96);
    expect(lv).toBeLessThan(0.9);
    expect(lv).toBeGreaterThan(0);
  });

  it('returns 0 when no pilots present', () => {
    expect(calculateLaunchValidity(0, 0, 0.96)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Distance Validity
// ---------------------------------------------------------------------------

describe('calculateDistanceValidity', () => {
  it('returns 1 when distances are well above nominal', () => {
    const dists = Array(50).fill(80000); // 80km each, well above nominal
    const dv = calculateDistanceValidity(dists, 80000, 70000, 0.2, 5000);
    expect(dv).toBeCloseTo(1, 0);
  });

  it('is reduced when distances are short', () => {
    const dists = Array(50).fill(10000); // only 10km
    const dv = calculateDistanceValidity(dists, 10000, 70000, 0.2, 5000);
    expect(dv).toBeLessThan(0.5);
    expect(dv).toBeGreaterThan(0);
  });

  it('returns 0 with empty array', () => {
    expect(calculateDistanceValidity([], 0, 70000, 0.2, 5000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Time Validity
// ---------------------------------------------------------------------------

describe('calculateTimeValidity', () => {
  it('returns ~1 when best time exceeds nominal', () => {
    const tv = calculateTimeValidity(7200, 80000, 5400, 70000); // 2hr > 90min
    expect(tv).toBeGreaterThan(0.99);
  });

  it('is reduced for very short best time', () => {
    const tv = calculateTimeValidity(600, 80000, 5400, 70000); // 10 min
    expect(tv).toBeLessThan(0.5);
  });

  it('uses distance ratio when no pilot reached ESS', () => {
    const tv = calculateTimeValidity(null, 35000, 5400, 70000);
    expect(tv).toBeGreaterThan(0);
    expect(tv).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Weight Distribution
// ---------------------------------------------------------------------------

describe('calculateWeights', () => {
  it('all weights sum to 1', () => {
    const w = calculateWeights(0.3, 80000, 100000, 'PG');
    const sum = w.distance + w.time + w.leading + w.arrival;
    expect(sum).toBeCloseTo(1, 5);
  });

  it('PG has no arrival weight', () => {
    const w = calculateWeights(0.3, 80000, 100000, 'PG');
    expect(w.arrival).toBe(0);
  });

  it('HG has arrival weight', () => {
    const w = calculateWeights(0.3, 80000, 100000, 'HG');
    expect(w.arrival).toBeGreaterThan(0);
    const sum = w.distance + w.time + w.leading + w.arrival;
    expect(sum).toBeCloseTo(1, 5);
  });

  it('distance weight is high when no one reaches goal', () => {
    const w = calculateWeights(0, 50000, 100000, 'PG');
    expect(w.distance).toBeCloseTo(0.9, 1);
  });

  it('distance weight decreases as goal ratio increases', () => {
    const w0 = calculateWeights(0, 50000, 100000, 'PG');
    const w3 = calculateWeights(0.3, 50000, 100000, 'PG');
    const w7 = calculateWeights(0.7, 50000, 100000, 'PG');
    expect(w0.distance).toBeGreaterThan(w3.distance);
    expect(w3.distance).toBeGreaterThan(w7.distance);
  });
});

// ---------------------------------------------------------------------------
// Distance Points
// ---------------------------------------------------------------------------

describe('calculateDistancePoints', () => {
  it('pilot at best distance gets full points', () => {
    expect(calculateDistancePoints(80000, 80000, 500)).toBeCloseTo(500, 1);
  });

  it('pilot at half distance gets half points', () => {
    expect(calculateDistancePoints(40000, 80000, 500)).toBeCloseTo(250, 1);
  });

  it('returns 0 for 0 distance', () => {
    expect(calculateDistancePoints(0, 80000, 500)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Speed Fraction & Time Points
// ---------------------------------------------------------------------------

describe('calculateSpeedFraction', () => {
  it('returns 1 for best time', () => {
    expect(calculateSpeedFraction(3600, 3600)).toBe(1);
  });

  it('returns 0 for very slow pilots', () => {
    const sf = calculateSpeedFraction(36000, 3600);
    expect(sf).toBe(0);
  });

  it('decreases as time increases', () => {
    // bestTime = 1hr. Times in seconds.
    const sf1 = calculateSpeedFraction(4200, 3600); // 1h10m
    const sf2 = calculateSpeedFraction(5400, 3600); // 1h30m
    expect(sf1).toBeGreaterThan(0);
    expect(sf2).toBeGreaterThan(0);
    expect(sf1).toBeGreaterThan(sf2);
  });
});

describe('calculateTimePoints', () => {
  it('PG: no time points if goal not made', () => {
    const pts = calculateTimePoints(3600, 3600, false, true, 300, 'PG');
    expect(pts).toBe(0);
  });

  it('PG: full time points for fastest pilot in goal', () => {
    const pts = calculateTimePoints(3600, 3600, true, true, 300, 'PG');
    expect(pts).toBeCloseTo(300, 1);
  });

  it('HG: time points for ESS pilot even without goal', () => {
    const pts = calculateTimePoints(3600, 3600, false, true, 300, 'HG');
    expect(pts).toBeCloseTo(300, 1);
  });
});

// ---------------------------------------------------------------------------
// Leading Points
// ---------------------------------------------------------------------------

describe('distance origin (take-off vs start)', () => {
  // Take-off and SSS share a location; the SSS is a 5 km exit cylinder.
  const task = createTask([
    { name: 'TO', lat: 47.0, lon: 11.0, radius: 3000, type: 'TAKEOFF' },
    { name: 'SSS', lat: 47.0, lon: 11.0, radius: 5000, type: 'SSS' },
    { name: 'ESS', lat: 47.0, lon: 11.26, radius: 400, type: 'ESS' },
  ]);

  it("'start' drops the take-off turnpoint, beginning at the SSS", () => {
    const s = taskForDistanceOrigin(task, 'start');
    expect(s.turnpoints.length).toBe(2);
    expect(s.turnpoints[0].type).toBe('SSS');
  });

  it("'takeoff' keeps the task unchanged", () => {
    const t = taskForDistanceOrigin(task, 'takeoff');
    expect(t.turnpoints.length).toBe(3);
    expect(t.turnpoints[0].type).toBe('TAKEOFF');
  });

  it('take-off is a fixed point: the launch leg equals the start radius', () => {
    const dTakeoff = calculateOptimizedTaskDistance(taskForDistanceOrigin(task, 'takeoff'));
    const dStart = calculateOptimizedTaskDistance(taskForDistanceOrigin(task, 'start'));
    // take-off (centre) → SSS edge toward ESS = the 5 km start radius
    expect(dTakeoff - dStart).toBeGreaterThan(4900);
    expect(dTakeoff - dStart).toBeLessThan(5100);
  });

  it('no take-off turnpoint ⇒ both origins are identical', () => {
    const plain = createTask([
      { name: 'SSS', lat: 47.0, lon: 11.0, radius: 5000, type: 'SSS' },
      { name: 'ESS', lat: 47.0, lon: 11.26, radius: 400, type: 'ESS' },
    ]);
    expect(taskForDistanceOrigin(plain, 'start')).toBe(
      taskForDistanceOrigin(plain, 'takeoff'),
    );
  });
});

describe('distance difficulty (HG, FAI S7F §11.1.1)', () => {
  // Field: one pilot in goal (40 km), a cluster of landed-out pilots at
  // ~10 km, and a lone pilot who pushed on to 25 km.
  const dists = [40000, 10000, 10200, 9800, 10100, 25000, 8000];
  const goal = [true, false, false, false, false, false, false];
  const MIN = 5000;
  const AVAIL = 300;
  const curve = calculateDistanceDifficulty(dists, goal, MIN);

  it('difficulty score is monotonic non-decreasing and capped at 0.5', () => {
    for (let i = 1; i < curve.diffScore.length; i++) {
      expect(curve.diffScore[i]).toBeGreaterThanOrEqual(curve.diffScore[i - 1] - 1e-9);
      expect(curve.diffScore[i]).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('goal pilots get the full available distance points', () => {
    const s = calculateDistancePointsHG(40000, 40000, AVAIL, curve, true);
    expect(s.total).toBeCloseTo(AVAIL, 5);
    expect(s.linear).toBeCloseTo(AVAIL / 2, 5);
    expect(s.difficulty).toBeCloseTo(AVAIL / 2, 5);
  });

  it('rewards pushing past a cluster (difficulty is non-linear)', () => {
    // The lone pilot at 25 km is well past the 10 km cluster, so the
    // difficulty half lifts them above a pure-linear share.
    const lone = calculateDistancePointsHG(25000, 40000, AVAIL, curve, false);
    const linearOnly = (25000 / 40000) * AVAIL;
    expect(lone.difficulty).toBeGreaterThan(0);
    expect(lone.total).toBeGreaterThan(linearOnly);
    expect(lone.difficulty).toBeLessThanOrEqual(AVAIL / 2 + 1e-9);
  });

  it('a sub-minimum pilot is scored at the minimum-distance slot', () => {
    const below = calculateDistancePointsHG(0, 40000, AVAIL, curve, false);
    const atMin = calculateDistancePointsHG(MIN, 40000, AVAIL, curve, false);
    expect(below.total).toBeGreaterThan(0);
    expect(below.total).toBeLessThan(atMin.total + 1e-6);
  });

  it('scoreTask: PG is pure linear (no difficulty), goal pilots aside', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const short = [
      createFix(0, 47.0 - 0.05, 11.0), createFix(5, 47.0 - 0.04, 11.0), createFix(10, 47.0 - 0.02, 11.0),
    ];
    const pilots: PilotFlight[] = [
      { pilotName: 'Goal', trackFile: 'g.igc', fixes },
      { pilotName: 'Short', trackFile: 's.igc', fixes: short },
    ];
    const pg = scoreTask(standardTask, pilots, { scoring: 'PG', nominalDistance: 10000, nominalTime: 600 });
    for (const p of pg.pilotScores) {
      expect(p.distanceDifficultyPoints).toBe(0);
      expect(p.distanceLinearPoints).toBeCloseTo(p.distancePoints, 5);
    }
  });

  it('scoreTask: HG difficulty can be disabled via useDistanceDifficulty', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const short = [
      createFix(0, 47.0 - 0.05, 11.0), createFix(5, 47.0 - 0.04, 11.0), createFix(10, 47.0 - 0.02, 11.0),
    ];
    const pilots: PilotFlight[] = [
      { pilotName: 'Goal', trackFile: 'g.igc', fixes },
      { pilotName: 'Short', trackFile: 's.igc', fixes: short },
    ];
    const off = scoreTask(standardTask, pilots, {
      scoring: 'HG', nominalDistance: 10000, nominalTime: 600, useDistanceDifficulty: false,
    });
    for (const p of off.pilotScores) expect(p.distanceDifficultyPoints).toBe(0);
  });
});

describe('calculateLeadingPoints', () => {
  it('pilot with min LC gets full points', () => {
    expect(calculateLeadingPoints(100, 100, 200)).toBeCloseTo(200, 1);
  });

  it('pilot with higher LC gets fewer points', () => {
    // LC in hours×km — values are small. Use realistic values.
    const pts = calculateLeadingPoints(1.05, 1.0, 200);
    expect(pts).toBeLessThan(200);
    expect(pts).toBeGreaterThan(0);
  });

  it('returns 0 for infinite LC', () => {
    expect(calculateLeadingPoints(Infinity, 100, 200)).toBe(0);
  });

  it('uses ((LCp-LCmin)/sqrt(LCmin))^(2/3) — divides by minLC, not sqrt(minLC)', () => {
    // AirScore pilot_leadout: LF = 1 - ((10-8)/sqrt(8))^(2/3)
    //   = 1 - cbrt(4/8) = 1 - cbrt(0.5) ≈ 0.2063 → 206.3 of 1000.
    // The previous (buggy) /sqrt(minLC) form gave a negative LF → 0 here.
    expect(calculateLeadingPoints(10, 8, 1000)).toBeCloseTo(206.3, 0);
  });
});

// ---------------------------------------------------------------------------
// Leading Coefficient (AirScore classic/weighted parity)
// ---------------------------------------------------------------------------

describe('calculateLeadingCoefficient', () => {
  // Leader flies the speed section quickly; laggard starts together but
  // crawls, so reaches ESS much later — it must have the worse (higher) LC.
  function leaderAndLaggard() {
    const leader = createTrackThroughCylinders(standardWaypoints, { fixIntervalMinutes: 1 });
    const laggard = createTrackThroughCylinders(standardWaypoints, { fixIntervalMinutes: 3 });
    const lSeq = resolveTurnpointSequence(standardTask, leader);
    const gSeq = resolveTurnpointSequence(standardTask, laggard);
    const firstSSS = Math.min(
      lSeq.sssReaching!.time.getTime(), gSeq.sssReaching!.time.getTime());
    const lastESS = Math.max(
      lSeq.essReaching!.time.getTime(), gSeq.essReaching!.time.getTime());
    return { leader, laggard, lSeq, gSeq, firstSSS, lastESS };
  }

  for (const formula of ['weighted', 'classic'] as const) {
    it(`${formula}: leader has a lower (better) finite LC than laggard`, () => {
      const { leader, laggard, lSeq, gSeq, firstSSS, lastESS } = leaderAndLaggard();
      const lcLeader = calculateLeadingCoefficient(
        leader, standardTask, lSeq.sequence, firstSSS, lastESS,
        lSeq.sssReaching!.time.getTime(), lSeq.essReaching!.time.getTime(), formula);
      const lcLaggard = calculateLeadingCoefficient(
        laggard, standardTask, gSeq.sequence, firstSSS, lastESS,
        gSeq.sssReaching!.time.getTime(), gSeq.essReaching!.time.getTime(), formula);
      expect(Number.isFinite(lcLeader)).toBe(true);
      expect(lcLeader).toBeGreaterThan(0);
      expect(lcLeader).toBeLessThan(lcLaggard);
    });
  }

  it('a pilot who never started gets Infinity', () => {
    const leader = createTrackThroughCylinders(standardWaypoints, { fixIntervalMinutes: 1 });
    const seq = resolveTurnpointSequence(standardTask, leader);
    const t0 = seq.sssReaching!.time.getTime();
    expect(calculateLeadingCoefficient(
      leader, standardTask, seq.sequence, t0, t0 + 600000, null, null, 'weighted',
    )).toBe(Infinity);
  });

  it('a land-out pilot gets a finite LC worse than an ESS pilot (tail term)', () => {
    const finisher = createTrackThroughCylinders(standardWaypoints, { fixIntervalMinutes: 1 });
    // Land out: only fly the first two cylinders, then stop short of ESS.
    const lander = createTrackThroughCylinders(standardWaypoints.slice(0, 2), { fixIntervalMinutes: 1 });
    const fSeq = resolveTurnpointSequence(standardTask, finisher);
    const dSeq = resolveTurnpointSequence(standardTask, lander);
    const firstSSS = fSeq.sssReaching!.time.getTime();
    const lastESS = fSeq.essReaching!.time.getTime();
    const lcFinish = calculateLeadingCoefficient(
      finisher, standardTask, fSeq.sequence, firstSSS, lastESS,
      firstSSS, lastESS, 'weighted');
    const lcLand = calculateLeadingCoefficient(
      lander, standardTask, dSeq.sequence, firstSSS, lastESS,
      dSeq.sssReaching!.time.getTime(), null, 'weighted');
    expect(Number.isFinite(lcLand)).toBe(true);
    expect(lcLand).toBeGreaterThan(lcFinish);
  });
});

// ---------------------------------------------------------------------------
// Arrival Points (HG)
// ---------------------------------------------------------------------------

describe('calculateArrivalPoints', () => {
  it('first arrival gets full points', () => {
    const pts = calculateArrivalPoints(1, 10, 100);
    expect(pts).toBeCloseTo(100, 0);
  });

  it('later arrivals get fewer points', () => {
    const pts1 = calculateArrivalPoints(1, 10, 100);
    const pts5 = calculateArrivalPoints(5, 10, 100);
    expect(pts1).toBeGreaterThan(pts5);
  });
});

// ---------------------------------------------------------------------------
// End-to-end scoring
// ---------------------------------------------------------------------------

describe('scoreTask', () => {
  it('scores a single pilot completing the task', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, {
      nominalDistance: 10000,
      nominalTime: 600,   // short nominal time matches our synthetic track
      nominalGoal: 0.2,
    });

    expect(result.pilotScores).toHaveLength(1);
    const alice = result.pilotScores[0];
    expect(alice.pilotName).toBe('Alice');
    expect(alice.rank).toBe(1);
    expect(alice.totalScore).toBeGreaterThan(0);
    expect(alice.madeGoal).toBe(true);
    expect(alice.distancePoints).toBeGreaterThan(0);
  });

  it('scores multiple pilots and ranks them', () => {
    // Pilot 1: completes the full task
    const fixes1 = createTrackThroughCylinders(standardWaypoints);

    // Pilot 2: only reaches first 2 waypoints (SSS + TP1)
    const fixes2 = createTrackThroughCylinders(
      standardWaypoints.slice(0, 2),
    );

    const pilots: PilotFlight[] = [
      { pilotName: 'Fast', trackFile: 'fast.igc', fixes: fixes1 },
      { pilotName: 'Slow', trackFile: 'slow.igc', fixes: fixes2 },
    ];

    const result = scoreTask(standardTask, pilots, {
      nominalDistance: 10000,
      nominalTime: 600,
    });

    expect(result.pilotScores).toHaveLength(2);
    expect(result.pilotScores[0].pilotName).toBe('Fast');
    expect(result.pilotScores[1].pilotName).toBe('Slow');
    expect(result.pilotScores[0].totalScore).toBeGreaterThan(result.pilotScores[1].totalScore);
    expect(result.pilotScores[0].rank).toBe(1);
    expect(result.pilotScores[1].rank).toBe(2);
  });

  it('returns task validity info', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, { nominalDistance: 10000, nominalTime: 600 });

    expect(result.taskValidity.launch).toBeGreaterThan(0);
    expect(result.taskValidity.distance).toBeGreaterThan(0);
    expect(result.taskValidity.time).toBeGreaterThan(0);
    expect(result.taskValidity.task).toBeGreaterThan(0);
    expect(result.taskValidity.task).toBeLessThanOrEqual(1);
  });

  it('returns available points breakdown', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, { nominalDistance: 10000, nominalTime: 600 });

    expect(result.availablePoints.total).toBeGreaterThan(0);
    expect(result.availablePoints.total).toBeLessThanOrEqual(1000);
    const sum = result.availablePoints.distance + result.availablePoints.time +
      result.availablePoints.leading + result.availablePoints.arrival;
    expect(sum).toBeCloseTo(result.availablePoints.total, 0);
  });

  it('returns aggregate stats', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, { nominalDistance: 10000, nominalTime: 600 });

    expect(result.stats.numFlying).toBe(1);
    expect(result.stats.numPresent).toBe(1);
    expect(result.stats.taskDistance).toBeGreaterThan(0);
    expect(result.stats.bestDistance).toBeGreaterThan(0);
  });

  it('handles zero pilots gracefully', () => {
    const result = scoreTask(standardTask, [], { nominalDistance: 10000 });
    expect(result.pilotScores).toHaveLength(0);
    expect(result.taskValidity.task).toBe(0);
  });

  it('handles ties in scoring', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
      { pilotName: 'Bob', trackFile: 'bob.igc', fixes }, // same track = same score
    ];

    const result = scoreTask(standardTask, pilots, { nominalDistance: 10000, nominalTime: 600 });
    expect(result.pilotScores[0].rank).toBe(1);
    expect(result.pilotScores[1].rank).toBe(1); // tied
  });

  it('uses HG scoring by default (no leading/arrival points)', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, { nominalDistance: 10000, nominalTime: 600 });
    expect(result.parameters.scoring).toBe('HG');
    expect(result.weights.arrival).toBe(0);
    expect(result.weights.leading).toBe(0);
    expect(result.pilotScores[0].arrivalPoints).toBe(0);
    expect(result.pilotScores[0].leadingPoints).toBe(0);
  });

  it('applies minimum distance floor for short flights', () => {
    // One goal pilot + one short pilot to keep task validity > 0
    const goalFixes = createTrackThroughCylinders(standardWaypoints);
    const shortFixes = [
      createFix(0, 47.0 - 0.05, 11.0),
      createFix(5, 47.0 - 0.04, 11.0),
      createFix(10, 47.0 - 0.03, 11.0),
    ];
    const pilots: PilotFlight[] = [
      { pilotName: 'Goal', trackFile: 'goal.igc', fixes: goalFixes },
      { pilotName: 'Short', trackFile: 'short.igc', fixes: shortFixes },
    ];

    const result = scoreTask(standardTask, pilots, {
      nominalDistance: 10000,
      nominalTime: 600,
      minimumDistance: 5000,
    });

    const shortPilot = result.pilotScores.find(p => p.pilotName === 'Short')!;
    // Flown distance should be at least minimumDistance
    expect(shortPilot.flownDistance).toBeGreaterThanOrEqual(5000);
    expect(shortPilot.distancePoints).toBeGreaterThan(0);
    expect(shortPilot.totalScore).toBeGreaterThanOrEqual(0);
  });

  it('never produces negative scores', () => {
    // Pilot who doesn't move at all
    const fixes = [
      createFix(0, 47.0, 11.5),
      createFix(5, 47.0, 11.5),
    ];
    const pilots: PilotFlight[] = [
      { pilotName: 'Static', trackFile: 'static.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, { nominalDistance: 10000, nominalTime: 600 });
    expect(result.pilotScores[0].totalScore).toBeGreaterThanOrEqual(0);
    expect(result.pilotScores[0].flownDistance).toBeGreaterThanOrEqual(0);
  });

  it('disables leading points when useLeading=false', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, {
      nominalDistance: 10000,
      nominalTime: 600,
      useLeading: false,
    });

    expect(result.weights.leading).toBe(0);
    expect(result.availablePoints.leading).toBe(0);
    expect(result.pilotScores[0].leadingPoints).toBe(0);
    // Time weight should absorb the leading weight
    expect(result.weights.time).toBeGreaterThan(0);
  });

  it('awards full leading points to the leader when useLeading=true', () => {
    const leader = createTrackThroughCylinders(standardWaypoints, { fixIntervalMinutes: 1 });
    const laggard = createTrackThroughCylinders(standardWaypoints, { fixIntervalMinutes: 3 });
    const pilots: PilotFlight[] = [
      { pilotName: 'Leader', trackFile: 'leader.igc', fixes: leader },
      { pilotName: 'Laggard', trackFile: 'laggard.igc', fixes: laggard },
    ];

    const result = scoreTask(standardTask, pilots, {
      nominalDistance: 20000,
      nominalTime: 1800,
      useLeading: true,
    });

    const L = result.pilotScores.find(p => p.pilotName === 'Leader')!;
    const G = result.pilotScores.find(p => p.pilotName === 'Laggard')!;
    expect(result.availablePoints.leading).toBeGreaterThan(0);
    expect(L.leadingCoefficient).toBeLessThan(G.leadingCoefficient);
    // Best LC ⇒ full available leading points (LeadingFactor = 1).
    expect(L.leadingPoints).toBeCloseTo(result.availablePoints.leading, 1);
    expect(G.leadingPoints).toBeLessThan(L.leadingPoints);
    expect(G.leadingPoints).toBeGreaterThanOrEqual(0);
  });

  it('disables arrival points when useArrival=false for HG', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, {
      nominalDistance: 10000,
      nominalTime: 600,
      scoring: 'HG',
      useArrival: false,
    });

    expect(result.weights.arrival).toBe(0);
    expect(result.availablePoints.arrival).toBe(0);
    expect(result.pilotScores[0].arrivalPoints).toBe(0);
  });

  it('all non-distance points go to speed when leading+arrival disabled for HG', () => {
    const fixes = createTrackThroughCylinders(standardWaypoints);
    const pilots: PilotFlight[] = [
      { pilotName: 'Alice', trackFile: 'alice.igc', fixes },
    ];

    const result = scoreTask(standardTask, pilots, {
      nominalDistance: 10000,
      nominalTime: 600,
      scoring: 'HG',
      useLeading: false,
      useArrival: false,
    });

    expect(result.weights.leading).toBe(0);
    expect(result.weights.arrival).toBe(0);
    // distance + time should equal 1
    expect(result.weights.distance + result.weights.time).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// Minimum Distance
// ---------------------------------------------------------------------------

describe('applyMinimumDistance', () => {
  it('returns minimumDistance for zero distance', () => {
    expect(applyMinimumDistance(0, 5000)).toBe(5000);
  });

  it('returns minimumDistance for negative distance', () => {
    expect(applyMinimumDistance(-1000, 5000)).toBe(5000);
  });

  it('returns minimumDistance for distance below minimum', () => {
    expect(applyMinimumDistance(3000, 5000)).toBe(5000);
  });

  it('returns actual distance when above minimum', () => {
    expect(applyMinimumDistance(10000, 5000)).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// Weight Distribution with useLeading/useArrival flags
// ---------------------------------------------------------------------------

describe('calculateWeights with flags', () => {
  it('disabling leading gives all remainder to time', () => {
    const wWith = calculateWeights(0.3, 80000, 100000, 'PG', true, true);
    const wWithout = calculateWeights(0.3, 80000, 100000, 'PG', false, true);
    expect(wWithout.leading).toBe(0);
    expect(wWithout.time).toBeGreaterThan(wWith.time);
    expect(wWithout.distance + wWithout.time).toBeCloseTo(1, 5);
  });

  it('disabling arrival for HG gives remainder to time', () => {
    const wWith = calculateWeights(0.3, 80000, 100000, 'HG', true, true);
    const wWithout = calculateWeights(0.3, 80000, 100000, 'HG', true, false);
    expect(wWithout.arrival).toBe(0);
    expect(wWithout.time).toBeGreaterThan(wWith.time);
    const sum = wWithout.distance + wWithout.time + wWithout.leading;
    expect(sum).toBeCloseTo(1, 5);
  });

  it('disabling both for HG: dist + time = 1', () => {
    const w = calculateWeights(0.3, 80000, 100000, 'HG', false, false);
    expect(w.leading).toBe(0);
    expect(w.arrival).toBe(0);
    expect(w.distance + w.time).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreFlights — the shared aggregation core that lets the competition
// backend cache per-track analysis and skip re-parsing unchanged tracks.
// ---------------------------------------------------------------------------

describe('scoreFlights (cache-equivalent path)', () => {
  // Two pilots: one completes the task, one only reaches SSS+TP1.
  function buildPilots(): PilotFlight[] {
    return [
      { pilotName: 'Fast', trackFile: 'fast.igc', fixes: createTrackThroughCylinders(standardWaypoints) },
      { pilotName: 'Slow', trackFile: 'slow.igc', fixes: createTrackThroughCylinders(standardWaypoints.slice(0, 2)) },
    ];
  }

  /**
   * Rebuild FlightScoringData exactly as the worker's per-track cache does:
   * resolve → toFlightScoringData → keep only the compact geometric fields →
   * JSON round-trip (as KV storage would) → re-attach fresh pilot name/track.
   */
  function cachedInputs(task: XCTask, pilots: PilotFlight[], useLeading: boolean): FlightScoringData[] {
    const scoringTask = taskForDistanceOrigin(task, DEFAULT_GAP_PARAMETERS.distanceOrigin);
    return pilots.map(p => {
      const result = resolveTurnpointSequence(scoringTask, p.fixes);
      const data = toFlightScoringData(p, result, useLeading);
      if (useLeading) return data; // leading needs fixes/sequence, not cached
      const compact = JSON.parse(JSON.stringify({
        flownDistance: data.flownDistance,
        madeGoal: data.madeGoal,
        reachedESS: data.reachedESS,
        speedSectionTime: data.speedSectionTime,
        sssTimeMs: data.sssTimeMs,
        essTimeMs: data.essTimeMs,
      }));
      return { pilotName: p.pilotName, trackFile: p.trackFile, ...compact };
    });
  }

  it('matches scoreTask for a no-leading HG task (the cached fast path)', () => {
    const pilots = buildPilots();
    const params: Partial<GAPParameters> = { nominalDistance: 10000, nominalTime: 600 };

    const full = scoreTask(standardTask, pilots, params);
    const scoringTask = taskForDistanceOrigin(standardTask, DEFAULT_GAP_PARAMETERS.distanceOrigin);
    const viaCache = scoreFlights(scoringTask, cachedInputs(standardTask, pilots, false), params);

    // Field-level aggregates identical
    expect(viaCache.taskValidity).toEqual(full.taskValidity);
    expect(viaCache.availablePoints).toEqual(full.availablePoints);
    expect(viaCache.stats).toEqual(full.stats);

    // Every pilot's scored output identical (pair by trackFile, the unique key)
    const fullByTrack = new Map(full.pilotScores.map(p => [p.trackFile, p]));
    expect(viaCache.pilotScores).toHaveLength(full.pilotScores.length);
    for (const ps of viaCache.pilotScores) {
      const f = fullByTrack.get(ps.trackFile)!;
      expect(ps.rank).toBe(f.rank);
      expect(ps.totalScore).toBe(f.totalScore);
      expect(ps.distancePoints).toBe(f.distancePoints);
      expect(ps.distanceDifficultyPoints).toBe(f.distanceDifficultyPoints);
      expect(ps.timePoints).toBe(f.timePoints);
      expect(ps.flownDistance).toBe(f.flownDistance);
      expect(ps.madeGoal).toBe(f.madeGoal);
    }
  });

  it('matches scoreTask with leading enabled (fixes/sequence passed through)', () => {
    const pilots = buildPilots();
    const params: Partial<GAPParameters> = {
      nominalDistance: 10000, nominalTime: 600, useLeading: true,
    };

    const full = scoreTask(standardTask, pilots, params);
    const scoringTask = taskForDistanceOrigin(standardTask, DEFAULT_GAP_PARAMETERS.distanceOrigin);
    const viaCore = scoreFlights(scoringTask, cachedInputs(standardTask, pilots, true), params);

    const fullByTrack = new Map(full.pilotScores.map(p => [p.trackFile, p]));
    for (const ps of viaCore.pilotScores) {
      const f = fullByTrack.get(ps.trackFile)!;
      expect(ps.totalScore).toBe(f.totalScore);
      expect(ps.leadingPoints).toBe(f.leadingPoints);
      expect(ps.leadingCoefficient).toBe(f.leadingCoefficient);
    }
  });

  it('throws if leading is enabled but a flight lacks its tracklog', () => {
    const pilots = buildPilots();
    const scoringTask = taskForDistanceOrigin(standardTask, DEFAULT_GAP_PARAMETERS.distanceOrigin);
    // Compact inputs (no fixes/sequence) + useLeading is a programming error.
    const compact = cachedInputs(standardTask, pilots, false);
    expect(() =>
      scoreFlights(scoringTask, compact, { nominalDistance: 10000, useLeading: true }),
    ).toThrow();
  });
});
