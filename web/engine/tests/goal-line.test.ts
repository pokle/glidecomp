/**
 * GAP goal LINE scoring (S7F §6.3.1).
 *
 * Covers the goal-line geometry module, crossing detection and sequence
 * resolution against a line goal, the optimised route ending on the line,
 * manual-flight distance to the line, and the goal line in the 3D-replay
 * manifest.
 */
import { describe, it, expect } from 'bun:test';
import {
  computeGoalLine,
  distanceToGoalLine,
  goalLineCrossingFraction,
  goalLinePointAt,
  goalSemicirclePoints,
  isForwardGoalCrossing,
  isInGoalSemicircle,
} from '../src/goal-line';
import {
  detectCylinderCrossings,
  resolveTurnpointSequence,
} from '../src/turnpoint-sequence';
import { calculateOptimizedTaskDistance, calculateOptimizedTaskLine } from '../src/task-optimizer';
import { manualFlightGeometry } from '../src/manual-flight';
import { packTracks } from '../src/track-packer';
import { andoyerDistance, destinationPoint } from '../src/geo';
import type { XCTask, GoalConfig } from '../src/xctsk-parser';
import { createFix, type IGCFix } from './test-helpers';

// ---------------------------------------------------------------------------
// Task layout: a straight west→east course at lat 47. The final leg runs due
// east (bearing ~90°), so a LINE goal runs north–south through the goal
// centre, and the control semicircle lies east of it.
// ---------------------------------------------------------------------------

const GOAL = { lat: 47.0, lon: 11.26 };

function lineGoalTask(goalType: GoalConfig['type'] = 'LINE', goalRadius = 200): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: [
      { type: 'SSS', radius: 1000, waypoint: { name: 'SSS', lat: 47.0, lon: 11.0 } },
      { radius: 400, waypoint: { name: 'TP1', lat: 47.0, lon: 11.13 } },
      { type: 'ESS', radius: goalRadius, waypoint: { name: 'GOAL', lat: GOAL.lat, lon: GOAL.lon } },
    ],
    sss: { type: 'RACE', direction: 'EXIT' },
    goal: { type: goalType },
  };
}

/** A due-east track along lat `lat`, one fix per minute, from lonStart to lonEnd. */
function eastboundTrack(lat: number, lonStart: number, lonEnd: number, stepDeg = 0.01): IGCFix[] {
  const fixes: IGCFix[] = [];
  let t = 0;
  for (let lon = lonStart; lon <= lonEnd + 1e-9; lon += stepDeg) {
    fixes.push(createFix(t, lat, lon));
    t += 60;
  }
  return fixes;
}

describe('computeGoalLine', () => {
  it('returns null for a cylinder goal', () => {
    expect(computeGoalLine(lineGoalTask('CYLINDER'))).toBeNull();
  });

  it('returns null when no goal config is present', () => {
    const task = lineGoalTask('LINE');
    delete task.goal;
    expect(computeGoalLine(task)).toBeNull();
  });

  it('returns null for a single-turnpoint task', () => {
    const task = lineGoalTask('LINE');
    task.turnpoints = [task.turnpoints[2]];
    expect(computeGoalLine(task)).toBeNull();
  });

  it('returns null for a zero-radius goal', () => {
    expect(computeGoalLine(lineGoalTask('LINE', 0))).toBeNull();
  });

  it('builds a line perpendicular to the final leg, radius to each side', () => {
    const line = computeGoalLine(lineGoalTask())!;
    expect(line).not.toBeNull();
    expect(line.halfWidth).toBe(200);
    expect(line.center.lat).toBeCloseTo(GOAL.lat, 10);
    expect(line.center.lon).toBeCloseTo(GOAL.lon, 10);

    // Final leg runs due east → the line runs north–south: end1 north of the
    // centre (left of course), end2 south, both 200 m away.
    expect(andoyerDistance(line.end1.lat, line.end1.lon, GOAL.lat, GOAL.lon)).toBeCloseTo(200, 0);
    expect(andoyerDistance(line.end2.lat, line.end2.lon, GOAL.lat, GOAL.lon)).toBeCloseTo(200, 0);
    expect(line.end1.lat).toBeGreaterThan(GOAL.lat);
    expect(line.end2.lat).toBeLessThan(GOAL.lat);
    expect(line.end1.lon).toBeCloseTo(GOAL.lon, 5);
    expect(line.end2.lon).toBeCloseTo(GOAL.lon, 5);

    // The full line spans 2 × radius.
    expect(
      andoyerDistance(line.end1.lat, line.end1.lon, line.end2.lat, line.end2.lon)
    ).toBeCloseTo(400, 0);
  });

  it('skips turnpoints concentric with the goal when finding the leg direction', () => {
    const task = lineGoalTask();
    // Insert an ESS ring concentric with the goal between TP1 and the goal.
    task.turnpoints[2].type = undefined;
    task.turnpoints.splice(2, 0, {
      type: 'ESS',
      radius: 2000,
      waypoint: { name: 'ESS', lat: GOAL.lat, lon: GOAL.lon },
    });
    const line = computeGoalLine(task)!;
    expect(line).not.toBeNull();
    // Leg direction still comes from TP1 → goal (due east), so the line
    // still runs north–south.
    expect(line.end1.lon).toBeCloseTo(GOAL.lon, 5);
    expect(line.end1.lat).toBeGreaterThan(GOAL.lat);
  });
});

