import { describe, it, expect } from 'bun:test';
import {
  explainGapScore,
  explainOpenDistanceScore,
  turnpointLabel,
  type ScoreEntryInput,
  type ClassContextInput,
  type ScoreExplanation,
} from '../src/score-explanation';
import type {
  TurnpointSequenceResult,
  CylinderCrossing,
  TurnpointReaching,
} from '../src/turnpoint-sequence';
import type { XCTask } from '../src/xctsk-parser';
import type { IGCFix } from '../src/igc-parser';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 10, 2, 0, 0); // epoch base for fixture times

function at(minutes: number): Date {
  return new Date(T0 + minutes * 60_000);
}

function makeTask(): XCTask {
  const wp = (name: string, lat: number, lon: number) => ({
    name,
    lat,
    lon,
    altSmoothed: 300,
  });
  return {
    taskType: 'CLASSIC',
    version: 1,
    turnpoints: [
      { type: 'TAKEOFF', radius: 400, waypoint: wp('LAUNCH', -36.0, 147.0) },
      { type: 'SSS', radius: 2000, waypoint: wp('START', -36.02, 147.02) },
      { radius: 1000, waypoint: wp('TP-A', -36.2, 147.2) },
      { type: 'ESS', radius: 1000, waypoint: wp('ESSWP', -36.4, 147.4) },
      { radius: 400, waypoint: wp('GOALWP', -36.42, 147.42) },
    ],
    sss: { type: 'RACE', direction: 'EXIT' },
    goal: { type: 'CYLINDER' },
  } as unknown as XCTask;
}

function crossing(
  taskIndex: number,
  minutes: number,
  direction: 'enter' | 'exit',
): CylinderCrossing {
  return {
    taskIndex,
    fixIndex: minutes * 10,
    time: at(minutes),
    latitude: -36.02 - taskIndex * 0.01,
    longitude: 147.02 + taskIndex * 0.01,
    direction,
    altitude: 1500,
    distanceToCenter: 2000,
  };
}

function reaching(
  taskIndex: number,
  minutes: number,
  selectionReason: TurnpointReaching['selectionReason'],
  candidateCount = 1,
): TurnpointReaching {
  return {
    taskIndex,
    fixIndex: minutes * 10,
    time: at(minutes),
    latitude: -36.02 - taskIndex * 0.01,
    longitude: 147.02 + taskIndex * 0.01,
    altitude: 1500,
    selectionReason,
    candidateCount,
  };
}

/** A pilot who re-entered the start and took the second (final) start. */
function makeReentryResult(): TurnpointSequenceResult {
  const sss = reaching(1, 30, 'last_before_next', 2);
  return {
    crossings: [
      crossing(1, 10, 'exit'), // first start
      crossing(1, 20, 'enter'), // came back
      { ...crossing(1, 30, 'exit'), time: sss.time }, // scored (final) start
      crossing(2, 60, 'enter'),
      crossing(3, 100, 'enter'),
      crossing(4, 105, 'enter'),
    ],
    sequence: [
      sss,
      reaching(2, 60, 'first_after_previous'),
      reaching(3, 100, 'first_crossing'),
      reaching(4, 105, 'first_after_previous'),
    ],
    sssReaching: sss,
    essReaching: reaching(3, 100, 'first_crossing'),
    madeGoal: true,
    lastTurnpointReached: 4,
    bestProgress: null,
    taskDistance: 60_000,
    flownDistance: 60_000,
    legs: [],
    speedSectionTime: 70 * 60,
  };
}

function makeGoalEntry(): ScoreEntryInput {
  return {
    made_goal: true,
    reached_ess: true,
    flown_distance: 60_000,
    speed_section_time: 70 * 60,
    distance_points: 400,
    distance_linear_points: 400,
    distance_difficulty_points: 0,
    time_points: 380.5,
    leading_points: 0,
    arrival_points: 0,
    penalty_points: 0,
    penalty_reason: null,
    total_score: 781,
  };
}

