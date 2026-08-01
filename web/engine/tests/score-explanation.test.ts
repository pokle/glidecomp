import { describe, it, expect } from 'bun:test';
import {
  explainGapScore,
  explainOpenDistanceScore,
  turnpointLabel,
  type ScoreEntryInput,
  type ClassContextInput,
  type ScoreExplanation,
} from '../src/score-explanation';
import {
  calculateArrivalPoints,
  calculateDistanceDifficulty,
  calculateSpeedFraction,
  speedExponentValue,
} from '../src/gap-scoring';
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
  toleranceCredited = false,
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
    toleranceCredited,
  };
}

function reaching(
  taskIndex: number,
  minutes: number,
  selectionReason: TurnpointReaching['selectionReason'],
  candidateCount = 1,
  toleranceCredited = false,
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
    toleranceCredited,
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
    total_score: 780.5,
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

/** A section's chart, narrowed to the curve variant (ScoreChart is a union
 *  since the validity sparklines and the distance distribution joined it). */
function curveChart(section: { chart?: { kind: string } }) {
  const c = section.chart;
  if (!c || c.kind !== 'curve') throw new Error(`expected a curve chart, got ${c?.kind}`);
  return c as import('../src/score-explanation-types').ScoreCurveChart;
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
    expect(summary!.text).toContain('latest crossing');

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

  it('always lists the scored start, eliding the middle, when it lies beyond the crossing cap', () => {
    // 20 boundary crossings; the scored start is the LAST one — the classic
    // "milled around the start cylinder" case the narrative exists for. It
    // must never disappear behind the listing cap.
    const sss = reaching(1, 60, 'last_before_next', 10);
    const startCrossings: CylinderCrossing[] = [];
    for (let i = 0; i < 19; i++) {
      startCrossings.push(crossing(1, 10 + i, i % 2 === 0 ? 'exit' : 'enter'));
    }
    startCrossings.push({ ...crossing(1, 60, 'exit'), time: sss.time });
    const base = makeReentryResult();
    const result: TurnpointSequenceResult = {
      ...base,
      crossings: [...startCrossings, crossing(2, 70, 'enter'), crossing(3, 100, 'enter'), crossing(4, 105, 'enter')],
      sssReaching: sss,
      sequence: [sss, ...base.sequence.slice(1)],
    };
    const explanation = explainGapScore({
      task: makeTask(),
      result,
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });

    const flight = section(explanation, 'flight');
    const crossItems = flight.items.filter((i) => i.id.startsWith('start-crossing-'));
    // The first 11 crossings plus the scored (20th) one.
    expect(crossItems).toHaveLength(12);
    const scored = crossItems.filter((c) => c.text.includes('scored start'));
    expect(scored).toHaveLength(1);
    expect(scored[0].anchor!.kind).toBe('start');
    expect(scored[0].anchor!.timeMs).toBe(at(60).getTime());
    // The middle crossings are elided rather than the scored start dropped.
    const elided = flight.items.find((i) => i.id.startsWith('start-crossings-elided-'));
    expect(elided).toBeDefined();
    expect(elided!.text).toContain('8 more crossings');
    // Nothing after the scored (final) crossing, so no trailing summary.
    expect(flight.items.find((i) => i.id === 'start-crossings-more')).toBeUndefined();
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

    expect(explanation.headline).toBe('Made goal in 1:10:00 — 780.5 points');
  });

  it('flags a turnpoint credited by the cylinder tolerance band (§8.1)', () => {
    const sss = reaching(1, 30, 'last_before_next');
    // TP reached only via the tolerance band (near-miss graze).
    const tpA = reaching(2, 60, 'first_after_previous', 1, true);
    const result: TurnpointSequenceResult = {
      ...makeReentryResult(),
      crossings: [{ ...crossing(1, 30, 'exit'), time: sss.time }, crossing(2, 60, 'enter', true)],
      sequence: [sss, tpA, reaching(3, 100, 'first_crossing'), reaching(4, 105, 'first_after_previous')],
      sssReaching: sss,
    };
    const explanation = explainGapScore({
      task: makeTask(),
      result,
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    const flight = section(explanation, 'flight');
    const tp = flight.items.find((i) => i.id === 'reaching-2');
    expect(tp).toBeDefined();
    expect(tp!.detail).toContain('§8.1');
    expect(tp!.detail).toContain('tolerance');
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
    expect(bp!.text).toContain('best distance made good along the task');
    expect(bp!.detail).toContain('42.0 km');
    // Names the next un-reached turnpoint (last reached = 2, so next is ESS)
    // and makes clear the marker is the closest point to it, not to goal.
    expect(bp!.detail).toContain('next turnpoint, ESS (ESSWP)');
    expect(bp!.detail).toContain('not the point nearest goal');
    expect(bp!.anchor!.kind).toBe('best_progress');
    // The anchor carries the routed distance-to-goal polyline: the
    // best-progress point, then each un-reached turnpoint's tag point to goal.
    // Task has 5 turnpoints (goal idx 4); last reached is 2, so the un-reached
    // tail is indices 3 and 4 → 2 tag points + the best-progress point = 3.
    expect(bp!.anchor!.path).toBeDefined();
    expect(bp!.anchor!.path!.length).toBe(3);
    expect(bp!.anchor!.path![0]).toEqual({ latitude: -36.3, longitude: 147.3 });

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

  it('keeps the 0.5 linear factor for an HG pilot whose difficulty half is 0', () => {
    // The engine applies the linear/difficulty split to every HG pilot when
    // useDistanceDifficulty is on — a difficulty half of exactly 0 is
    // legitimate. The explanation must not fall back to the pure-linear
    // equation, which omits the 0.5 factor the engine actually applied.
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        made_goal: false,
        distance_points: 140,
        distance_linear_points: 140,
        distance_difficulty_points: 0,
        flown_distance: 42_000,
      },
      classContext: makeClassContext(),
      params: { scoring: 'HG', useDistanceDifficulty: true },
    });
    const dist = section(explanation, 'distance');
    const linear = dist.items.find((i) => i.id === 'distance-linear');
    expect(linear).toBeDefined();
    expect(linear!.detail).toContain('0.5 × (42.0 km ÷ 60.0 km)');
    expect(dist.items.find((i) => i.id === 'distance-difficulty')!.value).toBe('0 pts');
    // The pure-linear equation (no 0.5 factor) must not be shown.
    expect(dist.items.find((i) => i.id === 'distance-formula')).toBeUndefined();
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

  it('shows the §12.1 ESS-but-not-goal reduction as an explicit ×0.8 line (HG)', () => {
    // Our pilot reached ESS in 70 min but landed before goal; the fastest
    // pilot (65 min) made goal. Engine: sf × available × 0.8.
    const sf = calculateSpeedFraction(70 * 60, 65 * 60);
    const timePoints = Math.round(sf * 500 * 0.8 * 10) / 10;
    const ctx = makeClassContext();
    ctx.available_points.arrival = 50;
    const explanation = explainGapScore({
      task: makeTask(),
      result: { ...makeReentryResult(), madeGoal: false },
      entry: {
        ...makeGoalEntry(),
        made_goal: false,
        reached_ess: true,
        time_points: timePoints,
        arrival_points: 32,
      },
      classContext: ctx,
      params: { scoring: 'HG', useArrival: true },
    });

    const time = section(explanation, 'time');
    const reduction = time.items.find((i) => i.id === 'ess-not-goal');
    expect(reduction).toBeDefined();
    expect(reduction!.text).toContain('80%');
    expect(reduction!.text).toContain('§12.1');
    expect(reduction!.emphasis).toBe('warning');
    const formula = time.items.find((i) => i.id === 'time-formula');
    expect(formula!.detail).toContain('× 0.8 (ESS but not goal, §12.1)');
    expect(formula!.detail).toContain(`= ${timePoints}`);

    const arrival = section(explanation, 'arrival');
    const arrivalNote = arrival.items.find((i) => i.id === 'arrival-ess-not-goal');
    expect(arrivalNote).toBeDefined();
    expect(arrivalNote!.text).toContain('80%');
    expect(arrivalNote!.text).toContain('§12.1');
  });

  it('folds the §12.1 factor into the fastest-pilot equation too (HG)', () => {
    // The ESS-but-not-goal pilot set the fastest time (AirScore best-time
    // rule) — full speed fraction, then ×0.8.
    const ctx = makeClassContext();
    ctx.pilots[0] = { ...ctx.pilots[0], made_goal: false }; // our pilot
    ctx.pilots[1].speed_section_time = 80 * 60; // goal pilot is slower
    const explanation = explainGapScore({
      task: makeTask(),
      result: { ...makeReentryResult(), madeGoal: false },
      entry: { ...makeGoalEntry(), made_goal: false, reached_ess: true, time_points: 400 },
      classContext: ctx,
      params: { scoring: 'HG' },
    });
    const formula = section(explanation, 'time').items.find((i) => i.id === 'time-formula');
    expect(formula!.text).toContain('before the goal-validation reduction');
    expect(formula!.detail).toContain('500 available × 0.8 (ESS but not goal, §12.1) = 400');
  });

  it('explains a 0% ESS-but-not-goal factor and goal-validates the best time (HG)', () => {
    const ctx = makeClassContext();
    // Fastest overall reached only ESS — with factor 0 the best time must
    // come from the goal pilots instead.
    ctx.pilots.push({
      flown_distance: 58_000, speed_section_time: 60 * 60,
      made_goal: false, reached_ess: true,
    });
    const explanation = explainGapScore({
      task: makeTask(),
      result: { ...makeReentryResult(), madeGoal: false },
      entry: { ...makeGoalEntry(), made_goal: false, reached_ess: true, time_points: 0 },
      classContext: ctx,
      params: { scoring: 'HG', essNotGoalFactor: 0 },
    });
    const time = section(explanation, 'time');
    expect(time.items[0].id).toBe('no-time-points');
    expect(time.items[0].text).toContain('0% of time and arrival points');
    expect(time.items[0].text).toContain('§12.1');
  });

  it('goal-validated best time is shown to goal pilots when the factor is 0 (HG)', () => {
    const ctx = makeClassContext();
    // A faster ESS-only pilot exists (60 min) but must not set the best time.
    ctx.pilots.push({
      flown_distance: 58_000, speed_section_time: 60 * 60,
      made_goal: false, reached_ess: true,
    });
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: ctx,
      params: { scoring: 'HG', essNotGoalFactor: 0 },
    });
    const time = section(explanation, 'time');
    const best = time.items.find((i) => i.id === 'best-time');
    expect(best!.value).toBe('1:05:00'); // the fastest GOAL pilot, not 1:00:00
    expect(best!.text).toContain('among pilots who made goal');
    // A goal pilot keeps full points — no reduction line.
    expect(time.items.find((i) => i.id === 'ess-not-goal')).toBeUndefined();
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
        total_score: 730.5,
      },
      classContext: makeClassContext(),
    });
    const penalty = section(penalised, 'penalty');
    expect(penalty.items[0].text).toBe('Airspace infringement');
    expect(penalty.items[0].value).toBe('−50 pts');
    const total = section(penalised, 'total');
    expect(total.items[0].detail).toContain('− 50 penalty');
    expect(total.items[0].detail).toContain('= 730.5');
  });

  // The published components are rounded to 0.1 but the engine rounds the
  // total from their unrounded sum, so the printed figures can drift apart —
  // the equation must never claim "=" between figures that don't equate.
  it('marks the total equation as approximate when display rounding drifts from the total', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      // Components shown sum to 780.5, but the exact sum rounded to 780.6.
      entry: { ...makeGoalEntry(), total_score: 780.6 },
      classContext: makeClassContext(),
    });
    const total = section(explanation, 'total');
    expect(total.items[0].detail).toContain('400.0 + 380.5 ≈ 780.6');
    expect(total.items[0].detail).toContain('rounded');
    expect(total.items[0].detail).not.toContain('=');
  });

  it('narrates the §12.2 minimum-distance floor instead of printing false arithmetic', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        distance_points: 100,
        distance_linear_points: 100,
        time_points: 0,
        early_start_seconds: 180,
        early_start_outcome: 'hg_penalty',
        jump_the_gun_penalty: 90,
        total_score: 62.5, // the minimum-distance score, > 100 − 90
      },
      classContext: makeClassContext(),
      params: { scoring: 'HG' },
    });
    const total = section(explanation, 'total');
    expect(total.items[0].detail).toContain('100.0 + 0.0 − 90 jump-the-gun would come to 10');
    expect(total.items[0].detail).toContain('minimum-distance score (FAI S7F §12.2)');
    expect(total.items[0].detail).toContain('the total is 62.5');
  });

  it('narrates the §12.4 zero floor when a penalty takes the score below 0', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        penalty_points: 900,
        penalty_reason: 'Cloud flying',
        total_score: 0,
      },
      classContext: makeClassContext(),
    });
    const total = section(explanation, 'total');
    expect(total.items[0].detail).toContain('400.0 + 380.5 − 900 penalty would come to −119.5');
    expect(total.items[0].detail).toContain('scores never go below 0 (FAI S7F §12.4)');
  });

  // The engine's total is exactly 1000 × launch × distance × time, so the
  // equation must print the factors precisely enough to visibly multiply to
  // the total — never "1000 × 1.00 × 1.00 × 1.00 ≈ 999.3".
  it('adds factor decimals until the validity equation reconciles', () => {
    const ctx = makeClassContext();
    ctx.task_validity = { launch: 0.9876, distance: 0.8, time: 1, task: 0.79008 };
    ctx.available_points = { ...ctx.available_points, total: 790.08 };
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: ctx,
    });
    const validity = section(explanation, 'validity');
    const item = validity.items.find((i) => i.id === 'available-total');
    expect(item!.detail).toBe('1000 × 0.9876 × 0.80 × 1.00 = 790.1');
    // The factor rows show the same precision as the equation.
    const launch = validity.items.find((i) => i.id === 'launch-validity');
    expect(launch!.value).toBe('98.76%');
  });

  // The real-world report: a 0.9993 distance validity used to print as
  // "100%" on every row while the points on offer said 999.3.
  it('never prints a 100% validity alongside a sub-1000 points-on-offer', () => {
    const ctx = makeClassContext();
    ctx.task_validity = { launch: 1, distance: 0.9993, time: 1, task: 0.9993 };
    ctx.available_points = { ...ctx.available_points, total: 999.3 };
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: ctx,
    });
    const validity = section(explanation, 'validity');
    expect(validity.summary).toContain('99.93%');
    expect(validity.summary).toContain('999.3 of 1000');
    const distance = validity.items.find((i) => i.id === 'distance-validity');
    expect(distance!.value).toBe('99.93%');
    const launch = validity.items.find((i) => i.id === 'launch-validity');
    expect(launch!.value).toBe('100%');
    const item = validity.items.find((i) => i.id === 'available-total');
    expect(item!.detail).toBe('1000 × 1.00 × 0.9993 × 1.00 = 999.3');
  });

  // Distance points = (flown ÷ best) × available exactly — the printed km
  // figures must carry enough decimals for the printed equation to hold.
  it('adds km decimals until the linear-distance equation reconciles', () => {
    const flown = 76_923;
    const best = 78_812;
    const ctx = makeClassContext();
    ctx.pilots[0].flown_distance = best;
    ctx.available_points = { ...ctx.available_points, distance: 486 };
    const linear = 0.5 * (flown / best) * 486; // 237.176…
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        made_goal: false,
        flown_distance: flown,
        distance_points: linear,
        distance_linear_points: linear,
        distance_difficulty_points: 0,
      },
      classContext: ctx,
      params: { scoring: 'HG', useDistanceDifficulty: true },
    });
    const item = section(explanation, 'distance').items.find(
      (i) => i.id === 'distance-linear',
    );
    // 1-dp km figures give 237.1; 2 dp reconcile with the printed 237.2.
    expect(item!.detail).toBe('0.5 × (76.92 km ÷ 78.81 km) × 486 = 237.2');
  });

  // Time points = speed fraction × available exactly — the printed fraction
  // must multiply out to the printed points.
  it('prints a speed fraction precise enough to multiply out to the time points', () => {
    const ctx = makeClassContext();
    const sf = calculateSpeedFraction(70 * 60, 65 * 60, 5 / 6);
    const timePoints = sf * ctx.available_points.time;
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: { ...makeGoalEntry(), time_points: timePoints },
      classContext: ctx,
      params: { scoring: 'PG' },
    });
    const item = section(explanation, 'time').items.find(
      (i) => i.id === 'time-formula',
    );
    expect(item!.detail).not.toContain('≈');
    const m = item!.detail!.match(
      /= (\d+\.\d+); × ([\d.]+) available = ([\d.]+)/,
    );
    expect(m).not.toBeNull();
    // The digits the reader sees really do multiply to the printed points.
    expect(Math.round(Number(m![1]) * Number(m![2]) * 10)).toBe(
      Math.round(Number(m![3]) * 10),
    );
  });

  it('prints the jump-the-gun seconds precisely enough that the division holds', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        early_start_seconds: 73.6,
        early_start_outcome: 'hg_penalty',
        jump_the_gun_penalty: 36.8,
        total_score: 743.7,
      },
      classContext: makeClassContext(),
      params: { scoring: 'HG' },
    });
    const jtg = section(explanation, 'penalty').items.find(
      (i) => i.id === 'jump-the-gun',
    );
    // Never "74 s early ÷ 2 = 36.8".
    expect(jtg!.detail).toBe('73.6 s early ÷ 2 s per point = 36.8 points');
    expect(jtg!.value).toBe('−36.8 pts');
  });

  it('shows the available-points split at 0.1 so it sums to the total', () => {
    const ctx = makeClassContext();
    ctx.task_validity = { launch: 1, distance: 0.9993, time: 1, task: 0.9993 };
    ctx.available_points = {
      distance: 855.94,
      time: 143.39,
      leading: 0,
      arrival: 0,
      total: 999.33,
    };
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: ctx,
    });
    const split = section(explanation, 'validity').items.find(
      (i) => i.id === 'available-split',
    );
    expect(split!.detail).toBe('distance 855.9 · time 143.4');
  });

  // Only reachable when the stored total disagrees with the stored
  // validities (inconsistent API data) — the equation must not claim "=".
  it('falls back to ≈ when no precision reconciles the factors with the total', () => {
    const ctx = makeClassContext();
    ctx.task_validity = { launch: 0.9876, distance: 0.8, time: 1, task: 0.79008 };
    ctx.available_points = { ...ctx.available_points, total: 791.2 };
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: ctx,
    });
    const item = section(explanation, 'validity').items.find(
      (i) => i.id === 'available-total',
    );
    expect(item!.detail).toContain('≈ 791.2');
    expect(item!.detail).toContain('full precision');
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

  it('anchors the origin (cylinder edge) and furthest point', () => {
    const fixes = [fix(0, -35.98, 142.92), fix(10, -35.94, 142.97), fix(120, -35.6, 143.4)];
    const explanation = explainOpenDistanceScore({
      task: odTask,
      geometry: {
        origin: { latitude: -35.94, longitude: 142.97 },
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
    expect(origin!.text).toContain('5.0 km launch cylinder edge');
    expect(origin!.anchor!.kind).toBe('origin');
    // The origin is a derived edge point, not a track fix — no time.
    expect(origin!.anchor!.timeMs).toBeUndefined();
    expect(origin!.value).toBeUndefined();
    const furthest = flight.items.find((i) => i.id === 'furthest');
    expect(furthest!.anchor!.kind).toBe('furthest');
    expect(furthest!.anchor!.timeMs).toBe(at(120).getTime());
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

describe('explainOpenDistanceScore — anchorInfo (no fixes at hand)', () => {
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

  it('anchors origin/furthest from anchorInfo when fixes are absent', () => {
    const explanation = explainOpenDistanceScore({
      task: odTask,
      geometry: {
        origin: { latitude: -35.94, longitude: 142.97 },
        furthest: { latitude: -35.6, longitude: 143.4, fixIndex: 2 },
        distance: 52_341,
      },
      anchorInfo: {
        origin: { timeMs: at(10).getTime(), altitude: 850 },
        furthest: { timeMs: at(120).getTime(), altitude: 620 },
      },
      entry: {
        flown_distance: 52_341,
        penalty_points: 0,
        penalty_reason: null,
        total_score: 52_341,
      },
    });
    const flight = explanation.sections.find((s) => s.id === 'flight')!;
    const origin = flight.items.find((i) => i.id === 'origin')!;
    expect(origin.anchor!.timeMs).toBe(at(10).getTime());
    expect(origin.anchor!.altitude).toBe(850);
    expect(origin.value).toBeDefined();
    const furthest = flight.items.find((i) => i.id === 'furthest')!;
    expect(furthest.anchor!.timeMs).toBe(at(120).getTime());
    expect(furthest.anchor!.altitude).toBe(620);
  });
});

// ---------------------------------------------------------------------------
// Start gates & early starts (S7F §8.3.1, §12.2)
// ---------------------------------------------------------------------------

describe('explainGapScore — start gates & early starts', () => {
  it('narrates the gate taken vs the actual crossing and the gate-based clock', () => {
    const result: TurnpointSequenceResult = {
      ...makeReentryResult(),
      startGate: { time: at(25), index: 1, gateCount: 3 },
      speedSectionTime: 75 * 60, // ESS at 100 min − gate at 25 min
    };
    const entry = { ...makeGoalEntry(), speed_section_time: 75 * 60 };
    const x = explainGapScore({
      task: makeTask(), result, entry, classContext: makeClassContext(),
    });
    const flight = section(x, 'flight');
    const gateItem = flight.items.find((i) => i.id === 'start-gate')!;
    expect(gateItem.text).toContain('gate 2 of 3');
    expect(gateItem.text).toContain('not from the crossing');
    const time = section(x, 'time');
    const yourTime = time.items.find((i) => i.id === 'your-time')!;
    expect(yourTime.detail).toContain('start gate');
    expect(yourTime.detail).toContain('you crossed the start');
  });

  it('explains the HG jump-the-gun penalty with the formula substitution', () => {
    const result: TurnpointSequenceResult = {
      ...makeReentryResult(),
      startGate: { time: at(32), index: 0, gateCount: 3 },
      earlyStart: { crossingTime: at(30), firstGateTime: at(32), secondsEarly: 120 },
    };
    const entry: ScoreEntryInput = {
      ...makeGoalEntry(),
      early_start_seconds: 120,
      early_start_outcome: 'hg_penalty',
      jump_the_gun_penalty: 60,
      total_score: 720.5,
    };
    const x = explainGapScore({
      task: makeTask(), result, entry, classContext: makeClassContext(),
    });
    const flight = section(x, 'flight');
    const early = flight.items.find((i) => i.id === 'early-start')!;
    expect(early.text).toContain('before the first start gate');
    expect(early.emphasis).toBe('warning');
    const penalty = section(x, 'penalty');
    const jtg = penalty.items.find((i) => i.id === 'jump-the-gun')!;
    expect(jtg.value).toBe('−60 pts');
    expect(jtg.detail).toContain('120 s early ÷ 2 s per point = 60 points');
    const total = section(x, 'total');
    expect(total.items[0].detail).toContain('− 60 jump-the-gun');
  });

  it('explains the PG early-start launch→SSS clamp', () => {
    const result: TurnpointSequenceResult = {
      ...makeReentryResult(),
      startGate: { time: at(32), index: 0, gateCount: 3 },
      earlyStart: { crossingTime: at(30), firstGateTime: at(32), secondsEarly: 120 },
    };
    const entry: ScoreEntryInput = {
      ...makeGoalEntry(),
      made_goal: false,
      reached_ess: false,
      speed_section_time: null,
      flown_distance: 2800,
      early_start_seconds: 120,
      early_start_outcome: 'pg_launch_to_sss',
      total_score: 40,
    };
    const x = explainGapScore({
      task: makeTask(), result, entry,
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    expect(x.headline).toContain('Early start');
    const distance = section(x, 'distance');
    const clamp = distance.items.find((i) => i.id === 'early-start-distance')!;
    expect(clamp.text).toContain('launch to the start cylinder');
    expect(clamp.emphasis).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// Day quality — the validity factors' own inputs
//
// Every other section on the page states a rule, names its inputs and prints
// the arithmetic. Before these detail lines the validity section stated a rule
// and asserted a percentage, which is the one figure a reader cannot check.
// ---------------------------------------------------------------------------

function makeValidityInputs(): NonNullable<ClassContextInput['validity_inputs']> {
  return {
    num_present: 48,
    num_flying: 47,
    num_in_goal: 12,
    num_reached_ess: 15,
    best_distance: 60_000,
    best_time: 65 * 60,
    goal_ratio: 12 / 47,
    task_distance: 61_000,
    mean_distance_over_minimum: 44_100,
    weights: { distance: 0.442, time: 0.558, leading: 0, arrival: 0 },
  };
}

describe('explainGapScore — day quality inputs', () => {
  function validityFor(
    inputs?: ClassContextInput['validity_inputs'],
    params: Parameters<typeof explainGapScore>[0]['params'] = { scoring: 'PG' },
  ) {
    const ctx = makeClassContext();
    ctx.validity_inputs = inputs;
    return section(
      explainGapScore({
        task: makeTask(),
        result: makeReentryResult(),
        entry: makeGoalEntry(),
        classContext: ctx,
        params,
      }),
      'validity',
    );
  }

  it('shows the launch-validity inputs: who flew, who was present, the nominal threshold', () => {
    const item = validityFor(makeValidityInputs()).items.find(
      (i) => i.id === 'launch-validity',
    )!;
    expect(item.detail).toContain('47 pilots flew out of 48 present');
    expect(item.detail).toContain('96%');
  });

  it('shows the time-validity inputs: the winning time against the nominal time', () => {
    const item = validityFor(makeValidityInputs(), {
      scoring: 'PG',
      nominalTime: 90 * 60,
    }).items.find((i) => i.id === 'time-validity')!;
    // The reported gap: the section named a "nominal time" it never showed,
    // against a winning time that lived 200px down the page.
    expect(item.detail).toContain('1:05:00');
    expect(item.detail).toContain('1:30:00');
    expect(item.detail).toContain('72.2% of nominal');
  });

  it('reworded: a SHORT winning time is what devalues the day, not a long one', () => {
    const item = validityFor(makeValidityInputs()).items.find(
      (i) => i.id === 'time-validity',
    )!;
    expect(item.text).toContain('quicker than the task was meant to take');
    expect(item.text).not.toContain('long enough');
  });

  // The spec's ratio is min(1, best ÷ nominal), and printing the clamped
  // "100% of nominal" next to a winning time visibly LONGER than nominal
  // reads as an arithmetic error — which is exactly how it first shipped.
  it('does not print a clamped percentage when the winning time beat nominal', () => {
    const item = validityFor(makeValidityInputs(), {
      scoring: 'PG',
      nominalTime: 60 * 60,
    }).items.find((i) => i.id === 'time-validity')!;
    expect(item.detail).toContain('1:05:00');
    expect(item.detail).toContain('as long as it was meant to');
    expect(item.detail).not.toContain('100% of nominal');
  });

  it('compares distance instead when nobody completed the speed section', () => {
    const inputs = { ...makeValidityInputs(), best_time: null };
    const item = validityFor(inputs).items.find((i) => i.id === 'time-validity')!;
    expect(item.detail).toContain('Nobody completed the speed section');
    expect(item.detail).toContain('60.0 km');
  });

  it('shows the distance-validity inputs: the three nominals and the field spread', () => {
    const item = validityFor(makeValidityInputs(), {
      scoring: 'PG',
      nominalDistance: 70_000,
      nominalGoal: 0.2,
      minimumDistance: 5_000,
    }).items.find((i) => i.id === 'distance-validity')!;
    expect(item.detail).toContain('70.0 km nominal distance');
    expect(item.detail).toContain('20% nominal goal');
    expect(item.detail).toContain('5.0 km minimum distance');
    expect(item.detail).toContain('44.1 km past the minimum');
  });

  it('names the goal ratio and the weights behind the component split', () => {
    const validity = validityFor(makeValidityInputs());
    const split = validity.items.find((i) => i.id === 'available-split')!;
    expect(split.text).toContain('12 of 47 pilots made goal');
    expect(split.text).toContain('goal ratio of 0.26');
    const weights = validity.items.find((i) => i.id === 'available-weights')!;
    expect(weights.detail).toContain('distance 44.2%');
    expect(weights.detail).toContain('time 55.8%');
  });

  it('links to the explainer — the page had no route to /scoring/gap at all', () => {
    expect(validityFor(makeValidityInputs()).docHref).toBe('/scoring/gap#task-validity');
  });

  // The stale-first store keeps serving bodies written before these fields
  // existed, so the section must fall back to exactly what it always showed.
  it('degrades to the bare percentages when the payload predates validity_inputs', () => {
    const validity = validityFor(undefined);
    for (const id of ['launch-validity', 'distance-validity', 'time-validity']) {
      const item = validity.items.find((i) => i.id === id)!;
      expect(item.value).toBeDefined();
      expect(item.detail).toBeUndefined();
    }
    expect(validity.items.find((i) => i.id === 'available-weights')).toBeUndefined();
    expect(validity.items.find((i) => i.id === 'available-split')!.text).toBe(
      'Split between the components by the goal ratio',
    );
  });
});

// ---------------------------------------------------------------------------
// Reading the score against the field
// ---------------------------------------------------------------------------

describe('explainGapScore — where the points went', () => {
  /** A class whose leader beat this pilot on time alone. */
  function fieldContext(): ClassContextInput {
    const ctx = makeClassContext();
    ctx.pilots = [
      {
        flown_distance: 60_000, speed_section_time: 65 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Fast Pilot', rank: 1, total_score: 900,
        distance_points: 400, time_points: 500,
        leading_points: 0, arrival_points: 0,
      },
      {
        flown_distance: 60_000, speed_section_time: 70 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Our Pilot', rank: 2, total_score: 780.5,
        distance_points: 400, time_points: 380.5,
        leading_points: 0, arrival_points: 0,
      },
    ];
    return ctx;
  }

  function comparisonFor(ctx: ClassContextInput) {
    return explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: ctx,
      params: { scoring: 'PG' },
    }).sections.find((s) => s.id === 'comparison');
  }

  it('names the leader and the per-component gaps', () => {
    const s = comparisonFor(fieldContext())!;
    expect(s.summary).toContain('780.5');
    expect(s.summary).toContain('900');
    expect(s.items.find((i) => i.id === 'gap-distance')!.value).toBe('level');
    expect(s.items.find((i) => i.id === 'gap-time')!.value).toBe('−119.5 pts');
  });

  it('says which component the gap actually is', () => {
    const total = comparisonFor(fieldContext())!.items.find((i) => i.id === 'gap-total')!;
    expect(total.text).toContain('Fast Pilot');
    expect(total.value).toBe('−119.5 pts');
    expect(total.detail).toBe('All of the gap is time-points.');
  });

  // Jon Durand's case: fastest through the speed section (+67 on time) but
  // beaten on leading — the leading loss is BIGGER than the net gap, and the
  // old "85.6 of 38.9 points" wording read as an arithmetic error.
  it('re-words the dominant loss when it exceeds the whole gap', () => {
    const ctx = fieldContext();
    ctx.available_points = {
      distance: 400, time: 400, leading: 100, arrival: 0, total: 900,
    };
    ctx.pilots = [
      {
        flown_distance: 60_000, speed_section_time: 70 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Leader', rank: 1, total_score: 833,
        distance_points: 400, time_points: 333, leading_points: 100,
        arrival_points: 0,
      },
      {
        flown_distance: 60_000, speed_section_time: 65 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Fast Pilot', rank: 2, total_score: 810,
        distance_points: 400, time_points: 400, leading_points: 10,
        arrival_points: 0,
      },
    ];
    const s = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        speed_section_time: 65 * 60,
        time_points: 400,
        leading_points: 10,
        total_score: 810,
      },
      classContext: ctx,
      params: { scoring: 'PG' },
    }).sections.find((sec) => sec.id === 'comparison')!;
    const total = s.items.find((i) => i.id === 'gap-total')!;
    // Gap 23, leading loss 90, time gain 67: never "90 of 23 points".
    expect(total.detail).toBe(
      'You took 90 fewer leading-points than the leader — more than the whole gap — and won 67 back on time-points. ' +
      'Leading-points reward being out front on the clock, which the fastest pilot often isn’t.',
    );
  });

  // A ledger that omits penalties cannot reconcile with the gap it explains.
  it('carries penalties as a ledger row and names the spread, largest first', () => {
    const ctx = fieldContext();
    // Leader clean on 900; this pilot lost 69.5 on time and 70 to a penalty
    // (components 830.5, penalty 70 → published total 760.5).
    ctx.pilots[1] = {
      ...ctx.pilots[1], total_score: 760.5, time_points: 430.5,
    };
    ctx.pilots[0] = { ...ctx.pilots[0], time_points: 500, total_score: 900 };
    const s = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        time_points: 430.5,
        penalty_points: 70,
        penalty_reason: 'Airspace infringement',
        total_score: 760.5,
      },
      classContext: ctx,
      params: { scoring: 'PG' },
    }).sections.find((sec) => sec.id === 'comparison')!;
    const pen = s.items.find((i) => i.id === 'gap-penalty')!;
    expect(pen.value).toBe('−70 pts');
    expect(pen.detail).toBe('you −70, the leader 0');
    const total = s.items.find((i) => i.id === 'gap-total')!;
    expect(total.value).toBe('−139.5 pts');
    // 69.5 lost on time + 70 to the penalty: no single culprit, so the
    // spread names its members with the largest first — never a bare count.
    expect(total.detail).toBe(
      'Spread across penalties and time-points — penalties the largest, at 70.',
    );
  });

  // The leader used to get nothing here — and the winner's actual question
  // ("full validity, why not full points?") went unanswered on the one page
  // built to answer it. They now get the vs-the-day variant.
  it('gives the class leader the points-left-on-the-day variant instead of nothing', () => {
    const ctx = fieldContext();
    ctx.pilots[0] = { ...ctx.pilots[0], total_score: 780.5, time_points: 380.5 };
    const s = comparisonFor(ctx)!;
    expect(s.title).toBe('The points left on the day');
    expect(s.summary).toContain('Nobody out-scored you');
    expect(s.summary).toContain('900');
    // Distance was maxed; time is where the day's missing points are.
    const dist = s.items.find((i) => i.id === 'left-distance')!;
    expect(dist.value).toBe('full points');
    expect(dist.emphasis).toBe('muted');
    const time = s.items.find((i) => i.id === 'left-time')!;
    expect(time.value).toBe('−119.5 pts');
    expect(time.detail).toBe('you 380.5 of 500 on offer');
    const total = s.items.find((i) => i.id === 'left-total')!;
    expect(total.value).toBe('−119.5 pts');
    expect(total.detail).toBe('All of it is time-points.');
  });

  // Rohan's case: the winner was not the fastest to ESS — another pilot took
  // the full time points (and lost the day elsewhere). Name them.
  it('names the pilot who took the full time points, with their time', () => {
    const ctx = fieldContext();
    ctx.available_points = {
      distance: 380, time: 450, leading: 0, arrival: 70, total: 900,
    };
    ctx.pilots = [
      {
        flown_distance: 60_000, speed_section_time: 65 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Fast Pilot', rank: 2, total_score: 700,
        distance_points: 380, time_points: 450,
        leading_points: 0, arrival_points: 20,
      },
      {
        flown_distance: 60_000, speed_section_time: 70 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Our Pilot', rank: 1, total_score: 850,
        distance_points: 380, time_points: 400,
        leading_points: 0, arrival_points: 70,
      },
    ];
    const s = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        distance_points: 380,
        time_points: 400,
        arrival_points: 70,
        total_score: 850,
      },
      classContext: ctx,
      params: { scoring: 'HG', useArrival: true },
    }).sections.find((sec) => sec.id === 'comparison')!;
    const time = s.items.find((i) => i.id === 'left-time')!;
    expect(time.detail).toContain('Fast Pilot took the full time-points in 1:05:00');
    // Our pilot was first to ESS points-wise, so arrival reads as maxed.
    expect(s.items.find((i) => i.id === 'left-arrival')!.value).toBe('full points');
  });

  // §12.2: a floored jump-the-gun deduction's PUBLISHED figure overstates its
  // net effect — the ledger derives the net from components − total instead.
  it('shows the net penalty effect, not the gross deduction, when a floor engaged', () => {
    const ctx = fieldContext();
    // Components 780.5, gross deduction 90, but floored at 750 — net 30.5.
    ctx.pilots[1] = { ...ctx.pilots[1], total_score: 750 };
    const s = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        early_start_seconds: 180,
        early_start_outcome: 'hg_penalty',
        jump_the_gun_penalty: 90,
        total_score: 750,
      },
      classContext: ctx,
      params: { scoring: 'HG' },
    }).sections.find((sec) => sec.id === 'comparison')!;
    const pen = s.items.find((i) => i.id === 'gap-penalty')!;
    expect(pen.value).toBe('−30.5 pts');
    expect(pen.detail).toContain('net effect after the scoring floor');
    // And the ledger reconciles: 119.5 time + 30.5 net penalty = the gap.
    expect(s.items.find((i) => i.id === 'gap-total')!.value).toBe('−150 pts');
  });

  // A nobody-in-goal HG day: the GAP weight split sums to slightly more than
  // 1 (time weight clamped at zero), so the component offers overshoot the
  // day total — the winner's ledger must say so instead of printing a share
  // its own rows contradict.
  it("explains the weight overshoot on a nobody-in-goal day instead of a broken share", () => {
    const ctx = fieldContext();
    // Offers sum to 943.8 on a 934.7-point day (real Dalby 2022 shape).
    ctx.available_points = {
      distance: 841.2, time: 0, leading: 90.9, arrival: 11.7, total: 934.7,
    };
    ctx.pilots = [
      {
        flown_distance: 60_000, speed_section_time: null,
        made_goal: false, reached_ess: false,
        pilot_name: 'Winner', rank: 1, total_score: 932.1,
        distance_points: 841.2, time_points: 0,
        leading_points: 90.9, arrival_points: 0,
      },
      {
        flown_distance: 50_000, speed_section_time: null,
        made_goal: false, reached_ess: false,
        pilot_name: 'Runner Up', rank: 2, total_score: 700,
        distance_points: 700, time_points: 0,
        leading_points: 0, arrival_points: 0,
      },
    ];
    const x = explainGapScore({
      task: makeTask(),
      result: { ...makeReentryResult(), madeGoal: false },
      entry: {
        ...makeGoalEntry(),
        made_goal: false,
        reached_ess: false,
        speed_section_time: null,
        distance_points: 841.2,
        time_points: 0,
        leading_points: 90.9,
        arrival_points: 0,
        total_score: 932.1,
      },
      classContext: ctx,
      params: { scoring: 'HG', useArrival: true },
    });
    const s = x.sections.find((sec) => sec.id === 'comparison')!;
    const total = s.items.find((i) => i.id === 'left-total')!;
    expect(total.value).toBe('−2.6 pts');
    expect(total.detail).toContain('offers sum to 943.8 on a 934.7-point day');
    expect(total.detail).toContain('overshoot');
    expect(total.detail).toContain('The biggest untaken offer is arrival-points.');
    // The headline note drops its share clause rather than claim "all of it
    // arrival" about a 2.6-point remainder beside an 11.7-point offer.
    expect(x.headlineNote).toBe(
      'Top of the class, but not a full sweep: of the 934.7 points on offer, 2.6 went untaken.',
    );
  });

  it('is omitted for a leader who swept the day — a full house needs no ledger', () => {
    const ctx = fieldContext();
    ctx.pilots[0] = { ...ctx.pilots[0], total_score: 780.5, time_points: 380.5 };
    ctx.available_points = {
      distance: 400, time: 380.5, leading: 0, arrival: 0, total: 780.5,
    };
    expect(comparisonFor(ctx)).toBeUndefined();
  });

  it('is omitted when the payload carries no per-pilot point components', () => {
    expect(comparisonFor(makeClassContext())).toBeUndefined();
  });

  it('ignores a withheld tracklog when picking the leader', () => {
    const ctx = fieldContext();
    ctx.pilots.push({
      flown_distance: 0, speed_section_time: null, made_goal: false, reached_ess: false,
      pilot_name: 'Bad Track', rank: 3, total_score: 0,
      distance_points: 0, time_points: 0, leading_points: 0, arrival_points: 0,
      track_excluded: { reasons: ['wrong day'] },
    });
    expect(comparisonFor(ctx)!.items.find((i) => i.id === 'gap-total')!.text).toContain(
      'Fast Pilot',
    );
  });
});