describe('goal line predicates', () => {
  const line = computeGoalLine(lineGoalTask())!;

  it('semicircle contains points just past the line, near the centre', () => {
    const past = destinationPoint(GOAL.lat, GOAL.lon, 50, Math.PI / 2); // 50 m east
    expect(isInGoalSemicircle(line, past.lat, past.lon)).toBe(true);
  });

  it('semicircle excludes the approach side and points beyond the radius', () => {
    const before = destinationPoint(GOAL.lat, GOAL.lon, 50, -Math.PI / 2); // 50 m west
    expect(isInGoalSemicircle(line, before.lat, before.lon)).toBe(false);
    const far = destinationPoint(GOAL.lat, GOAL.lon, 250, Math.PI / 2); // 250 m east > 200 m radius
    expect(isInGoalSemicircle(line, far.lat, far.lon)).toBe(false);
  });

  it('detects a segment crossing the line and its direction', () => {
    const from = destinationPoint(GOAL.lat, GOAL.lon, 100, -Math.PI / 2); // west
    const to = destinationPoint(GOAL.lat, GOAL.lon, 100, Math.PI / 2); // east
    const t = goalLineCrossingFraction(line, from, to);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(0.5, 2);
    expect(isForwardGoalCrossing(line, from, to)).toBe(true);
    expect(isForwardGoalCrossing(line, to, from)).toBe(false);
  });

  it('rejects a segment crossing the extended line beyond an endpoint', () => {
    // 500 m north of the centre — the line only reaches 200 m.
    const north = destinationPoint(GOAL.lat, GOAL.lon, 500, 0);
    const from = destinationPoint(north.lat, north.lon, 100, -Math.PI / 2);
    const to = destinationPoint(north.lat, north.lon, 100, Math.PI / 2);
    expect(goalLineCrossingFraction(line, from, to)).toBeNull();
  });

  it('measures distance to the nearest point on the line', () => {
    // On the course line, 5 km west of goal: nearest point is the centre.
    const west = destinationPoint(GOAL.lat, GOAL.lon, 5000, -Math.PI / 2);
    expect(distanceToGoalLine(line, west.lat, west.lon)).toBeCloseTo(5000, 0);

    // 1 km north of the centre: nearest point is the north endpoint (200 m
    // north), so the distance is ~800 m.
    const north = destinationPoint(GOAL.lat, GOAL.lon, 1000, 0);
    expect(distanceToGoalLine(line, north.lat, north.lon)).toBeCloseTo(800, 0);
  });

  it('parameterises the line from end1 to end2', () => {
    const mid = goalLinePointAt(line, 0.5);
    expect(andoyerDistance(mid.lat, mid.lon, GOAL.lat, GOAL.lon)).toBeLessThan(1);
  });

  it('semicircle outline lies behind the line at the goal radius', () => {
    const points = goalSemicirclePoints(line, 16);
    expect(points[0]).toEqual(points[points.length - 1]); // closed
    for (const p of points) {
      expect(andoyerDistance(p.lat, p.lon, GOAL.lat, GOAL.lon)).toBeLessThanOrEqual(201);
      // Everything is on the far (east) side of the line, within ~0.5 m.
      expect(p.lon).toBeGreaterThanOrEqual(GOAL.lon - 5e-6);
    }
  });
});