function makeClassContext(): ClassContextInput {
  return {
    task_validity: { launch: 1, distance: 0.9, time: 1, task: 0.9 },
    available_points: {
      distance: 400,
      time: 500,
      leading: 0,
      arrival: 0,
      total: 900,
    },
    pilots: [
      { flown_distance: 60_000, speed_section_time: 70 * 60, made_goal: true, reached_ess: true },
      { flown_distance: 60_000, speed_section_time: 65 * 60, made_goal: true, reached_ess: true },
      { flown_distance: 42_000, speed_section_time: null, made_goal: false, reached_ess: false },
    ],
  };
}

function section(explanation: ScoreExplanation, id: string) {
  const s = explanation.sections.find((sec) => sec.id === id);
  if (!s) throw new Error(`missing section ${id}`);
  return s;
}

// ---------------------------------------------------------------------------
// GAP
// ---------------------------------------------------------------------------

describe('explainGapScore — flight narrative', () => {
  it('tells the re-entry story: every start crossing listed, the scored one marked', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });

    const flight = section(explanation, 'flight');
    const summary = flight.items.find((i) => i.id === 'start-multiple');
    expect(summary).toBeDefined();
    expect(summary!.text).toContain('3 times');
    expect(summary!.text).toContain('last valid crossing');

    // All three boundary crossings are listed with anchors...
    const crossings = flight.items.filter((i) => i.id.startsWith('start-crossing-'));
    expect(crossings).toHaveLength(3);
    expect(crossings.every((c) => c.anchor !== undefined)).toBe(true);

    // ...and exactly the final exit is marked as the scored start.
    const scored = crossings.filter((c) => c.text.includes('scored start'));
    expect(scored).toHaveLength(1);
    expect(scored[0].anchor!.kind).toBe('start');
    expect(scored[0].anchor!.timeMs).toBe(at(30).getTime());
    // The superseded crossings are muted candidates.
    for (const c of crossings.filter((x) => !x.text.includes('scored start'))) {
      expect(c.anchor!.kind).toBe('start_candidate');
      expect(c.emphasis).toBe('muted');
    }
  });

  it('lists turnpoints, ESS with speed-section time, and goal in task order', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });

    const flight = section(explanation, 'flight');
    const tp = flight.items.find((i) => i.id === 'reaching-2');
    expect(tp).toBeDefined();
    expect(tp!.text).toContain('TP3');
    expect(tp!.text).toContain('TP-A');
    expect(tp!.anchor!.kind).toBe('turnpoint');

    const ess = flight.items.find((i) => i.id === 'reaching-3');
    expect(ess!.detail).toContain('1:10:00'); // 70 min speed section
    expect(ess!.anchor!.kind).toBe('ess');

    const goal = flight.items.find((i) => i.id === 'reaching-4');
    expect(goal!.text).toContain('Goal');
    expect(goal!.anchor!.kind).toBe('goal');

    expect(explanation.headline).toBe('Made goal in 1:10:00 — 781 points');
  });

  it('explains a landed-out pilot with the best-progress point', () => {
    const sss = reaching(1, 30, 'last_before_next');
    const result: TurnpointSequenceResult = {
      ...makeReentryResult(),
      crossings: [crossing(1, 30, 'exit')],
      sequence: [sss, reaching(2, 60, 'first_after_previous')],
      sssReaching: sss,
      essReaching: null,
      madeGoal: false,
      lastTurnpointReached: 2,
      bestProgress: {
        fixIndex: 900,
        time: at(90),
        latitude: -36.3,
        longitude: 147.3,
        distanceToGoal: 18_000,
      },
      flownDistance: 42_000,
      speedSectionTime: null,
    };
    const entry: ScoreEntryInput = {
      ...makeGoalEntry(),
      made_goal: false,
      reached_ess: false,
      flown_distance: 42_000,
      speed_section_time: null,
      distance_points: 280,
      distance_linear_points: 280,
      time_points: 0,
      total_score: 280,
    };

    const explanation = explainGapScore({
      task: makeTask(),
      result,
      entry,
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });

    const flight = section(explanation, 'flight');
    const bp = flight.items.find((i) => i.id === 'best-progress');
    expect(bp).toBeDefined();
    expect(bp!.text).toContain('18.0 km short');
    expect(bp!.detail).toContain('42.0 km');
    expect(bp!.anchor!.kind).toBe('best_progress');

    const time = section(explanation, 'time');
    expect(time.items[0].id).toBe('no-time-points');
    expect(explanation.headline).toBe('Landed out at 42.0 km — 280 points');
  });

  it('flags the no-SSS fallback and a start measured from the first fix', () => {
    const sss = reaching(1, 0, 'track_start');
    const result: TurnpointSequenceResult = {
      ...makeReentryResult(),
      sequence: [sss],
      sssReaching: sss,
      essReaching: null,
      madeGoal: false,
      bestProgress: null,
      startFallback: 'first_turnpoint',
      speedSectionTime: null,
    };
    const explanation = explainGapScore({
      task: makeTask(),
      result,
      entry: { ...makeGoalEntry(), made_goal: false, reached_ess: false },
      classContext: makeClassContext(),
    });
    const flight = section(explanation, 'flight');
    expect(flight.items.find((i) => i.id === 'start-fallback')?.emphasis).toBe('warning');
    const start = flight.items.find((i) => i.id === 'start');
    expect(start!.text).toContain('measured from the first fix');
    expect(start!.emphasis).toBe('warning');
  });
});