// ---------------------------------------------------------------------------
// Leading points — the arithmetic, not just the number
// ---------------------------------------------------------------------------

describe('explainGapScore — leading points', () => {
  function leadingFor(lc: number | null, bestLc: number) {
    const ctx = makeClassContext();
    ctx.available_points = { ...ctx.available_points, leading: 100 };
    ctx.pilots = ctx.pilots.map((p, i) => ({
      ...p,
      leading_coefficient: i === 0 ? bestLc : lc,
    }));
    const entry = { ...makeGoalEntry(), leading_points: 62.5, leading_coefficient: lc };
    return section(
      explainGapScore({
        task: makeTask(),
        result: makeReentryResult(),
        entry,
        classContext: ctx,
        params: { scoring: 'PG', leadingFormula: 'weighted' },
      }),
      'leading',
    );
  }

  it('prints the coefficient, the best in class, and the substituted formula', () => {
    const s = leadingFor(1.284, 0.981);
    expect(s.items.find((i) => i.id === 'leading-coefficient')!.value).toBe('1.284');
    expect(s.items.find((i) => i.id === 'leading-coefficient')!.detail).toContain('0.981');
    const formula = s.items.find((i) => i.id === 'leading-formula')!;
    expect(formula.detail).toContain('LCbest');
    expect(formula.detail).toContain('× 100 available');
  });

  it('says so plainly when the pilot holds the best coefficient', () => {
    const s = leadingFor(0.981, 0.981);
    expect(s.items.find((i) => i.id === 'leading-coefficient')!.detail).toContain(
      'best in the class',
    );
    expect(s.items.find((i) => i.id === 'leading-formula')).toBeUndefined();
  });

  it('falls back to the plain sentence when no coefficient was published', () => {
    const s = leadingFor(null, 0.981);
    expect(s.items.find((i) => i.id === 'leading-coefficient')).toBeUndefined();
    expect(s.items.find((i) => i.id === 'leading')!.value).toBe('62.5 pts');
  });
});