describe('optimised route with a LINE goal', () => {
  it('ends the route on the line instead of the cylinder edge', () => {
    const cylinderDistance = calculateOptimizedTaskDistance(lineGoalTask('CYLINDER'));
    const lineDistance = calculateOptimizedTaskDistance(lineGoalTask('LINE'));
    // A straight approach along the leg meets the line at the goal centre,
    // one radius beyond the cylinder edge.
    expect(lineDistance - cylinderDistance).toBeCloseTo(200, 0);

    const path = calculateOptimizedTaskLine(lineGoalTask('LINE'));
    const line = computeGoalLine(lineGoalTask('LINE'))!;
    const last = path[path.length - 1];
    // The tag sits ON the line (the optimizer may leave it displaced a few
    // tens of metres ALONG the line — that costs sub-metre total distance,
    // below its 1 m convergence threshold).
    expect(distanceToGoalLine(line, last.lat, last.lon)).toBeLessThan(2);
  });

  it('tags the nearest point on the line for an angled approach', () => {
    const task = lineGoalTask('LINE', 2000);
    // Move TP1 well north so the route bends at TP1.
    task.turnpoints[1].waypoint.lat = 47.06;
    const line = computeGoalLine(task)!;
    const path = calculateOptimizedTaskLine(task);
    const last = path[path.length - 1];
    // The tag point sits on the line…
    expect(distanceToGoalLine(line, last.lat, last.lon)).toBeLessThan(2);
    // …and the line route is never longer than routing to the goal centre.
    const centerTask = { ...task, goal: { type: 'CYLINDER' as const } };
    centerTask.turnpoints = task.turnpoints.map((tp, i) =>
      i === task.turnpoints.length - 1 ? { ...tp, radius: 0.001 } : tp
    );
    const lineDistance = calculateOptimizedTaskDistance(task);
    const centerDistance = calculateOptimizedTaskDistance(centerTask);
    expect(lineDistance).toBeLessThanOrEqual(centerDistance + 1);
  });
});

describe('sequence resolution with a LINE goal', () => {
  it('scores goal for a track that crosses the line', () => {
    const fixes = eastboundTrack(47.0, 10.95, 11.31);
    const result = resolveTurnpointSequence(lineGoalTask(), fixes);
    expect(result.madeGoal).toBe(true);
    expect(result.essReaching).not.toBeNull();
    expect(result.flownDistance).toBeCloseTo(result.taskDistance, 5);

    // The goal crossing is interpolated onto the line itself.
    const goalCrossings = result.crossings.filter((c) => c.taskIndex === 2);
    expect(goalCrossings.length).toBeGreaterThan(0);
    expect(goalCrossings[0].direction).toBe('enter');
    expect(goalCrossings[0].longitude).toBeCloseTo(GOAL.lon, 4);
    expect(goalCrossings[0].toleranceCredited).toBe(false);
  });

  it('does NOT score goal for the same track against a wide cylinder short of the line', () => {
    // Same eastbound track, stopping 1 km short of goal: a 200 m cylinder
    // would also not be reached, but this confirms the line isn't credited
    // by proximity alone.
    const oneKmShort = destinationPoint(GOAL.lat, GOAL.lon, 1000, -Math.PI / 2);
    const fixes: IGCFix[] = [
      ...eastboundTrack(47.0, 10.95, 11.24),
      createFix(31 * 60, oneKmShort.lat, oneKmShort.lon), // lands 1 km west of the line
    ];
    const result = resolveTurnpointSequence(lineGoalTask(), fixes);
    expect(result.madeGoal).toBe(false);
    expect(result.bestProgress).not.toBeNull();
    // Remaining distance is measured to the line (≈ distance to centre on a
    // straight approach), not to a cylinder edge 200 m closer.
    expect(result.bestProgress!.distanceToGoal).toBeGreaterThan(900);
    expect(result.bestProgress!.distanceToGoal).toBeLessThan(1100);
    expect(result.flownDistance).toBeCloseTo(
      result.taskDistance - result.bestProgress!.distanceToGoal, 5
    );
  });

  it('does not credit a pilot who flies past the extended line beyond an endpoint', () => {
    // Fly the whole course 1 km north of the course line: TP cylinders
    // (radius 400/1000) are still tagged near-misses? No — keep the track on
    // course until TP1, then offset north before goal so only the goal is
    // missed.
    const fixes: IGCFix[] = [
      ...eastboundTrack(47.0, 10.95, 11.2),
      // Jump 1 km north of the course, then continue east past the goal.
      ...eastboundTrack(47.009, 11.21, 11.31).map((f) => ({
        ...f,
        time: new Date(f.time.getTime() + 26 * 60 * 1000),
      })),
    ];
    const result = resolveTurnpointSequence(lineGoalTask(), fixes);
    expect(result.madeGoal).toBe(false);
    expect(result.lastTurnpointReached).toBe(1);
    // Closest approach to the line is ~800 m (north endpoint is 200 m out).
    expect(result.bestProgress!.distanceToGoal).toBeGreaterThan(600);
    expect(result.bestProgress!.distanceToGoal).toBeLessThan(1000);
  });

  it('credits a fast crossing that leaves no fix inside the semicircle', () => {
    // Cross the line 150 m north of centre with big steps: one fix 2 km
    // west, next fix 2 km east — no fix lands in the 200 m semicircle.
    const crossLat = destinationPoint(GOAL.lat, GOAL.lon, 150, 0).lat;
    const fixes: IGCFix[] = [
      ...eastboundTrack(47.0, 10.95, 11.2),
      createFix(30 * 60, crossLat, 11.23),
      createFix(32 * 60, crossLat, 11.29),
    ];
    const result = resolveTurnpointSequence(lineGoalTask(), fixes);
    expect(result.madeGoal).toBe(true);
    const goalCrossings = result.crossings.filter((c) => c.taskIndex === 2);
    // Instantaneous enter+exit pair at the line.
    expect(goalCrossings.map((c) => c.direction)).toEqual(['enter', 'exit']);
  });

  it('credits a fix inside the control semicircle without a line crossing', () => {
    // Approach from the north-east and land inside the semicircle behind
    // the line — never crossing the line itself.
    const inSemi = destinationPoint(GOAL.lat, GOAL.lon, 100, Math.PI / 2); // 100 m east
    const fixes: IGCFix[] = [
      ...eastboundTrack(47.0, 10.95, 11.2),
      createFix(30 * 60, 47.02, 11.28), // north-east of goal, outside
      createFix(32 * 60, inSemi.lat, inSemi.lon), // inside the semicircle
    ];
    const result = resolveTurnpointSequence(lineGoalTask(), fixes);
    expect(result.madeGoal).toBe(true);
  });

  it('treats the goal as a cylinder when goal.type is CYLINDER', () => {
    const fixes = eastboundTrack(47.0, 10.95, 11.31);
    const line = resolveTurnpointSequence(lineGoalTask('LINE'), fixes);
    const cyl = resolveTurnpointSequence(lineGoalTask('CYLINDER'), fixes);
    expect(cyl.madeGoal).toBe(true);
    // The cylinder task is one radius shorter than the line task.
    expect(line.taskDistance - cyl.taskDistance).toBeCloseTo(200, 0);
  });
});

