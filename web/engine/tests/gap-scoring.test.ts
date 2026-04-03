import { describe, it, expect } from 'bun:test';
import {
  calculateLaunchValidity,
  calculateDistanceValidity,
  calculateTimeValidity,
  calculateTaskValidity,
  calculateWeights,
  calculateDistancePoints,
  calculateSpeedFraction,
  calculateTimePoints,
  calculateLeadingCoefficient,
  calculateLeadingPoints,
  calculateArrivalPoints,
  applyMinimumDistance,
  scoreTask,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type PilotFlight,
} from '../src/gap-scoring';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
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