// ---------------------------------------------------------------------------
// Flight narrative repairs
// ---------------------------------------------------------------------------

describe('explainGapScore — flight narrative repairs', () => {
  it('folds a co-located ESS and goal into one row', () => {
    // An ESS ring around the goal cylinder: two task indices, one instant.
    // Two rows printed the same time and the same crossing count twice.
    const sss = reaching(1, 30, 'first_crossing');
    const ess = reaching(3, 105, 'first_crossing');
    const goal = { ...reaching(4, 105, 'first_crossing'), time: ess.time };
    const explanation = explainGapScore({
      task: makeTask(),
      result: {
        ...makeReentryResult(),
        crossings: [crossing(1, 30, 'exit')],
        sequence: [sss, reaching(2, 60, 'first_after_previous'), ess, goal],
        sssReaching: sss,
        essReaching: ess,
      },
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    const rows = section(explanation, 'flight').items.filter((i) =>
      i.id.startsWith('reaching-'),
    );
    const merged = rows.find((r) => r.text.startsWith('ESS + Goal'))!;
    expect(rows.filter((r) => r.value === merged.value)).toHaveLength(1);
    // The surviving row keeps the ESS treatment it would otherwise have lost.
    expect(merged.detail).toContain('Speed section completed in');
  });

  it('says why THIS start crossing scored, not just the general rule', () => {
    const explanation = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    const chosen = section(explanation, 'flight').items.find(
      (i) => i.id === 'start-chosen',
    )!;
    // The scored start is the last crossing in this fixture.
    expect(chosen.text).toContain('the last one made');
  });
});

// ---------------------------------------------------------------------------
// Arrival points — the last component that could only assert its output
// ---------------------------------------------------------------------------

describe('explainGapScore — arrival points', () => {
  /** An HG class where 22 pilots reached ESS and ours came 7th. */
  function arrivalFor(
    position: number | null,
    opts: { essTimeMs?: number | null; tie?: boolean } = {},
  ) {
    const ctx = makeClassContext();
    ctx.available_points = { ...ctx.available_points, arrival: 100 };
    ctx.validity_inputs = { ...makeValidityInputs(), num_reached_ess: 22 };
    if (opts.tie) {
      ctx.pilots = [
        ...ctx.pilots,
        {
          flown_distance: 60_000, speed_section_time: 66 * 60,
          made_goal: true, reached_ess: true, ess_time_ms: opts.essTimeMs ?? null,
        },
      ];
    }
    const entry: ScoreEntryInput = {
      ...makeGoalEntry(),
      // 7th of 22 -> factor 0.5545 -> 55.4 of 100 available.
      arrival_points: 55.4,
      arrival_position: position,
      ess_time_ms: opts.essTimeMs ?? Date.UTC(2026, 0, 10, 5, 13, 40),
    };
    if (opts.tie) {
      ctx.pilots = ctx.pilots.map((p, i) =>
        i === 0 ? { ...p, ess_time_ms: entry.ess_time_ms } : p,
      );
    }
    return section(
      explainGapScore({
        task: makeTask(),
        result: makeReentryResult(),
        entry,
        classContext: ctx,
        params: { scoring: 'HG', useArrival: true },
      }),
      'arrival',
    );
  }

  it('prints the position, the ESS time, and the substituted §11.4 formula', () => {
    const s = arrivalFor(7);
    const pos = s.items.find((i) => i.id === 'arrival-position')!;
    expect(pos.text).toBe('Reached the end of the speed section 7th of 22');
    expect(pos.value).toContain('05:13:40');
    const formula = s.items.find((i) => i.id === 'arrival-formula')!;
    expect(formula.detail).toContain('1 − (7 − 1) ÷ 22');
    expect(formula.detail).toContain('0.2 + 0.037·r + 0.13·r² + 0.633·r³');
    expect(formula.detail).toContain('× 100 available');
  });

  // The single most disputable fact about arrival points, and nothing on the
  // site said it before.
  it('says the order is by the clock, not by speed', () => {
    const pos = arrivalFor(7).items.find((i) => i.id === 'arrival-position')!;
    expect(pos.detail).toContain('by the clock');
    expect(pos.detail).toContain('not by speed');
  });

  it('prices one place, and states the floor everyone keeps', () => {
    const shape = arrivalFor(7).items.find((i) => i.id === 'arrival-shape')!;
    // af(6) − af(7) over 100 available, from the engine's own function.
    expect(shape.text).toMatch(/^One place earlier would have been worth \d+(\.\d)? more points$/);
    expect(shape.detail).toContain('first place takes all 100 available');
    expect(shape.detail).toContain('at least');
  });

  it('says so plainly for the first pilot to ESS, with no counterfactual', () => {
    const s = arrivalFor(1);
    expect(s.items.find((i) => i.id === 'arrival-shape')!.text).toContain(
      'First to the end of the speed section',
    );
  });

  // Positions are resolved by array order when timestamps collide, which is
  // not a fact about the flying — so it must not be presented as one.
  it('discloses a tie rather than implying an order the data cannot support', () => {
    const t = Date.UTC(2026, 0, 10, 5, 13, 40);
    const pos = arrivalFor(7, { essTimeMs: t, tie: true }).items.find(
      (i) => i.id === 'arrival-position',
    )!;
    expect(pos.detail).toContain('same second');
  });

  it('degrades to the field size when no position was published', () => {
    const s = arrivalFor(null);
    expect(s.items.find((i) => i.id === 'arrival-formula')).toBeUndefined();
    expect(s.items.find((i) => i.id === 'arrival-field')!.text).toContain(
      '22 pilots reached the end of the speed section',
    );
  });
});

// ---------------------------------------------------------------------------
// Component charts — the formula, with the field on it
// ---------------------------------------------------------------------------

describe('explainGapScore — component charts', () => {
  /** A 5-pilot HG class with leading and arrival on, and known point values. */
  function chartContext(): ClassContextInput {
    const ctx = makeClassContext();
    ctx.available_points = {
      distance: 400, time: 500, leading: 100, arrival: 100, total: 1100,
    };
    ctx.validity_inputs = { ...makeValidityInputs(), num_reached_ess: 4 };
    // Times chosen so the published points ARE the formula's value; the
    // builders verify that themselves, which is the point of the fixture.
    const mk = (
      id: string, name: string, t: number, timePts: number,
      pos: number | null, arrPts: number,
    ) => ({
      comp_pilot_id: id, pilot_name: name,
      flown_distance: 60_000, speed_section_time: t,
      made_goal: true, reached_ess: true,
      total_score: 0, distance_points: 400, time_points: timePts,
      leading_points: 0, arrival_points: arrPts,
      arrival_position: pos, ess_time_ms: null,
    });
    const exp = speedExponentValue('5/6');
    const best = 60 * 60;
    const tOf = (t: number) => calculateSpeedFraction(t, best, exp) * 500;
    ctx.pilots = [
      mk('a', 'Alpha', best, tOf(best), 1, calculateArrivalPoints(1, 4, 100)),
      mk('b', 'Bravo', 70 * 60, tOf(70 * 60), 2, calculateArrivalPoints(2, 4, 100)),
      mk('c', 'Charlie', 80 * 60, tOf(80 * 60), 3, calculateArrivalPoints(3, 4, 100)),
      mk('d', 'Delta', 95 * 60, tOf(95 * 60), 4, calculateArrivalPoints(4, 4, 100)),
    ];
    return ctx;
  }

  function chartsFor(ctx: ClassContextInput, meId = 'c') {
    const me = ctx.pilots.find((p) => p.comp_pilot_id === meId)!;
    const entry: ScoreEntryInput = {
      ...makeGoalEntry(),
      comp_pilot_id: meId,
      speed_section_time: me.speed_section_time,
      time_points: me.time_points!,
      arrival_points: me.arrival_points!,
      arrival_position: me.arrival_position,
    };
    const ex = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry,
      classContext: ctx,
      params: { scoring: 'HG', useArrival: true, useDistanceDifficulty: false },
    });
    return ex;
  }

  it('plots the time curve from the scoring function, with every pilot on it', () => {
    const chart = curveChart(section(chartsFor(chartContext()), 'time'));
    expect(chart.xUnit).toBe('duration');
    expect(chart.pilots).toHaveLength(4);
    expect(chart.omitted).toBe(0);
    expect(chart.curve.length).toBeGreaterThan(10);
    // Every dot is ON the curve — the claim the caption makes.
    for (const p of chart.pilots) {
      const near = chart.curve.reduce((a, c) =>
        Math.abs(c.x - p.x) < Math.abs(a.x - p.x) ? c : a
      );
      expect(Math.abs(near.y - p.y)).toBeLessThan(2);
    }
  });

  it('marks exactly one pilot as "you"', () => {
    const chart = curveChart(section(chartsFor(chartContext()), 'time'));
    const you = chart.pilots.filter((p) => p.you);
    expect(you).toHaveLength(1);
    expect(you[0].name).toBe('Charlie');
  });

  it('states in the caption that the curve is the formula, not a fit', () => {
    const chart = curveChart(section(chartsFor(chartContext()), 'time'));
    expect(chart.caption).toContain('is the time-points formula');
    expect(chart.caption).toContain('sitting exactly on it');
    expect(chart.caption).not.toContain('trend');
  });

  // The rule that keeps that claim true: a pilot whose published points carry
  // a reduction the curve does not model is counted out, not drawn beside it.
  it('omits a pilot the curve does not explain, and says how many', () => {
    const ctx = chartContext();
    ctx.pilots[1] = { ...ctx.pilots[1], time_points: ctx.pilots[1].time_points! * 0.8 };
    const chart = curveChart(section(chartsFor(ctx), 'time'));
    expect(chart.pilots).toHaveLength(3);
    expect(chart.omitted).toBe(1);
    expect(chart.caption).toContain('1 pilot is not shown');
  });

  // A chart whose whole job is to locate you is worse than none when it can't.
  it('suppresses the chart entirely when the viewing pilot is the omitted one', () => {
    const ctx = chartContext();
    ctx.pilots[2] = { ...ctx.pilots[2], time_points: 1.5 };
    expect(section(chartsFor(ctx), 'time').chart).toBeUndefined();
  });

  it('plots arrival against position, sampling the §11.4 curve', () => {
    const chart = curveChart(section(chartsFor(chartContext()), 'arrival'));
    expect(chart.xUnit).toBe('position');
    expect(chart.pilots.map((p) => p.x)).toEqual([1, 2, 3, 4]);
    expect(chart.caption).toContain('by the clock');
  });

  it('draws no chart for a component with no points on offer', () => {
    const ctx = chartContext();
    ctx.available_points = { ...ctx.available_points, arrival: 0 };
    ctx.pilots = ctx.pilots.map((p) => ({ ...p, arrival_points: 0, arrival_position: null }));
    const ex = chartsFor(ctx);
    expect(ex.sections.find((s) => s.id === 'arrival')).toBeUndefined();
  });

  // The HG difficulty half is a step function built from where the whole field
  // landed out. It is reconstructed from the class context rather than taken
  // from the payload, so the interesting assertion is that the reconstruction
  // reproduces the published points — if it did not, placeField would omit
  // every pilot and the chart would vanish. (The archive-wide check is
  // web/scripts/audit-score-charts.ts, which runs the same path over every
  // task in the comp library and demands zero unexplained pilots.)
  it('draws the HG difficulty curve, reconstructed from where the field landed', () => {
    const available = 400;
    const dists = [60_000, 52_000, 41_000, 33_000, 21_000, 12_000, 7_000];
    const goals = [true, false, false, false, false, false, false];
    const difficulty = calculateDistanceDifficulty(dists, goals, 5_000);
    const best = Math.max(...dists);
    const pointsFor = (d: number) =>
      ((0.5 * d) / best) * available + difficulty.fractionFor(d) * available;

    const ctx = makeClassContext();
    ctx.available_points = { ...ctx.available_points, distance: available };
    ctx.pilots = dists.map((d, i) => ({
      comp_pilot_id: `p${i}`,
      pilot_name: `Pilot ${i}`,
      flown_distance: d,
      speed_section_time: null,
      made_goal: goals[i],
      reached_ess: goals[i],
      distance_points: pointsFor(d),
      time_points: 0,
      leading_points: 0,
      arrival_points: 0,
      total_score: pointsFor(d),
    }));

    const chart = curveChart(section(
      explainGapScore({
        task: makeTask(),
        result: makeReentryResult(),
        entry: {
          ...makeGoalEntry(),
          comp_pilot_id: 'p3',
          flown_distance: 33_000,
          distance_points: pointsFor(33_000),
          made_goal: false,
        },
        classContext: ctx,
        params: { scoring: 'HG', useDistanceDifficulty: true, minimumDistance: 5_000 },
      }),
      'distance',
    ));

    // Every pilot explained — the reconstruction matches the published points.
    expect(chart.pilots).toHaveLength(dists.length);
    expect(chart.omitted).toBe(0);
    // A step function needs real samples; the linear case is drawn with two.
    expect(chart.curve.length).toBeGreaterThan(50);
    expect(chart.caption).toContain('where the field landed out');
    expect(chart.caption).toContain('§11.1.1');
  });

  it('draws the plain linear distance line when difficulty is off', () => {
    const chart = curveChart(section(chartsFor(chartContext()), 'distance'));
    expect(chart.curve).toHaveLength(2);
    expect(chart.caption).toContain('straight line');
  });
});

