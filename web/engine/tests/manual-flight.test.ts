import { describe, it, expect } from 'bun:test';
import {
  distanceMadeGoodTo,
  manualFlightGeometry,
  manualFlightScoringData,
  type ManualFlight,
} from '../src/manual-flight';
import { explainManualFlightScore } from '../src/score-explanation';
import type { ScoreEntryInput, ClassContextInput } from '../src/score-explanation';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
import {
  scoreFlights,
  toFlightScoringData,
  type FlightScoringData,
  type PilotFlight,
} from '../src/gap-scoring';
import {
  calculateOptimizedTaskLine,
  calculateOptimizedTaskDistance,
} from '../src/task-optimizer';
import type { XCTask, Turnpoint } from '../src/xctsk-parser';
import { getGoalIndex } from '../src/xctsk-parser';
import { createFix, type IGCFix } from './test-helpers';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface TaskDef {
  name: string;
  lat: number;
  lon: number;
  radius: number;
  type?: Turnpoint['type'];
}

function createTask(defs: TaskDef[]): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: defs.map(d => ({
      type: d.type,
      radius: d.radius,
      waypoint: { name: d.name, lat: d.lat, lon: d.lon },
    })),
    sss: { type: 'RACE', direction: 'EXIT' },
    goal: { type: 'CYLINDER' },
  };
}

// A straight west→east task along the equator (lat 0). Collinear turnpoints
// keep the optimised geometry easy to reason about; distances stay honest
// ellipsoidal values via andoyerDistance.
//   SSS(0,0) r1000 · TP1(0,0.1) r400 · TP2(0,0.2) r400 · GOAL(0,0.3) r400
const TASK = createTask([
  { name: 'SSS', lat: 0, lon: 0.0, radius: 1000, type: 'SSS' },
  { name: 'TP1', lat: 0, lon: 0.1, radius: 400 },
  { name: 'TP2', lat: 0, lon: 0.2, radius: 400 },
  { name: 'GOAL', lat: 0, lon: 0.3, radius: 400 },
]);

const GOAL_IDX = getGoalIndex(TASK); // 3
const OPT_LINE = calculateOptimizedTaskLine(TASK);
const TASK_DISTANCE = calculateOptimizedTaskDistance(TASK);

/**
 * A track that exits the SSS, reaches TP1, then glides east toward TP2 and
 * lands at `landing` without reaching it — a land-out on the TP1→TP2 leg.
 * The eastmost (last) fix is the closest approach to goal.
 */
function landOutAfterTP1(landing: { lat: number; lon: number }): IGCFix[] {
  return [
    createFix(0, 0, 0.0),      // inside SSS
    createFix(60, 0, 0.03),    // exited SSS (>1 km east of centre)
    createFix(120, 0, 0.08),   // approaching TP1, still outside
    createFix(180, 0, 0.10),   // TP1 centre — reached
    createFix(240, 0, 0.12),   // left TP1, gliding on
    createFix(300, landing.lat, landing.lon), // land-out on the leg
  ];
}

// ---------------------------------------------------------------------------
// distanceMadeGoodTo
// ---------------------------------------------------------------------------

