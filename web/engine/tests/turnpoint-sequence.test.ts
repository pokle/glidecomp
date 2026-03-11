import { describe, it, expect } from 'bun:test';
import {
  detectCylinderCrossings,
  resolveTurnpointSequence,
} from '../src/turnpoint-sequence';
import type { CylinderCrossing } from '../src/turnpoint-sequence';
import {
  calculateOptimizedTaskDistance,
  getOptimizedSegmentDistances,
} from '../src/task-optimizer';
import { isInsideCylinder, haversineDistance, calculateBearingRadians, destinationPoint } from '../src/geo';
import type { XCTask, Turnpoint, SSSConfig, GoalConfig } from '../src/xctsk-parser';
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
  type?: 'TAKEOFF' | 'SSS' | 'TURNPOINT' | 'ESS' | 'GOAL';
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
      type: d.type || 'TURNPOINT',
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
 *
 * For each cylinder, produces fixes: outside-approach → inside-approach →
 * center → inside-depart → outside-depart. This guarantees at least one
 * enter and one exit crossing per cylinder.
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
  }
): IGCFix[] {
  const fixes: IGCFix[] = [];
  const interval = options?.fixIntervalMinutes ?? 1;
  const buffer = options?.buffer ?? 200;
  const altitude = options?.altitude ?? 1000;
  let timeMin = options?.startTimeMinutes ?? 0;

  // Start position: south of first waypoint, well outside its cylinder
  let currentLat = options?.startLat ?? waypoints[0].lat - 0.05;
  let currentLon = options?.startLon ?? waypoints[0].lon;

  // Starting fix
  fixes.push(createFix(timeMin, currentLat, currentLon, altitude));
  timeMin += interval;

  for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
    const wp = waypoints[wpIdx];

    // Bearing from current position to waypoint center
    const approachBearing = calculateBearingRadians(
      currentLat, currentLon, wp.lat, wp.lon
    );

    // Fix outside cylinder (approaching)
    const outsideApproach = destinationPoint(
      wp.lat, wp.lon, wp.radius + buffer,
      approachBearing + Math.PI
    );
    fixes.push(createFix(timeMin, outsideApproach.lat, outsideApproach.lon, altitude));
    timeMin += interval;

    // Fix inside cylinder (just past boundary)
    const insideApproach = destinationPoint(
      wp.lat, wp.lon, Math.max(wp.radius - buffer, 0),
      approachBearing + Math.PI
    );
    fixes.push(createFix(timeMin, insideApproach.lat, insideApproach.lon, altitude));
    timeMin += interval;

    // Fix at center
    fixes.push(createFix(timeMin, wp.lat, wp.lon, altitude));
    timeMin += interval;

    // Departure bearing
    let departureBearing: number;
    if (wpIdx < waypoints.length - 1) {
      departureBearing = calculateBearingRadians(
        wp.lat, wp.lon,
        waypoints[wpIdx + 1].lat, waypoints[wpIdx + 1].lon
      );
    } else {
      departureBearing = approachBearing;
    }

    // Fix inside cylinder on exit side
    const insideDepart = destinationPoint(
      wp.lat, wp.lon, Math.max(wp.radius - buffer, 0),
      departureBearing
    );
    fixes.push(createFix(timeMin, insideDepart.lat, insideDepart.lon, altitude));
    timeMin += interval;

    // Fix outside cylinder on exit side
    const outsideDepart = destinationPoint(
      wp.lat, wp.lon, wp.radius + buffer,
      departureBearing
    );
    fixes.push(createFix(timeMin, outsideDepart.lat, outsideDepart.lon, altitude));
    timeMin += interval;

    currentLat = outsideDepart.lat;
    currentLon = outsideDepart.lon;
  }

  return fixes;
}

// ---------------------------------------------------------------------------
// Standard task layouts
// ---------------------------------------------------------------------------

/** 3-position task: SSS → TP1 → ESS */
function threePointTask(): XCTask {
  return createTask([
    { name: 'SSS', lat: 47.0, lon: 11.0, radius: 1000, type: 'SSS' },
    { name: 'TP1', lat: 47.0, lon: 11.13, radius: 400 },
    { name: 'ESS', lat: 47.0, lon: 11.26, radius: 400, type: 'ESS' },
  ]);
}

/** 4-position task: SSS → TP1 → TP2 → ESS */
function fourPointTask(): XCTask {
  return createTask([
    { name: 'SSS', lat: 47.0, lon: 11.0, radius: 1000, type: 'SSS' },
    { name: 'TP1', lat: 47.0, lon: 11.13, radius: 400 },
    { name: 'TP2', lat: 47.0, lon: 11.26, radius: 400 },
    { name: 'ESS', lat: 47.0, lon: 11.39, radius: 400, type: 'ESS' },
  ]);
}

// ---------------------------------------------------------------------------
// Tests: detectCylinderCrossings
// ---------------------------------------------------------------------------