// ---------------------------------------------------------------------------
// Validity charts — day facts, and the one factor that wants a distribution
// ---------------------------------------------------------------------------

describe('explainGapScore — validity charts', () => {
  function validityItems(
    inputs: ClassContextInput['validity_inputs'],
    params: Parameters<typeof explainGapScore>[0]['params'] = { scoring: 'PG' },
    pilots?: ClassContextInput['pilots'],
  ) {
    const ctx = makeClassContext();
    ctx.validity_inputs = inputs;
    if (pilots) ctx.pilots = pilots;
    return section(
      explainGapScore({
        task: makeTask(),
        result: makeReentryResult(),
        entry: { ...makeGoalEntry(), comp_pilot_id: 'me' },
        classContext: ctx,
        params,
      }),
      'validity',
    ).items;
  }

  it('gives launch and time validity a curve carrying exactly one point — the day', () => {
    const items = validityItems(makeValidityInputs(), {
      scoring: 'PG',
      nominalTime: 90 * 60,
    });
    for (const id of ['launch-validity', 'time-validity']) {
      const chart = items.find((i) => i.id === id)!.chart!;
      expect(chart.kind).toBe('validity');
      if (chart.kind !== 'validity') throw new Error('narrowing');
      expect(chart.curve.length).toBeGreaterThan(10);
      // A validity factor is a fact about the TASK: one point, not a field.
      expect(chart.point.x).toBeGreaterThan(0);
      expect(chart.point.x).toBeLessThanOrEqual(1);
      expect(chart.curve.every((p) => p.x >= 0 && p.x <= 1)).toBe(true);
    }
  });

  // Distance validity uses its ratio as-is, so its "curve" is the identity
  // line. Drawing that would be ink pretending to be an explanation.
  it('gives distance validity a distribution rather than a curve', () => {
    const pilots = Array.from({ length: 8 }, (_, i) => ({
      comp_pilot_id: i === 0 ? 'me' : `p${i}`,
      pilot_name: `Pilot ${i}`,
      flown_distance: 10_000 + i * 6_000,
      speed_section_time: null,
      made_goal: false,
      reached_ess: false,
    }));
    const chart = validityItems(
      makeValidityInputs(),
      { scoring: 'PG', nominalDistance: 40_000, minimumDistance: 5_000 },
      pilots,
    ).find((i) => i.id === 'distance-validity')!.chart!;
    expect(chart.kind).toBe('distribution');
    if (chart.kind !== 'distribution') throw new Error('narrowing');
    // One dot per flying pilot — this is a picture of the field, not a claim
    // that a formula explains each of them, so nobody is filtered out.
    expect(chart.points).toHaveLength(pilots.length);
    expect(chart.points.filter((p) => p.you)).toHaveLength(1);
    expect(chart.markers.map((m) => m.label).sort()).toEqual([
      'minimum',
      'nominal',
      'you',
    ]);
    // makeGoalEntry flies 60 km, past the field's best — the axis is
    // defined to contain the reader's own mark rather than drop it.
    expect(chart.markers.find((m) => m.you)!.x).toBe(60_000);

  });

  it('draws no time-validity curve when the spec fell back to distance', () => {
    const items = validityItems({ ...makeValidityInputs(), best_time: null });
    expect(items.find((i) => i.id === 'time-validity')!.chart).toBeUndefined();
  });

  it('draws nothing at all on a payload with no validity inputs', () => {
    const items = validityItems(undefined);
    for (const id of ['launch-validity', 'time-validity']) {
      expect(items.find((i) => i.id === id)!.chart).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Surfacing the standings: per-section ranks, points-of-available, and the
// winner's headline note (the "full validity but not 1000 points" report).
// ---------------------------------------------------------------------------

describe('explainGapScore — section ranks and available points', () => {
  it('states each component section\'s points against the points on offer', () => {
    const x = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    expect(section(x, 'distance').pointsAvailable).toBe(400);
    expect(section(x, 'time').pointsAvailable).toBe(500);
    // The total's offer is the day's, so "780.5 of 900" is readable there too.
    expect(section(x, 'total').pointsAvailable).toBe(900);
  });

  it('ranks the time section by speed-section time, not by points', () => {
    const x = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    expect(section(x, 'time').rank).toBe('2nd fastest of 2 through the speed section');
  });

  it('says how far behind the fastest pilot this time was, naming them when known', () => {
    const anonymous = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    expect(
      section(anonymous, 'time').items.find((i) => i.id === 'best-time')!.detail,
    ).toBe('You were 5:00 behind.');

    const ctx = makeClassContext();
    ctx.pilots[1] = { ...ctx.pilots[1], pilot_name: 'Fast Pilot' };
    const named = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: ctx,
      params: { scoring: 'PG' },
    });
    expect(
      section(named, 'time').items.find((i) => i.id === 'best-time')!.detail,
    ).toBe('Set by Fast Pilot — you were 5:00 behind.');
  });

  it('gives the fastest pilot the top rank and no behind detail', () => {
    const ctx = makeClassContext();
    ctx.pilots[1].speed_section_time = 80 * 60;
    const x = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: { ...makeGoalEntry(), time_points: 500 },
      classContext: ctx,
      params: { scoring: 'PG' },
    });
    expect(section(x, 'time').rank).toBe('Fastest of 2 through the speed section');
    expect(
      section(x, 'time').items.find((i) => i.id === 'best-time')!.detail,
    ).toBeUndefined();
  });

  // A goal day is degenerate for a distance rank — every goal pilot ties at
  // full distance, and "equal 1st of 30" would say nothing.
  it('words the distance rank as the goal tie for a goal pilot', () => {
    const x = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    expect(section(x, 'distance').rank).toBe('Full distance — one of 2 pilots in goal');
  });

  it('ranks a landed-out pilot by distance flown', () => {
    const x = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: { ...makeGoalEntry(), made_goal: false, flown_distance: 42_000 },
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    // 60 km, 60 km, then this pilot's 42 km — tied with the third fixture row.
    expect(section(x, 'distance').rank).toBe('3rd furthest of 3');
  });

  it('ranks arrival by position and leading by coefficient', () => {
    const ctx = makeClassContext();
    ctx.available_points = {
      ...ctx.available_points, leading: 100, arrival: 100,
    };
    ctx.validity_inputs = { ...makeValidityInputs(), num_reached_ess: 22 };
    ctx.pilots = ctx.pilots.map((p, i) => ({
      ...p,
      leading_coefficient: i === 0 ? 0.981 : 1.284,
    }));
    const x = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        leading_points: 62.5,
        leading_coefficient: 1.284,
        arrival_points: 55.4,
        arrival_position: 7,
      },
      classContext: ctx,
      params: { scoring: 'HG', useArrival: true },
    });
    expect(section(x, 'arrival').rank).toBe(
      '7th of 22 to the end of the speed section',
    );
    // Two pilots share 1.284, so the rank discloses the tie — and the
    // denominator names itself, because it is the whole measured field
    // rather than the goal/ESS count the neighbouring ranks use.
    expect(section(x, 'leading').rank).toBe(
      'Equal 2nd best of 3 measured leading coefficients',
    );
  });

  it('leaves ranks off when the inputs are not there to rank by', () => {
    // A landed-out PG pilot has no time rank; no leading/arrival published
    // means no ranks there either.
    const x = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: { ...makeGoalEntry(), made_goal: false, reached_ess: false },
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    expect(section(x, 'time').rank).toBeUndefined();
  });
});