describe('distanceMadeGoodTo', () => {
  it('matches a real track landing out on an intermediate leg', () => {
    // A pilot who reached TP1 and landed mid-leg toward TP2.
    const landing = { lat: 0, lon: 0.15 };
    const fixes = landOutAfterTP1(landing);

    const result = resolveTurnpointSequence(TASK, fixes);
    // Sanity: the track reached TP1 (index 1) and did not make goal.
    expect(result.lastTurnpointReached).toBe(1);
    expect(result.madeGoal).toBe(false);

    const madeGood = distanceMadeGoodTo(TASK, 1, landing);

    // The made-good helper reproduces the track's scored flown distance: a
    // manual flight scores exactly like a real track at the same point/TP.
    expect(Math.abs(madeGood - result.flownDistance)).toBeLessThan(1);
    expect(madeGood).toBeGreaterThan(0);
    expect(madeGood).toBeLessThan(TASK_DISTANCE);
  });

  it('gives two pilots at the same coordinate different distances by last TP', () => {
    // Both land at the same point on the final leg (past TP2). One rounded
    // TP2; the other flew straight from the start rounding nothing.
    const point = { lat: 0, lon: 0.25 };

    const roundedTP2 = distanceMadeGoodTo(TASK, 2, point);
    const roundedNothing = distanceMadeGoodTo(TASK, 0, point); // only left SSS

    // The endpoint alone can't tell them apart; the last-reached TP does.
    expect(roundedTP2).toBeGreaterThan(roundedNothing);
    expect(roundedTP2).not.toBeCloseTo(roundedNothing, 0);
    expect(roundedTP2).toBeLessThan(TASK_DISTANCE);
  });

  it('measures a point past the next TP by closest approach, not credited past it', () => {
    // Landing exactly at TP2's optimal tag point, claiming only TP1: the full
    // TP1→TP2 leg is banked (made-good === along-course distance to TP2).
    const tp2Tag = { lat: OPT_LINE[2].lat, lon: OPT_LINE[2].lon };
    const peak = distanceMadeGoodTo(TASK, 1, tp2Tag);

    // A point well past TP2, still claiming only TP1. Order is respected: the
    // pilot is measured by closest approach to TP2, so made-good FALLS back
    // below the peak — flying past an unclaimed turnpoint earns nothing extra.
    const beyondTP2 = { lat: 0, lon: 0.25 };
    const claimTP1 = distanceMadeGoodTo(TASK, 1, beyondTP2);
    expect(claimTP1).toBeLessThan(peak);

    // Claiming TP2 for the same landing point instead credits progress past
    // TP2 toward goal — strictly more than the peak.
    const claimTP2 = distanceMadeGoodTo(TASK, 2, beyondTP2);
    expect(claimTP2).toBeGreaterThan(peak);
    expect(claimTP2).toBeGreaterThan(claimTP1);
  });

  it('returns full task distance for a pilot in goal, regardless of point', () => {
    // Goal index, and even a nonsense landing point → the whole task.
    expect(distanceMadeGoodTo(TASK, GOAL_IDX, { lat: 0, lon: 0.3 }))
      .toBeCloseTo(TASK_DISTANCE, 3);
    expect(distanceMadeGoodTo(TASK, GOAL_IDX, { lat: 5, lon: 5 }))
      .toBeCloseTo(TASK_DISTANCE, 3);
  });

  it('floors made-good at the distance banked by the reached turnpoint', () => {
    // Reached TP2 but landed back near the start. The pilot still keeps the
    // along-course distance to TP2 — reaching a TP can never score less than
    // getting there.
    const backAtStart = { lat: 0, lon: 0.01 };
    const madeGood = distanceMadeGoodTo(TASK, 2, backAtStart);

    // cum-distance to TP2 along the optimised line.
    const cumToTP2 = distanceMadeGoodTo(TASK, 2, { lat: OPT_LINE[2].lat, lon: OPT_LINE[2].lon });
    expect(madeGood).toBeCloseTo(cumToTP2, 3);
  });

  it('returns 0 for no start (negative last-reached index)', () => {
    expect(distanceMadeGoodTo(TASK, -1, { lat: 0, lon: 0.15 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// manualFlightScoringData + scoreFlights
// ---------------------------------------------------------------------------

describe('manualFlightScoringData', () => {
  it('produces a land-out scoring input with no goal/time', () => {
    const flight: ManualFlight = {
      pilotName: 'Alice',
      trackFile: 'manual:alice',
      lastReachedIndex: 1,
      landing: { lat: 0, lon: 0.15 },
    };
    const data = manualFlightScoringData(TASK, flight);

    expect(data.madeGoal).toBe(false);
    expect(data.reachedESS).toBe(false);
    expect(data.speedSectionTime).toBeNull();
    expect(data.sssTimeMs).toBeNull();
    expect(data.essTimeMs).toBeNull();
    expect(data.flownDistance).toBeCloseTo(
      distanceMadeGoodTo(TASK, 1, flight.landing), 6,
    );
  });

  it('carries goal + duration for a pilot in goal', () => {
    const flight: ManualFlight = {
      pilotName: 'Bob',
      trackFile: 'manual:bob',
      lastReachedIndex: GOAL_IDX,
      landing: { lat: 0, lon: 0.3 },
      durationSeconds: 3600,
    };
    const data = manualFlightScoringData(TASK, flight);

    expect(data.madeGoal).toBe(true);
    expect(data.reachedESS).toBe(true);
    expect(data.speedSectionTime).toBe(3600);
    expect(data.flownDistance).toBeCloseTo(TASK_DISTANCE, 3);
  });

  it('drops a non-positive duration to null', () => {
    const flight: ManualFlight = {
      pilotName: 'Bob',
      trackFile: 'manual:bob',
      lastReachedIndex: GOAL_IDX,
      landing: { lat: 0, lon: 0.3 },
      durationSeconds: 0,
    };
    expect(manualFlightScoringData(TASK, flight).speedSectionTime).toBeNull();
  });

  it('scores manual flights through scoreFlights: numFlying, distance, and time points', () => {
    const flights: FlightScoringData[] = [
      manualFlightScoringData(TASK, {
        pilotName: 'Goalie', trackFile: 'manual:goalie',
        lastReachedIndex: GOAL_IDX, landing: { lat: 0, lon: 0.3 },
        durationSeconds: 3600,
      }),
      manualFlightScoringData(TASK, {
        pilotName: 'Mid', trackFile: 'manual:mid',
        lastReachedIndex: 2, landing: { lat: 0, lon: 0.25 },
      }),
      manualFlightScoringData(TASK, {
        pilotName: 'Short', trackFile: 'manual:short',
        lastReachedIndex: 1, landing: { lat: 0, lon: 0.13 },
      }),
    ];

    const result = scoreFlights(TASK, flights, { scoring: 'PG', useLeading: false });

    // All three count toward launch validity (S7F §9.1).
    expect(result.stats.numFlying).toBe(3);
    expect(result.stats.numInGoal).toBe(1);

    const byPilot = new Map(result.pilotScores.map(p => [p.trackFile, p]));
    const goalie = byPilot.get('manual:goalie')!;
    const mid = byPilot.get('manual:mid')!;
    const short = byPilot.get('manual:short')!;

    // The goal pilot wins: full distance + time points; land-outs get neither.
    expect(goalie.madeGoal).toBe(true);
    expect(goalie.rank).toBe(1);
    expect(goalie.timePoints).toBeGreaterThan(0);
    expect(mid.timePoints).toBe(0);
    expect(short.timePoints).toBe(0);

    // Distance ordering follows made-good.
    expect(goalie.flownDistance).toBeGreaterThan(mid.flownDistance);
    expect(mid.flownDistance).toBeGreaterThan(short.flownDistance);
    expect(goalie.totalScore).toBeGreaterThan(mid.totalScore);
    expect(mid.totalScore).toBeGreaterThan(short.totalScore);
  });

  it('scores manual flights with leading enabled: they get zero leading, not a crash', () => {
    // A track-less pilot (manual flight) has no tracklog to lead with. With
    // leading on (the per-category HG default, issue #343) scoreFlights must
    // award it no leading points rather than demand a leading aggregate.
    const tracked: PilotFlight = {
      pilotName: 'Tracked', trackFile: 'track:t.igc',
      fixes: landOutAfterTP1({ lat: 0, lon: 0.15 }),
    };
    const trackedData = toFlightScoringData(
      tracked, resolveTurnpointSequence(TASK, tracked.fixes), true,
    );
    const manual = manualFlightScoringData(TASK, {
      pilotName: 'Manual', trackFile: 'manual:m',
      lastReachedIndex: 2, landing: { lat: 0, lon: 0.25 },
    });
    expect(manual.trackless).toBe(true);

    const result = scoreFlights(TASK, [trackedData, manual], {
      scoring: 'HG', useLeading: true,
    });
    const m = result.pilotScores.find(p => p.trackFile === 'manual:m')!;
    expect(m.leadingPoints).toBe(0);
    // Still scored on distance despite flying further than the tracked pilot.
    expect(m.flownDistance).toBeGreaterThan(0);
  });

  it('scores a manual flight identically to a real track at the same point/TP', () => {
    // A real tracked pilot who reached TP1 and landed out at P, alongside a
    // manual flight reporting the same last-TP and landing point. Their
    // scored flown distances must agree.
    const landing = { lat: 0, lon: 0.15 };
    const tracked: PilotFlight = {
      pilotName: 'Tracked', trackFile: 'track:t.igc',
      fixes: landOutAfterTP1(landing),
    };
    const trackedData = toFlightScoringData(
      tracked, resolveTurnpointSequence(TASK, tracked.fixes), false,
    );
    const manualData = manualFlightScoringData(TASK, {
      pilotName: 'Manual', trackFile: 'manual:m',
      lastReachedIndex: 1, landing,
    });

    const result = scoreFlights(TASK, [trackedData, manualData], {
      scoring: 'PG', useLeading: false,
    });
    const byPilot = new Map(result.pilotScores.map(p => [p.trackFile, p]));
    const t = byPilot.get('track:t.igc')!;
    const m = byPilot.get('manual:m')!;

    expect(m.flownDistance).toBeCloseTo(t.flownDistance, 0);
    expect(m.distancePoints).toBeCloseTo(t.distancePoints, 1);
    expect(m.totalScore).toBeCloseTo(t.totalScore, 1);
  });
});

// ---------------------------------------------------------------------------
// manualFlightGeometry + explainManualFlightScore (score-details evidence)
// ---------------------------------------------------------------------------

describe('manualFlightGeometry', () => {
  it('returns a routed line from the landing point through to goal for a land-out', () => {
    const landing = { lat: 0, lon: 0.15 };
    const geom = manualFlightGeometry(TASK, 1, landing);

    expect(geom.madeGoal).toBe(false);
    expect(geom.distanceToGoal).toBeGreaterThan(0);
    expect(geom.madeGood).toBeCloseTo(distanceMadeGoodTo(TASK, 1, landing), 6);
    // [landing, TP2 tag, GOAL tag] — the drawn route.
    expect(geom.routeToGoal.length).toBeGreaterThanOrEqual(2);
    expect(geom.routeToGoal[0]).toEqual(landing);
    // made-good + remaining ≈ task distance for a forward land-out.
    expect(geom.madeGood + geom.distanceToGoal).toBeCloseTo(TASK_DISTANCE, 0);
  });

  it('has no remaining route in goal', () => {
    const geom = manualFlightGeometry(TASK, GOAL_IDX, { lat: 0, lon: 0.3 });
    expect(geom.madeGoal).toBe(true);
    expect(geom.distanceToGoal).toBe(0);
    expect(geom.routeToGoal).toHaveLength(0);
    expect(geom.madeGood).toBeCloseTo(TASK_DISTANCE, 3);
  });
});

describe('explainManualFlightScore', () => {
  const entry: ScoreEntryInput = {
    made_goal: false,
    reached_ess: false,
    flown_distance: 15000,
    speed_section_time: null,
    distance_points: 300,
    distance_linear_points: 300,
    distance_difficulty_points: 0,
    time_points: 0,
    leading_points: 0,
    arrival_points: 0,
    penalty_points: 0,
    penalty_reason: null,
    total_score: 300,
  };
  const classContext: ClassContextInput = {
    task_validity: { launch: 1, distance: 0.8, time: 0.7, task: 0.56 },
    available_points: { distance: 500, time: 300, leading: 0, arrival: 0, total: 800 },
    pilots: [
      { flown_distance: 15000, speed_section_time: null, made_goal: false, reached_ess: false },
    ],
  };

  function findAnchorPath(explanation: ReturnType<typeof explainManualFlightScore>) {
    for (const section of explanation.sections) {
      for (const item of section.items) {
        if (item.anchor?.kind === 'best_progress') return item.anchor.path;
      }
    }
    return undefined;
  }

  it('attaches the routed made-good line to a best_progress anchor', () => {
    const geometry = manualFlightGeometry(TASK, 1, { lat: 0, lon: 0.15 });
    const explanation = explainManualFlightScore({ task: TASK, geometry, entry, classContext });

    expect(explanation.format).toBe('gap');
    expect(explanation.headline).toContain('Manual flight');
    // The landing anchor carries the same routed polyline a landed-out track
    // draws — so the score-details map shows the identical evidence.
    const path = findAnchorPath(explanation);
    expect(path && path.length).toBeGreaterThanOrEqual(2);
    expect(path![0]).toEqual({ latitude: 0, longitude: 0.15 });

    // Reuses the shared point sections, driven by the published entry.
    const distance = explanation.sections.find((s) => s.id === 'distance');
    expect(distance?.points).toBe(300);
    expect(explanation.sections.some((s) => s.id === 'total')).toBe(true);
  });

  it('credits full distance and draws no line in goal', () => {
    const goalEntry: ScoreEntryInput = {
      ...entry,
      made_goal: true,
      reached_ess: true,
      flown_distance: 33000,
      speed_section_time: 3600,
      time_points: 200,
      total_score: 700,
    };
    const geometry = manualFlightGeometry(TASK, GOAL_IDX, { lat: 0, lon: 0.3 });
    const explanation = explainManualFlightScore({
      task: TASK,
      geometry,
      entry: goalEntry,
      classContext,
    });
    expect(explanation.headline).toContain('made goal');
    expect(findAnchorPath(explanation)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// manualOpenDistanceGeometry (open-distance manual flights)
// ---------------------------------------------------------------------------

import { manualOpenDistanceGeometry } from '../src/manual-flight';
import { andoyerDistance } from '../src/geo';

describe('manualOpenDistanceGeometry', () => {
  // A single take-off cylinder — the open-distance task shape.
  const OD_TASK = createTask([
    { name: 'Launch', lat: 0, lon: 0, radius: 5000, type: 'TAKEOFF' },
  ]);

  it('measures the straight line from the take-off cylinder edge to the landing', () => {
    const landing = { lat: 0, lon: 0.1 }; // ~11.1 km east of the centre
    const geom = manualOpenDistanceGeometry(OD_TASK, landing);

    const toCentre = andoyerDistance(0, 0, landing.lat, landing.lon);
    // distance = (centre→landing) − radius.
    expect(geom.distance).toBeCloseTo(toCentre - 5000, 0);
    expect(geom.landing).toEqual(landing);
    // Origin is on the cylinder edge (5 km from the centre), east toward landing.
    expect(andoyerDistance(0, 0, geom.origin.lat, geom.origin.lon)).toBeCloseTo(5000, 0);
    expect(geom.origin.lon).toBeGreaterThan(0);
  });

  it('scores 0 when the landing is inside the take-off cylinder', () => {
    const geom = manualOpenDistanceGeometry(OD_TASK, { lat: 0, lon: 0.01 }); // ~1.1 km
    expect(geom.distance).toBe(0);
  });
});