describe('detectCylinderCrossings with a LINE goal', () => {
  it('still detects cylinder crossings for non-goal turnpoints', () => {
    const fixes = eastboundTrack(47.0, 10.95, 11.31);
    const crossings = detectCylinderCrossings(lineGoalTask(), fixes);
    const byIndex = new Set(crossings.map((c) => c.taskIndex));
    expect(byIndex.has(0)).toBe(true); // SSS cylinder
    expect(byIndex.has(1)).toBe(true); // TP1 cylinder
    expect(byIndex.has(2)).toBe(true); // goal line
  });
});

describe('manual flight against a LINE goal', () => {
  it('measures the remaining distance to the line, not a cylinder edge', () => {
    const task = lineGoalTask();
    const landing = destinationPoint(GOAL.lat, GOAL.lon, 1000, -Math.PI / 2); // 1 km west
    const geoLine = manualFlightGeometry(task, 1, { lat: landing.lat, lon: landing.lon });
    expect(geoLine.distanceToGoal).toBeCloseTo(1000, 0);

    const geoCyl = manualFlightGeometry(
      lineGoalTask('CYLINDER'), 1, { lat: landing.lat, lon: landing.lon }
    );
    expect(geoCyl.distanceToGoal).toBeCloseTo(800, 0); // 200 m cylinder edge
  });
});

describe('track packer with a LINE goal', () => {
  it('projects the goal line endpoints into the manifest', () => {
    const task = lineGoalTask();
    const packed = packTracks({
      pilots: [{
        id: 'p1',
        name: 'Pilot One',
        fixes: [
          { lat: 47.0, lon: 11.0, alt: 500, t: 0 },
          { lat: 47.0, lon: 11.1, alt: 500, t: 60 },
        ],
      }],
      task,
    });
    const goalLine = packed.manifest.task?.goalLine;
    expect(goalLine).toBeDefined();
    // The line spans 400 m in ENU space.
    const dx = goalLine!.x2 - goalLine!.x1;
    const dz = goalLine!.z2 - goalLine!.z1;
    expect(Math.hypot(dx, dz)).toBeCloseTo(400, 0);
  });

  it('omits goalLine for a cylinder goal', () => {
    const packed = packTracks({
      pilots: [{
        id: 'p1',
        name: 'Pilot One',
        fixes: [{ lat: 47.0, lon: 11.0, alt: 500, t: 0 }],
      }],
      task: lineGoalTask('CYLINDER'),
    });
    expect(packed.manifest.task?.goalLine).toBeUndefined();
  });
});