describe('explainGapScore — the winner\'s headline note', () => {
  function winnerContext(): ClassContextInput {
    const ctx = makeClassContext();
    ctx.available_points = {
      distance: 380, time: 450, leading: 0, arrival: 70, total: 900,
    };
    ctx.pilots = [
      {
        flown_distance: 60_000, speed_section_time: 65 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Fast Pilot', rank: 2, total_score: 700,
        distance_points: 380, time_points: 450,
        leading_points: 0, arrival_points: 20,
      },
      {
        flown_distance: 60_000, speed_section_time: 70 * 60,
        made_goal: true, reached_ess: true,
        pilot_name: 'Our Pilot', rank: 1, total_score: 850,
        distance_points: 380, time_points: 400,
        leading_points: 0, arrival_points: 70,
      },
    ];
    return ctx;
  }

  function explainWinner(ctx: ClassContextInput, entry?: Partial<ScoreEntryInput>) {
    return explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: {
        ...makeGoalEntry(),
        distance_points: 380,
        time_points: 400,
        arrival_points: 70,
        total_score: 850,
        ...entry,
      },
      classContext: ctx,
      params: { scoring: 'HG', useArrival: true },
    });
  }

  it('answers "full validity, why not full points?" under the headline', () => {
    const x = explainWinner(winnerContext());
    expect(x.headlineNote).toBe(
      'Top of the class, but not a full sweep: of the 900 points on offer, ' +
        '50 went untaken — all of it time-points. The fastest pilot through the ' +
        'speed section was 5:00 quicker.',
    );
  });

  it('stays silent for a pilot who is not leading — the comparison section answers them', () => {
    const ctx = winnerContext();
    ctx.pilots[0] = { ...ctx.pilots[0], total_score: 880 };
    expect(explainWinner(ctx).headlineNote).toBeUndefined();
  });

  it('stays silent on a full sweep, and on payloads with no comparable pilots', () => {
    const swept = explainWinner(winnerContext(), {
      time_points: 450, arrival_points: 70, total_score: 900,
    });
    expect(swept.headlineNote).toBeUndefined();
    // Old cached payloads carry no per-pilot totals: no leader is knowable.
    const old = explainGapScore({
      task: makeTask(),
      result: makeReentryResult(),
      entry: makeGoalEntry(),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    expect(old.headlineNote).toBeUndefined();
  });
});