describe('explainGapScore — point components', () => {
  it('shows the linear distance formula with substituted values', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: { ...makeGoalEntry(), made_goal: false, distance_points: 280, distance_linear_points: 280, flown_distance: 42_000 },
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    const dist = section(explanation, 'distance');
    const formula = dist.items.find((i) => i.id === 'distance-formula');
    expect(formula!.detail).toContain('42.0 km ÷ 60.0 km');
    expect(formula!.detail).toContain('× 400 available');
    expect(dist.points).toBe(280);
  });

  it('splits HG distance into linear and difficulty halves', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        made_goal: false,
        distance_points: 250,
        distance_linear_points: 140,
        distance_difficulty_points: 110,
        flown_distance: 42_000,
      },
      classContext: makeClassContext(),
      params: { scoring: 'HG', useDistanceDifficulty: true },
    });
    const dist = section(explanation, 'distance');
    expect(dist.items.find((i) => i.id === 'distance-linear')!.value).toBe('140 pts');
    expect(dist.items.find((i) => i.id === 'distance-difficulty')!.value).toBe('110 pts');
  });

  it('notes the minimum-distance floor when the pilot flew less', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: { ...makeReentryResult(), flownDistance: 3_000 },
      entry: { ...makeGoalEntry(), made_goal: false, flown_distance: 5_000 },
      classContext: makeClassContext(),
      params: { scoring: 'PG', minimumDistance: 5_000 },
    });
    const dist = section(explanation, 'distance');
    const floor = dist.items.find((i) => i.id === 'minimum-distance');
    expect(floor).toBeDefined();
    expect(floor!.text).toContain('3.0 km');
    expect(floor!.text).toContain('5.0 km minimum');
  });

  it('explains time points against the fastest time in class', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    const time = section(explanation, 'time');
    expect(time.items.find((i) => i.id === 'your-time')!.value).toBe('1:10:00');
    expect(time.items.find((i) => i.id === 'best-time')!.value).toBe('1:05:00');
    const formula = time.items.find((i) => i.id === 'time-formula');
    expect(formula!.detail).toContain('speed fraction');
    expect(formula!.detail).toContain('× 500 available');
  });

  it('awards the fastest pilot full time points without the falloff formula', () => {
    const ctx = makeClassContext();
    ctx.pilots[1].speed_section_time = 80 * 60; // our 70-min pilot is now fastest
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: { ...makeGoalEntry(), time_points: 500 },
      classContext: ctx,
      params: { scoring: 'PG' },
    });
    const formula = section(explanation, 'time').items.find((i) => i.id === 'time-formula');
    expect(formula!.text).toContain('Fastest through the speed section');
  });

  it('summarises the validity → available-points chain', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
    });
    const validity = section(explanation, 'validity');
    expect(validity.summary).toContain('90%');
    expect(validity.summary).toContain('900 of 1000');
    const total = validity.items.find((i) => i.id === 'available-total');
    expect(total!.detail).toBe('1000 × 1.00 × 0.90 × 1.00 = 900');
  });

  it('includes a penalty section only when a penalty exists, and shows it in the total', () => {
    const clean = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
    });
    expect(clean.sections.find((s) => s.id === 'penalty')).toBeUndefined();

    const penalised = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        penalty_points: 50,
        penalty_reason: 'Airspace infringement',
        total_score: 731,
      },
      classContext: makeClassContext(),
    });
    const penalty = section(penalised, 'penalty');
    expect(penalty.items[0].text).toBe('Airspace infringement');
    expect(penalty.items[0].value).toBe('−50 pts');
    const total = section(penalised, 'total');
    expect(total.items[0].detail).toContain('− 50 penalty = 731');
  });

  it('omits leading/arrival sections when those components are off', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
    });
    expect(explanation.sections.find((s) => s.id === 'leading')).toBeUndefined();
    expect(explanation.sections.find((s) => s.id === 'arrival')).toBeUndefined();
  });
});