describe('detectCylinderCrossings', () => {
  it('S13: empty track returns no crossings', () => {
    const task = threePointTask();
    expect(detectCylinderCrossings(task, [])).toEqual([]);
  });

  it('S13: single fix returns no crossings', () => {
    const task = threePointTask();
    const fixes = [createFix(0, 47.0, 11.0)];
    expect(detectCylinderCrossings(task, fixes)).toEqual([]);
  });

  it('S12: track starts inside cylinder detects exit', () => {
    const task = threePointTask();
    // Start at SSS center (inside 1000m cylinder), move east outside
    const fixes = [
      createFix(0, 47.0, 11.0),     // at center (inside)
      createFix(2, 47.0, 11.005),   // still inside (~370m east)
      createFix(4, 47.0, 11.015),   // outside (~1110m east)
    ];

    const crossings = detectCylinderCrossings(task, fixes);
    const sssCrossings = crossings.filter(c => c.taskIndex === 0);

    expect(sssCrossings.length).toBeGreaterThanOrEqual(1);
    // Should be an exit (was inside, now outside)
    const exitCrossing = sssCrossings.find(c => c.direction === 'exit');
    expect(exitCrossing).toBeDefined();
    expect(exitCrossing!.fixIndex).toBe(2);
    // No enter crossing (track started inside)
    const enterCrossing = sssCrossings.find(c => c.direction === 'enter');
    expect(enterCrossing).toBeUndefined();
  });

  it('S11: thermalling near boundary produces multiple crossings', () => {
    const task = threePointTask();
    const tp1 = task.turnpoints[1]; // TP1 at 47.0, 11.13 with 400m radius

    // Create fixes that oscillate across TP1 boundary
    // At 47°N, 0.001° lon ≈ 75m. 400m radius ≈ 0.0054° offset
    const center = { lat: tp1.waypoint.lat, lon: tp1.waypoint.lon };
    const r = tp1.radius;
    const inside = 0.7; // fraction of radius for inside fixes
    const outside = 1.3; // fraction of radius for outside fixes

    const fixes: IGCFix[] = [];
    let t = 0;

    // 4 oscillations across the boundary (east side of cylinder)
    for (let i = 0; i < 4; i++) {
      // Outside
      const outPt = destinationPoint(center.lat, center.lon, r * outside, 0);
      fixes.push(createFix(t, outPt.lat, outPt.lon));
      t += 1;
      // Inside
      const inPt = destinationPoint(center.lat, center.lon, r * inside, 0);
      fixes.push(createFix(t, inPt.lat, inPt.lon));
      t += 1;
    }
    // Final outside
    const finalOut = destinationPoint(center.lat, center.lon, r * outside, 0);
    fixes.push(createFix(t, finalOut.lat, finalOut.lon));

    const crossings = detectCylinderCrossings(task, fixes);
    const tp1Crossings = crossings.filter(c => c.taskIndex === 1);

    // 4 enters + 4 exits = 8 crossings
    expect(tp1Crossings).toHaveLength(8);
    const enters = tp1Crossings.filter(c => c.direction === 'enter');
    const exits = tp1Crossings.filter(c => c.direction === 'exit');
    expect(enters).toHaveLength(4);
    expect(exits).toHaveLength(4);

    // Time ordering preserved
    for (let i = 1; i < tp1Crossings.length; i++) {
      expect(tp1Crossings[i].time.getTime()).toBeGreaterThan(
        tp1Crossings[i - 1].time.getTime()
      );
    }
  });

  it('crossing altitude is interpolated between bracketing fixes', () => {
    const task = threePointTask();
    // Fixes at different altitudes: 800m outside, 1200m inside
    const fixes = [
      createFix(0, 47.0, 10.985, 800),   // outside SSS
      createFix(2, 47.0, 11.0, 1200),     // inside SSS (center)
    ];

    const crossings = detectCylinderCrossings(task, fixes);
    const sssCrossings = crossings.filter(c => c.taskIndex === 0);
    expect(sssCrossings.length).toBeGreaterThanOrEqual(1);

    // Altitude should be interpolated between 800 and 1200
    for (const c of sssCrossings) {
      expect(c.altitude).toBeGreaterThan(800);
      expect(c.altitude).toBeLessThan(1200);
    }
  });

  it('crossing interpolation is close to cylinder radius', () => {
    const task = threePointTask();
    const track = createTrackThroughCylinders([
      { lat: 47.0, lon: 11.0, radius: 1000 },
    ]);

    const crossings = detectCylinderCrossings(task, track);
    for (const c of crossings.filter(x => x.taskIndex === 0)) {
      // distanceToCenter should be very close to the radius (1000m)
      expect(c.distanceToCenter).toBeCloseTo(1000, -2); // within 100m
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveTurnpointSequence — Happy path
// ---------------------------------------------------------------------------

describe('resolveTurnpointSequence', () => {
  describe('Happy path', () => {
    it('S1: simple goal flight (SSS → TP1 → ESS)', () => {
      const task = threePointTask();
      const track = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },
        { lat: 47.0, lon: 11.13, radius: 400 },
        { lat: 47.0, lon: 11.26, radius: 400 },
      ]);

      const result = resolveTurnpointSequence(task, track);

      expect(result.sequence).toHaveLength(3);
      expect(result.madeGoal).toBe(true);
      expect(result.lastTurnpointReached).toBe(2);
      expect(result.bestProgress).toBeNull();

      // SSS reaching
      expect(result.sssReaching).not.toBeNull();
      expect(result.sssReaching!.taskIndex).toBe(0);
      expect(result.sssReaching!.selectionReason).toBe('last_before_next');

      // TP1 reaching
      expect(result.sequence[1].taskIndex).toBe(1);
      expect(result.sequence[1].selectionReason).toBe('first_after_previous');

      // ESS reaching
      expect(result.essReaching).not.toBeNull();
      expect(result.essReaching!.taskIndex).toBe(2);
      expect(result.essReaching!.selectionReason).toBe('first_crossing');

      // Distance
      expect(result.flownDistance).toBe(result.taskDistance);
      expect(result.taskDistance).toBeGreaterThan(0);

      // Legs
      expect(result.legs).toHaveLength(2);
      expect(result.legs[0].completed).toBe(true);
      expect(result.legs[1].completed).toBe(true);

      // Speed section time
      expect(result.speedSectionTime).not.toBeNull();
      expect(result.speedSectionTime!).toBeGreaterThan(0);

      // Temporal ordering
      expect(result.sequence[1].time.getTime()).toBeGreaterThan(
        result.sequence[0].time.getTime()
      );
      expect(result.sequence[2].time.getTime()).toBeGreaterThan(
        result.sequence[1].time.getTime()
      );
    });

    it('reachings include interpolated altitude', () => {
      const task = threePointTask();
      // Use varying altitudes so interpolation is visible
      const waypoints = [
        { lat: 47.0, lon: 11.0, radius: 1000 },
        { lat: 47.0, lon: 11.13, radius: 400 },
        { lat: 47.0, lon: 11.26, radius: 400 },
      ];
      const track = createTrackThroughCylinders(waypoints, { altitude: 1500 });

      const result = resolveTurnpointSequence(task, track);

      expect(result.sequence).toHaveLength(3);
      // All reachings should have an altitude field that's a finite number
      for (const reaching of result.sequence) {
        expect(typeof reaching.altitude).toBe('number');
        expect(Number.isFinite(reaching.altitude)).toBe(true);
        // With constant altitude=1500 in track helper, altitude should be 1500
        expect(reaching.altitude).toBe(1500);
      }
    });

    it('S2: four-position goal flight (SSS → TP1 → TP2 → ESS)', () => {
      const task = fourPointTask();
      const track = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },
        { lat: 47.0, lon: 11.13, radius: 400 },
        { lat: 47.0, lon: 11.26, radius: 400 },
        { lat: 47.0, lon: 11.39, radius: 400 },
      ]);

      const result = resolveTurnpointSequence(task, track);

      expect(result.sequence).toHaveLength(4);
      expect(result.madeGoal).toBe(true);

      // Selection reasons
      expect(result.sequence[0].selectionReason).toBe('last_before_next');
      expect(result.sequence[1].selectionReason).toBe('first_after_previous');
      expect(result.sequence[2].selectionReason).toBe('first_after_previous');
      expect(result.sequence[3].selectionReason).toBe('first_crossing');

      // Legs
      expect(result.legs).toHaveLength(3);
      expect(result.legs.every(l => l.completed)).toBe(true);

      // Leg distances should sum to approximately taskDistance
      const legSum = result.legs.reduce((s, l) => s + l.distance, 0);
      expect(legSum).toBeCloseTo(result.taskDistance, -2);
    });
  });

  // ---------------------------------------------------------------------------
  // Partial flights
  // ---------------------------------------------------------------------------

  describe('Partial flights', () => {
    it('S3: no start — track far from SSS', () => {
      const task = threePointTask();
      // Fly far north of all cylinders
      const fixes = [
        createFix(0, 47.05, 10.95),
        createFix(5, 47.05, 11.00),
        createFix(10, 47.05, 11.05),
        createFix(15, 47.05, 11.10),
        createFix(20, 47.05, 11.15),
      ];

      const result = resolveTurnpointSequence(task, fixes);

      expect(result.sequence).toHaveLength(0);
      expect(result.sssReaching).toBeNull();
      expect(result.essReaching).toBeNull();
      expect(result.madeGoal).toBe(false);
      expect(result.lastTurnpointReached).toBe(-1);
      expect(result.bestProgress).toBeNull();
      expect(result.flownDistance).toBe(0);
      expect(result.speedSectionTime).toBeNull();
      expect(result.legs.every(l => !l.completed)).toBe(true);
    });

    it('S4: start but no further', () => {
      const task = threePointTask();
      // Start inside SSS, exit, fly partway to TP1
      const fixes = [
        createFix(0, 47.0, 11.0),      // SSS center
        createFix(2, 47.0, 11.005),    // inside SSS
        createFix(4, 47.0, 11.015),    // outside SSS (crossed boundary)
        createFix(6, 47.0, 11.03),     // flying toward TP1
        createFix(8, 47.0, 11.04),     // still far from TP1 (400m radius at 11.13)
      ];

      const result = resolveTurnpointSequence(task, fixes);

      expect(result.sequence).toHaveLength(1); // SSS only
      expect(result.sssReaching).not.toBeNull();
      expect(result.madeGoal).toBe(false);
      expect(result.lastTurnpointReached).toBe(0);
      expect(result.bestProgress).not.toBeNull();
      expect(result.bestProgress!.distanceToGoal).toBeGreaterThan(0);
      expect(result.flownDistance).toBeGreaterThan(0);
      expect(result.flownDistance).toBeLessThan(result.taskDistance);
      expect(result.speedSectionTime).toBeNull();
    });

    it('S5: reaches TP1 only in 4-position task', () => {
      const task = fourPointTask();

      // Fly through SSS and TP1, then halfway toward TP2
      const throughTwo = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },
        { lat: 47.0, lon: 11.13, radius: 400 },
      ]);
      // Add fixes partway to TP2 (at lon 11.26)
      const lastFix = throughTwo[throughTwo.length - 1];
      const lastTime = (lastFix.time.getTime() - BASE_TIME.getTime()) / 60_000;
      const extraFixes = [
        createFix(lastTime + 2, 47.0, 11.18),
        createFix(lastTime + 4, 47.0, 11.20),
      ];
      const track = [...throughTwo, ...extraFixes];

      const result = resolveTurnpointSequence(task, track);

      expect(result.sequence).toHaveLength(2); // SSS + TP1
      expect(result.madeGoal).toBe(false);
      expect(result.lastTurnpointReached).toBe(1);
      expect(result.legs[0].completed).toBe(true);
      expect(result.legs[1].completed).toBe(false);
      expect(result.legs[2].completed).toBe(false);
      expect(result.bestProgress).not.toBeNull();
      expect(result.flownDistance).toBeGreaterThan(0);
      expect(result.flownDistance).toBeLessThan(result.taskDistance);
      // CIVL GAP formula: flownDistance = taskDistance - bestProgress.distanceToGoal
      expect(result.flownDistance).toBeCloseTo(
        result.taskDistance - result.bestProgress!.distanceToGoal,
        -1
      );
    });
  });

  // ---------------------------------------------------------------------------
  // SSS selection rules
  // ---------------------------------------------------------------------------

  describe('SSS selection', () => {
    it('S6: multiple SSS crossings — last before next is selected', () => {
      const task = threePointTask();
      const sss = task.turnpoints[0];
      const r = sss.radius;
      const center = { lat: sss.waypoint.lat, lon: sss.waypoint.lon };

      // Build track: 3 oscillations across SSS boundary, then fly to TP1 + ESS
      const fixes: IGCFix[] = [];
      let t = 0;

      // Start outside SSS (west)
      const westOut = destinationPoint(center.lat, center.lon, r + 300, Math.PI); // south
      fixes.push(createFix(t, westOut.lat, westOut.lon));
      t += 2;

      // 3 enter-exit oscillations
      for (let i = 0; i < 3; i++) {
        // Enter (inside)
        const inPt = destinationPoint(center.lat, center.lon, r * 0.5, 0);
        fixes.push(createFix(t, inPt.lat, inPt.lon));
        t += 2;
        // Exit (outside, going east)
        const outPt = destinationPoint(center.lat, center.lon, r + 300, 0);
        fixes.push(createFix(t, outPt.lat, outPt.lon));
        t += 2;
      }

      // Now fly through TP1 and ESS
      const throughRest = createTrackThroughCylinders(
        [
          { lat: 47.0, lon: 11.13, radius: 400 },
          { lat: 47.0, lon: 11.26, radius: 400 },
        ],
        { startTimeMinutes: t, startLat: fixes[fixes.length - 1].latitude, startLon: fixes[fixes.length - 1].longitude }
      );
      fixes.push(...throughRest);

      const result = resolveTurnpointSequence(task, fixes);

      expect(result.madeGoal).toBe(true);
      expect(result.sssReaching).not.toBeNull();
      expect(result.sssReaching!.selectionReason).toBe('last_before_next');

      // candidateCount should be total SSS crossings (6 = 3 enter + 3 exit)
      expect(result.sssReaching!.candidateCount).toBe(6);

      // The SSS reaching should be the last crossing (3rd exit)
      // Its time should be after the oscillations
      const sssCrossings = result.crossings.filter(c => c.taskIndex === 0);
      const lastSSS = sssCrossings[sssCrossings.length - 1];
      expect(result.sssReaching!.time.getTime()).toBe(lastSSS.time.getTime());
    });

    it('S7: re-fly — pilot restarts after tagging TP1', () => {
      const task = threePointTask();
      const sssCenter = { lat: 47.0, lon: 11.0 };
      const tp1Center = { lat: 47.0, lon: 11.13 };

      // Phase 1: Cross SSS, tag TP1
      const fixes: IGCFix[] = [];
      let t = 0;

      // Start outside SSS
      fixes.push(createFix(t, 47.0, 10.985)); t += 2;
      // Enter SSS
      fixes.push(createFix(t, 47.0, 10.995)); t += 2;
      // Exit SSS heading east (1st SSS crossing)
      fixes.push(createFix(t, 47.0, 11.015)); t += 2;
      // Fly to TP1 - approach
      fixes.push(createFix(t, 47.0, 11.12)); t += 2;
      // Enter TP1 (1st TP1 crossing)
      fixes.push(createFix(t, 47.0, 11.13)); t += 2;
      // Exit TP1
      fixes.push(createFix(t, 47.0, 11.14)); t += 2;

      // Phase 2: Fly back through SSS
      fixes.push(createFix(t, 47.0, 11.05)); t += 2;
      // Re-enter SSS
      fixes.push(createFix(t, 47.0, 10.995)); t += 2;
      // Re-exit SSS (2nd SSS crossing)
      fixes.push(createFix(t, 47.0, 11.015)); t += 2;

      // Phase 3: Tag TP1 again
      fixes.push(createFix(t, 47.0, 11.12)); t += 2;
      // Enter TP1 (2nd TP1 crossing)
      fixes.push(createFix(t, 47.0, 11.13)); t += 2;
      // Exit TP1
      fixes.push(createFix(t, 47.0, 11.14)); t += 2;

      // Phase 4: Continue to ESS
      const throughESS = createTrackThroughCylinders(
        [{ lat: 47.0, lon: 11.26, radius: 400 }],
        { startTimeMinutes: t, startLat: 47.0, startLon: 11.14 }
      );
      fixes.push(...throughESS);

      const result = resolveTurnpointSequence(task, fixes);

      expect(result.madeGoal).toBe(true);
      expect(result.sssReaching).not.toBeNull();

      // The later SSS crossing should be preferred (gives valid path
      // using later TP1 + ESS crossings)
      // Find all SSS crossings and verify the selected one is the last viable
      const sssCrossings = result.crossings.filter(c => c.taskIndex === 0);
      expect(sssCrossings.length).toBeGreaterThanOrEqual(3); // enter + exit + re-enter + re-exit

      // SSS time should be from the re-fly (later crossing)
      const firstSSSExit = sssCrossings.find(c => c.direction === 'exit');
      const lastSSSExit = [...sssCrossings].reverse().find(c => c.direction === 'exit');
      expect(result.sssReaching!.time.getTime()).toBe(lastSSSExit!.time.getTime());
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases from research
  // ---------------------------------------------------------------------------

  describe('Edge cases', () => {
    it('S8: shared waypoint — same cylinder at positions 0 and 2', () => {
      // Task: ELLIOT(SSS) → KANGCK → ELLIOT(TP2) → GOAL
      const task = createTask([
        { name: 'ELLIOT', lat: 47.0, lon: 11.0, radius: 1000, type: 'SSS' },
        { name: 'KANGCK', lat: 47.0, lon: 11.13, radius: 400 },
        { name: 'ELLIOT', lat: 47.0, lon: 11.0, radius: 1000 },
        { name: 'GOAL', lat: 47.0, lon: 11.26, radius: 400, type: 'ESS' },
      ]);

      // Track: start inside ELLIOT, exit east → fly to KANGCK → fly back to ELLIOT → fly to GOAL
      const fixes: IGCFix[] = [];
      let t = 0;

      // Phase 1: Inside ELLIOT, exit east
      fixes.push(createFix(t, 47.0, 11.0)); t += 2;       // inside ELLIOT
      fixes.push(createFix(t, 47.0, 11.005)); t += 2;     // inside
      fixes.push(createFix(t, 47.0, 11.015)); t += 2;     // outside (exit ELLIOT)

      // Phase 2: Fly to KANGCK, enter/exit
      fixes.push(createFix(t, 47.0, 11.10)); t += 2;
      fixes.push(createFix(t, 47.0, 11.125)); t += 2;     // inside KANGCK (400m radius)
      fixes.push(createFix(t, 47.0, 11.13)); t += 2;      // center
      fixes.push(createFix(t, 47.0, 11.14)); t += 2;      // outside KANGCK

      // Phase 3: Fly back to ELLIOT, enter and exit
      fixes.push(createFix(t, 47.0, 11.05)); t += 2;
      fixes.push(createFix(t, 47.0, 11.01)); t += 2;      // inside ELLIOT (re-enter)
      fixes.push(createFix(t, 47.0, 11.0)); t += 2;       // center
      fixes.push(createFix(t, 47.0, 10.99)); t += 2;      // still inside
      fixes.push(createFix(t, 47.0, 11.005)); t += 2;     // inside
      fixes.push(createFix(t, 47.0, 11.015)); t += 2;     // outside (exit east)

      // Phase 4: Fly to GOAL
      const throughGoal = createTrackThroughCylinders(
        [{ lat: 47.0, lon: 11.26, radius: 400 }],
        { startTimeMinutes: t, startLat: 47.0, startLon: 11.015 }
      );
      fixes.push(...throughGoal);

      const result = resolveTurnpointSequence(task, fixes);

      expect(result.madeGoal).toBe(true);
      expect(result.sequence).toHaveLength(4);

      // SSS (ELLIOT position 0): should be the first exit (before KANGCK)
      expect(result.sequence[0].taskIndex).toBe(0);
      expect(result.sequence[0].selectionReason).toBe('last_before_next');

      // KANGCK (position 1)
      expect(result.sequence[1].taskIndex).toBe(1);
      expect(result.sequence[1].time.getTime()).toBeGreaterThan(
        result.sequence[0].time.getTime()
      );

      // ELLIOT as TP2 (position 2): must be after KANGCK was reached
      expect(result.sequence[2].taskIndex).toBe(2);
      expect(result.sequence[2].time.getTime()).toBeGreaterThan(
        result.sequence[1].time.getTime()
      );

      // GOAL (position 3)
      expect(result.sequence[3].taskIndex).toBe(3);
    });

    it('S9: later TP inside SSS cylinder — spurious SSS crossings', () => {
      // SSS has 3000m radius, TP2 is 740m from SSS center (inside SSS)
      const task = createTask([
        { name: 'SSS', lat: 47.0, lon: 11.0, radius: 3000, type: 'SSS' },
        { name: 'TP1', lat: 47.0, lon: 11.13, radius: 400 },
        { name: 'TP2', lat: 47.0, lon: 11.01, radius: 400 },
        { name: 'ESS', lat: 47.0, lon: 11.26, radius: 400, type: 'ESS' },
      ]);

      // Verify TP2 is inside SSS
      expect(isInsideCylinder(47.0, 11.01, 47.0, 11.0, 3000)).toBe(true);

      const fixes: IGCFix[] = [];
      let t = 0;

      // Start at SSS center, fly east, exit SSS (original start)
      fixes.push(createFix(t, 47.0, 11.0)); t += 2;
      fixes.push(createFix(t, 47.0, 11.02)); t += 2;
      fixes.push(createFix(t, 47.0, 11.045)); t += 2;  // still inside 3000m
      // Exit SSS (~3000m = ~0.04° lon at 47°N)
      fixes.push(createFix(t, 47.0, 11.06)); t += 2;   // outside SSS

      // Fly to TP1
      fixes.push(createFix(t, 47.0, 11.10)); t += 2;
      fixes.push(createFix(t, 47.0, 11.125)); t += 2;
      fixes.push(createFix(t, 47.0, 11.13)); t += 2;   // TP1 center
      fixes.push(createFix(t, 47.0, 11.14)); t += 2;   // exit TP1

      // Fly back west toward TP2 — re-enter SSS (spurious SSS crossing!)
      fixes.push(createFix(t, 47.0, 11.06)); t += 2;
      fixes.push(createFix(t, 47.0, 11.04)); t += 2;   // re-enter SSS
      // Reach TP2 (inside SSS)
      fixes.push(createFix(t, 47.0, 11.005)); t += 2;
      fixes.push(createFix(t, 47.0, 11.01)); t += 2;   // TP2 center
      fixes.push(createFix(t, 47.0, 11.02)); t += 2;

      // Exit SSS again heading to ESS (another spurious SSS crossing!)
      fixes.push(createFix(t, 47.0, 11.045)); t += 2;
      fixes.push(createFix(t, 47.0, 11.06)); t += 2;   // exit SSS

      // Fly to ESS
      const throughESS = createTrackThroughCylinders(
        [{ lat: 47.0, lon: 11.26, radius: 400 }],
        { startTimeMinutes: t, startLat: 47.0, startLon: 11.06 }
      );
      fixes.push(...throughESS);

      const result = resolveTurnpointSequence(task, fixes);

      // Should make goal with correct sequence
      expect(result.madeGoal).toBe(true);
      expect(result.sequence).toHaveLength(4);

      // SSS should be the ORIGINAL exit, NOT the spurious re-entry/re-exit
      // The original SSS should be before TP1
      expect(result.sssReaching!.time.getTime()).toBeLessThan(
        result.sequence[1].time.getTime() // TP1 reaching time
      );

      // Verify SSS had multiple crossings (original + spurious)
      const sssCrossings = result.crossings.filter(c => c.taskIndex === 0);
      expect(sssCrossings.length).toBeGreaterThanOrEqual(2);
    });

    it('S10: ESS first-crossing rule — re-entry ignored', () => {
      const task = threePointTask();
      const essCenter = task.turnpoints[2].waypoint;
      const essR = task.turnpoints[2].radius;

      // Fly through SSS and TP1
      const throughTP1 = createTrackThroughCylinders(
        [
          { lat: 47.0, lon: 11.0, radius: 1000 },
          { lat: 47.0, lon: 11.13, radius: 400 },
        ],
      );
      const lastFix = throughTP1[throughTP1.length - 1];
      let t = (lastFix.time.getTime() - BASE_TIME.getTime()) / 60_000;

      const fixes = [...throughTP1];

      // Approach ESS
      fixes.push(createFix(t + 2, 47.0, 11.25));
      // Enter ESS (1st crossing — should be the scored one)
      fixes.push(createFix(t + 4, 47.0, 11.257));
      // Center
      fixes.push(createFix(t + 6, 47.0, 11.26));
      // Exit ESS
      fixes.push(createFix(t + 8, 47.0, 11.27));
      // Re-enter ESS
      fixes.push(createFix(t + 10, 47.0, 11.257));
      // Stay inside
      fixes.push(createFix(t + 12, 47.0, 11.26));

      const result = resolveTurnpointSequence(task, fixes);

      expect(result.madeGoal).toBe(true);
      expect(result.essReaching).not.toBeNull();
      expect(result.essReaching!.selectionReason).toBe('first_crossing');

      // candidateCount should reflect all ESS crossings
      expect(result.essReaching!.candidateCount).toBeGreaterThanOrEqual(3);

      // The ESS time should be the FIRST crossing, not the re-entry
      const essCrossings = result.crossings.filter(c => c.taskIndex === 2);
      const firstESSCrossing = essCrossings[0];
      expect(result.essReaching!.time.getTime()).toBe(
        firstESSCrossing.time.getTime()
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Distance calculations
  // ---------------------------------------------------------------------------

  describe('Distance calculations', () => {
    it('S14: goal pilot — flownDistance equals taskDistance', () => {
      const task = fourPointTask();
      const track = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },
        { lat: 47.0, lon: 11.13, radius: 400 },
        { lat: 47.0, lon: 11.26, radius: 400 },
        { lat: 47.0, lon: 11.39, radius: 400 },
      ]);

      const result = resolveTurnpointSequence(task, track);

      expect(result.madeGoal).toBe(true);
      expect(result.flownDistance).toBe(result.taskDistance);
      expect(result.taskDistance).toBe(calculateOptimizedTaskDistance(task));
      expect(result.legs.every(l => l.completed)).toBe(true);

      // Leg distances from result should match task-optimizer
      const expectedSegments = getOptimizedSegmentDistances(task);
      for (let i = 0; i < result.legs.length; i++) {
        expect(result.legs[i].distance).toBeCloseTo(expectedSegments[i], -1);
      }
    });

    it('S15: non-goal pilot — distance formula', () => {
      const task = fourPointTask();
      const throughTP1 = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },
        { lat: 47.0, lon: 11.13, radius: 400 },
      ]);
      const lastFix = throughTP1[throughTP1.length - 1];
      const lastTime = (lastFix.time.getTime() - BASE_TIME.getTime()) / 60_000;
      const track = [
        ...throughTP1,
        createFix(lastTime + 2, 47.0, 11.18),
        createFix(lastTime + 4, 47.0, 11.20),
      ];

      const result = resolveTurnpointSequence(task, track);

      expect(result.madeGoal).toBe(false);
      expect(result.bestProgress).not.toBeNull();

      // CIVL GAP: flownDistance = taskDistance - bestProgress.distanceToGoal
      expect(result.flownDistance).toBeCloseTo(
        result.taskDistance - result.bestProgress!.distanceToGoal,
        -1
      );

      // First leg distance matches optimizer
      const expectedSegments = getOptimizedSegmentDistances(task);
      expect(result.legs[0].distance).toBeCloseTo(expectedSegments[0], -1);
      expect(result.legs[0].completed).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // BUG-05: SSS crossing direction validation
  // ---------------------------------------------------------------------------
  describe('SSS crossing direction filtering', () => {
    // Task: TAKEOFF → SSS (radius 3000m) → TP → GOAL
    const sssTurnpoints: TaskDef[] = [
      { name: 'TAKEOFF', lat: 47.0, lon: 11.0, radius: 400, type: 'TAKEOFF' },
      { name: 'SSS', lat: 47.05, lon: 11.0, radius: 3000, type: 'SSS' },
      { name: 'TP1', lat: 47.15, lon: 11.0, radius: 1000 },
      { name: 'GOAL', lat: 47.25, lon: 11.0, radius: 1000 },
    ];

    it('uses only EXIT crossings when sss.direction is EXIT', () => {
      const task = createTask(sssTurnpoints, { direction: 'EXIT' });
      // Fly through all cylinders (generates both enter and exit crossings)
      const track = createTrackThroughCylinders(
        sssTurnpoints.map(d => ({ lat: d.lat, lon: d.lon, radius: d.radius }))
      );

      const result = resolveTurnpointSequence(task, track);

      // Should have started (exit crossing exists)
      expect(result.sssReaching).not.toBeNull();
      // The SSS crossing used should be an exit
      const sssCrossingsUsed = result.crossings.filter(
        c => c.taskIndex === 1 && c.direction === 'exit'
      );
      expect(sssCrossingsUsed.length).toBeGreaterThan(0);
    });

    it('uses only ENTER crossings when sss.direction is ENTER', () => {
      const task = createTask(sssTurnpoints, { direction: 'ENTER' });
      const track = createTrackThroughCylinders(
        sssTurnpoints.map(d => ({ lat: d.lat, lon: d.lon, radius: d.radius }))
      );

      const result = resolveTurnpointSequence(task, track);

      // Should have started (enter crossing exists)
      expect(result.sssReaching).not.toBeNull();
    });

    it('rejects start when pilot only enters but never exits an EXIT-direction SSS (BUG-05)', () => {
      const task = createTask(sssTurnpoints, { direction: 'EXIT' });

      // Create a track that enters the SSS cylinder but never exits it
      // (pilot flies in and lands inside the cylinder)
      const sss = sssTurnpoints[1];
      const track = [
        createFix(0, 47.0, 11.0, 1000),        // at takeoff
        createFix(1, 47.02, 11.0, 1000),        // approaching SSS
        createFix(2, sss.lat - 0.01, sss.lon, 1000), // outside SSS
        createFix(3, sss.lat, sss.lon, 1000),        // inside SSS (entered)
        createFix(4, sss.lat + 0.001, sss.lon, 1000), // still inside SSS
      ];

      const result = resolveTurnpointSequence(task, track);

      // No valid exit crossing → no SSS start
      expect(result.sssReaching).toBeNull();
      expect(result.sequence.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // BUG-12: Best progress should account for un-reached intermediate turnpoints
  // ---------------------------------------------------------------------------
  describe('BUG-12: best progress through un-reached intermediate turnpoints', () => {
    // Task with TP2 far off the direct line from TP1 to Goal.
    // SSS(47.0,11.0) → TP1(47.0,11.1) → TP2(47.1,11.2) → Goal(47.0,11.3)
    //
    // TP2 is ~11km north, so a pilot who tags SSS+TP1 then flies directly
    // toward goal will have a small straight-line distance to goal but a
    // large remaining distance through TP2.
    const offPathTask: TaskDef[] = [
      { name: 'SSS',  lat: 47.0, lon: 11.0, radius: 1000, type: 'SSS' },
      { name: 'TP1',  lat: 47.0, lon: 11.1, radius: 400 },
      { name: 'TP2',  lat: 47.1, lon: 11.2, radius: 400 },
      { name: 'GOAL', lat: 47.0, lon: 11.3, radius: 400, type: 'ESS' },
    ];

    it('remaining distance includes path through missed intermediate TPs', () => {
      const task = createTask(offPathTask);

      // Pilot tags SSS and TP1, then flies directly east toward goal,
      // skipping TP2 (which is far to the north)
      const throughTP1 = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },  // SSS
        { lat: 47.0, lon: 11.1, radius: 400 },    // TP1
      ]);
      const lastFix = throughTP1[throughTP1.length - 1];
      const lastTime = (lastFix.time.getTime() - BASE_TIME.getTime()) / 60_000;

      // Fly east past TP1 toward goal (but NOT through TP2 which is north)
      const track = [
        ...throughTP1,
        createFix(lastTime + 2, 47.0, 11.2),   // directly east
        createFix(lastTime + 4, 47.0, 11.25),  // close to goal in straight line
      ];

      const result = resolveTurnpointSequence(task, track);

      expect(result.madeGoal).toBe(false);
      expect(result.lastTurnpointReached).toBe(1); // TP1
      expect(result.bestProgress).not.toBeNull();

      // The remaining distance must account for the path through TP2.
      // Straight-line from best fix (47.0, 11.25) to goal (47.0, 11.3) is ~3.7km
      // but path through TP2 (47.1, 11.2) is much longer (~11km + ~11km).
      // So distanceToGoal should be >> 3.7km
      const straightLineToGoal = haversineDistance(47.0, 11.25, 47.0, 11.3);
      expect(result.bestProgress!.distanceToGoal).toBeGreaterThan(straightLineToGoal * 2);

      // flownDistance should be less than it would be with straight-line remaining
      const overestimatedFlown = result.taskDistance - straightLineToGoal;
      expect(result.flownDistance).toBeLessThan(overestimatedFlown);
    });

    it('remaining distance is straight-line when next unreached TP is goal', () => {
      // When pilot reaches the TP just before goal, no intermediate TPs are
      // missed, so remaining distance degenerates to straight-line to goal.
      const task = createTask(offPathTask);

      // Pilot tags SSS, TP1, and TP2, but doesn't reach goal
      const throughTP2 = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },  // SSS
        { lat: 47.0, lon: 11.1, radius: 400 },    // TP1
        { lat: 47.1, lon: 11.2, radius: 400 },    // TP2
      ]);
      const lastFix = throughTP2[throughTP2.length - 1];
      const lastTime = (lastFix.time.getTime() - BASE_TIME.getTime()) / 60_000;

      // Fly toward goal but don't reach it
      const track = [
        ...throughTP2,
        createFix(lastTime + 2, 47.05, 11.25),
        createFix(lastTime + 4, 47.02, 11.28),
      ];

      const result = resolveTurnpointSequence(task, track);

      expect(result.madeGoal).toBe(false);
      expect(result.lastTurnpointReached).toBe(2); // TP2

      // With no missed intermediate TPs, distanceToGoal ≈ straight line to goal edge
      const bestLat = result.bestProgress!.latitude;
      const bestLon = result.bestProgress!.longitude;
      const straightDist = Math.max(0, haversineDistance(bestLat, bestLon, 47.0, 11.3) - 400);
      expect(result.bestProgress!.distanceToGoal).toBeCloseTo(straightDist, -2);
    });

    it('multiple missed TPs all contribute to remaining distance', () => {
      // 5-point task: SSS → TP1 → TP2 → TP3 → Goal
      // TP2 and TP3 are both off the direct line
      const fivePointDefs: TaskDef[] = [
        { name: 'SSS',  lat: 47.0, lon: 11.0,  radius: 1000, type: 'SSS' },
        { name: 'TP1',  lat: 47.0, lon: 11.1,  radius: 400 },
        { name: 'TP2',  lat: 47.08, lon: 11.2, radius: 400 },
        { name: 'TP3',  lat: 46.92, lon: 11.3, radius: 400 },
        { name: 'GOAL', lat: 47.0, lon: 11.4,  radius: 400, type: 'ESS' },
      ];
      const task = createTask(fivePointDefs);

      // Pilot tags only SSS and TP1, then flies straight east
      const throughTP1 = createTrackThroughCylinders([
        { lat: 47.0, lon: 11.0, radius: 1000 },
        { lat: 47.0, lon: 11.1, radius: 400 },
      ]);
      const lastFix = throughTP1[throughTP1.length - 1];
      const lastTime = (lastFix.time.getTime() - BASE_TIME.getTime()) / 60_000;

      const track = [
        ...throughTP1,
        createFix(lastTime + 2, 47.0, 11.2),
        createFix(lastTime + 4, 47.0, 11.35),  // close to goal straight-line
      ];

      const result = resolveTurnpointSequence(task, track);

      expect(result.madeGoal).toBe(false);
      expect(result.lastTurnpointReached).toBe(1); // TP1

      // Remaining distance must go through TP2 AND TP3 — much longer than
      // the straight-line distance to goal
      const straightLineToGoal = haversineDistance(47.0, 11.35, 47.0, 11.4);
      expect(result.bestProgress!.distanceToGoal).toBeGreaterThan(straightLineToGoal * 3);
    });
  });
});