describe('turnpointLabel', () => {
  it('labels task positions by role', () => {
    const task = makeTask();
    expect(turnpointLabel(task, 0)).toBe('Takeoff');
    expect(turnpointLabel(task, 1)).toBe('Start');
    expect(turnpointLabel(task, 2)).toBe('TP3');
    expect(turnpointLabel(task, 3)).toBe('ESS');
    expect(turnpointLabel(task, 4)).toBe('Goal');
  });
});

// ---------------------------------------------------------------------------
// Open distance
// ---------------------------------------------------------------------------

describe('explainOpenDistanceScore', () => {
  const odTask = {
    taskType: 'CLASSIC',
    version: 1,
    turnpoints: [
      {
        type: 'TAKEOFF',
        radius: 5000,
        waypoint: { name: 'JIL', lat: -35.98, lon: 142.92, altSmoothed: 100 },
      },
    ],
  } as unknown as XCTask;

  const fix = (minutes: number, lat: number, lon: number): IGCFix => ({
    time: at(minutes),
    latitude: lat,
    longitude: lon,
    pressureAltitude: 800,
    gnssAltitude: 850,
    valid: true,
  });

  it('anchors the origin (cylinder exit) and furthest point with times', () => {
    const fixes = [fix(0, -35.98, 142.92), fix(10, -35.94, 142.97), fix(120, -35.6, 143.4)];
    const explanation = explainOpenDistanceScore({
      task: odTask,
      geometry: {
        origin: { latitude: -35.94, longitude: 142.97, fixIndex: 1 },
        furthest: { latitude: -35.6, longitude: 143.4, fixIndex: 2 },
        distance: 52_341,
      },
      fixes,
      entry: {
        flown_distance: 52_341,
        penalty_points: 0,
        penalty_reason: null,
        total_score: 52_341,
      },
    });

    const flight = section(explanation, 'flight');
    const origin = flight.items.find((i) => i.id === 'origin');
    expect(origin!.text).toContain('5.0 km launch cylinder');
    expect(origin!.anchor!.kind).toBe('origin');
    expect(origin!.anchor!.timeMs).toBe(at(10).getTime());
    const furthest = flight.items.find((i) => i.id === 'furthest');
    expect(furthest!.anchor!.kind).toBe('furthest');
    expect(flight.items.find((i) => i.id === 'distance')!.value).toBe('52.3 km');
    expect(section(explanation, 'total').items[0].detail).toBe('52341 m flown = 52341 points');
    expect(explanation.headline).toBe('Flew 52.3 km open distance — 52341 points');
  });

  it('explains a zero score when the flight never left the launch cylinder', () => {
    const explanation = explainOpenDistanceScore({
      task: odTask,
      geometry: null,
      entry: { flown_distance: 0, penalty_points: 0, penalty_reason: null, total_score: 0 },
    });
    const flight = section(explanation, 'flight');
    expect(flight.items[0].id).toBe('no-exit');
    expect(flight.items[0].text).toContain('never left the 5.0 km launch cylinder');
    expect(flight.items[0].emphasis).toBe('warning');
    expect(explanation.headline).toBe('Never left the launch cylinder — 0 points');
  });
});
