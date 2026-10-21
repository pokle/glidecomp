/**
 * Elevated Goal and control-zone altitude limits — the two control-zone
 * features new in FAI S7F 2026 (issue #600).
 *
 *  - §6.2.3.2 / §9.2.3.2 / §13.1: an Elevated Goal validates at any altitude,
 *    is the end of the speed section, and a crossing below its elevation
 *    keeps GoalAltitudeFactor (0.8–1) of the pilot's time points.
 *  - §6.2.1 / §9.2.1: a cylinder's crossing counts only within its altitude
 *    limits ± 5 m.
 */
import { describe, it, expect } from 'bun:test';
import {
  goalAltitudeFactor,
  resolveElevatedGoal,
  effectiveAltitudeLimits,
  withinAltitudeLimits,
  MAX_GOAL_ELEVATION,
} from '../src/elevated-goal';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
import {
  scoreFlights,
  toFlightScoringData,
  defaultsFor,
  type FlightScoringData,
} from '../src/gap-scoring';
import {
  getEffectiveESSIndex,
  parseXCTask,
  toXctskJSON,
  type XCTask,
} from '../src/xctsk-parser';
import { destinationPoint } from '../src/geo';
import { explainGapScore } from '../src/score-explanation';
import { createFix, type IGCFix } from './test-helpers';

const ORIGIN = { lat: -36.0, lon: 147.0 };
const at = (northM: number) => destinationPoint(ORIGIN.lat, ORIGIN.lon, northM, 0);

const TP1 = at(10_000);
const GOAL = at(20_000);
const GOAL_ALT = 300;

/** SSS (exit, 1 km) → TP1 (400 m) → goal (400 m), due north. */
function task(opts: {
  finishAltitude?: number;
  tp1Limits?: { lower?: number; upper?: number };
  declaredEss?: boolean;
} = {}): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: [
      { type: 'SSS', radius: 1000, waypoint: { name: 'Start', ...ORIGIN, altSmoothed: 900 } },
      {
        ...(opts.declaredEss ? { type: 'ESS' as const } : {}),
        radius: 400,
        waypoint: { name: 'TP1', lat: TP1.lat, lon: TP1.lon, altSmoothed: 600 },
        ...(opts.tp1Limits ? { altitudeLimits: opts.tp1Limits } : {}),
      },
      { radius: 400, waypoint: { name: 'Goal', lat: GOAL.lat, lon: GOAL.lon, altSmoothed: GOAL_ALT } },
    ],
    sss: { type: 'ELAPSED-TIME', direction: 'EXIT' },
    goal: {
      type: 'CYLINDER',
      ...(opts.finishAltitude !== undefined ? { finishAltitude: opts.finishAltitude } : {}),
    },
  };
}

/** A straight glide north from the start centre to goal centre, 20 m/s,
 *  a fix every 10 s, with the altitude a function of distance flown. */
function glide(altAt: (northM: number) => number, startSeconds = 0): IGCFix[] {
  const fixes: IGCFix[] = [];
  for (let m = 0, t = startSeconds; m <= 20_200; m += 200, t += 10) {
    const p = at(m);
    fixes.push(createFix(t, p.lat, p.lon, altAt(m)));
  }
  return fixes;
}

describe('goalAltitudeFactor (§13.1)', () => {
  const eg = { goalAltitude: 300, elevation: 300 };
  it('is 0.8 at or below goal altitude and 1 at or above the elevation', () => {
    expect(goalAltitudeFactor(250, eg)).toBe(0.8);
    expect(goalAltitudeFactor(300, eg)).toBe(0.8);
    expect(goalAltitudeFactor(600, eg)).toBe(1);
    expect(goalAltitudeFactor(900, eg)).toBe(1);
  });

  it('follows the cubic between them — the spec figure', () => {
    // Figure 21: about 0.90 at 60 m, 0.94 at 105 m, 0.975 at 150 m, 0.99 at 195 m.
    expect(goalAltitudeFactor(360, eg)).toBeCloseTo(0.8976, 4);
    expect(goalAltitudeFactor(405, eg)).toBeCloseTo(0.945, 3);
    expect(goalAltitudeFactor(450, eg)).toBeCloseTo(0.975, 3);
    expect(goalAltitudeFactor(495, eg)).toBeCloseTo(0.99, 2);
  });
});

describe('resolveElevatedGoal', () => {
  it('needs a positive finishAltitude and a known goal altitude', () => {
    expect(resolveElevatedGoal(task())).toBeNull();
    expect(resolveElevatedGoal(task({ finishAltitude: 0 }))).toBeNull();
    expect(resolveElevatedGoal(task({ finishAltitude: 300 }))).toEqual({
      goalAltitude: GOAL_ALT,
      elevation: 300,
    });
    const noAlt = task({ finishAltitude: 300 });
    delete noAlt.turnpoints[2].waypoint.altSmoothed;
    expect(resolveElevatedGoal(noAlt)).toBeNull();
    // A known goal altitude of 0 — a beach — is a real altitude.
    const beach = task({ finishAltitude: 300 });
    beach.turnpoints[2].waypoint.altSmoothed = 0;
    expect(resolveElevatedGoal(beach)?.goalAltitude).toBe(0);
  });

  it('caps the elevation at 1000 m and says what was declared', () => {
    expect(resolveElevatedGoal(task({ finishAltitude: 1500 }))).toEqual({
      goalAltitude: GOAL_ALT,
      elevation: MAX_GOAL_ELEVATION,
      declaredElevation: 1500,
    });
  });

  it('is the end of the speed section, over a declared ESS (§6.2.3.2)', () => {
    expect(getEffectiveESSIndex(task({ declaredEss: true }))).toBe(1);
    expect(getEffectiveESSIndex(task({ declaredEss: true, finishAltitude: 300 }))).toBe(2);
  });
});

describe('altitude limits (§6.2.1, §9.2.1)', () => {
  it('reads limits with the spec defaults, never on goal', () => {
    expect(effectiveAltitudeLimits(task(), 1)).toBeNull();
    expect(effectiveAltitudeLimits(task({ tp1Limits: { upper: 2000 } }), 1)).toEqual({
      lower: 0, upper: 2000,
    });
    expect(effectiveAltitudeLimits(task({ tp1Limits: { lower: 800 } }), 1)).toEqual({
      lower: 800, upper: Infinity,
    });
    const goalLimited = task();
    goalLimited.turnpoints[2].altitudeLimits = { upper: 100 };
    expect(effectiveAltitudeLimits(goalLimited, 2)).toBeNull();
  });

  it('applies the 5 m absolute tolerance', () => {
    const l = { lower: 1000, upper: 2000 };
    expect(withinAltitudeLimits(995, l)).toBe(true);
    expect(withinAltitudeLimits(994.9, l)).toBe(false);
    expect(withinAltitudeLimits(2005, l)).toBe(true);
    expect(withinAltitudeLimits(2005.1, l)).toBe(false);
  });

  it('a crossing above the upper limit does not reach the turnpoint', () => {
    const fixes = glide(() => 2500);
    const limited = resolveTurnpointSequence(task({ tp1Limits: { upper: 2000 } }), fixes);
    expect(limited.madeGoal).toBe(false);
    expect(limited.lastTurnpointReached).toBe(0);
    expect(limited.crossings.some((c) => c.taskIndex === 1 && c.altitudeRejected)).toBe(true);

    const open = resolveTurnpointSequence(task(), fixes);
    expect(open.madeGoal).toBe(true);
  });

  it('a crossing within the limits reaches it as usual', () => {
    const r = resolveTurnpointSequence(task({ tp1Limits: { lower: 1000, upper: 2000 } }), glide(() => 1500));
    expect(r.madeGoal).toBe(true);
    expect(r.crossings.some((c) => c.altitudeRejected)).toBe(false);
  });

  it('a start crossing outside the start limits is no start', () => {
    const t = task();
    t.turnpoints[0].altitudeLimits = { upper: 1000 };
    const r = resolveTurnpointSequence(t, glide(() => 1500));
    expect(r.sssReaching).toBeNull();
    expect(r.madeGoal).toBe(false);
  });

  it('round-trips through the .xctsk JSON', () => {
    const t = task({ tp1Limits: { lower: 800, upper: 2400 } });
    const back = parseXCTask(JSON.stringify(toXctskJSON(t)));
    expect(back.turnpoints[1].altitudeLimits).toEqual({ lower: 800, upper: 2400 });
    expect(back.turnpoints[0].altitudeLimits).toBeUndefined();
  });

  it('a stored blob with junk limits degrades to none', () => {
    const raw = toXctskJSON(task()) as { turnpoints: Array<Record<string, unknown>> };
    raw.turnpoints[1].altitudeLimits = { lower: 'high', upper: null };
    expect(parseXCTask(JSON.stringify(raw)).turnpoints[1].altitudeLimits).toBeUndefined();
  });
});

describe('altitude limits — review cases', () => {
  it('a fallback start (no SSS) outside the start limits starts nothing', () => {
    const t = task();
    delete t.turnpoints[0].type;
    t.turnpoints[0].altitudeLimits = { upper: 1000 };
    // Begins OUTSIDE the first cylinder, so the start would fall back to the
    // first fix — at 1500 m, above the limit.
    const fixes = glide(() => 1500).slice(6);
    const r = resolveTurnpointSequence(t, fixes);
    expect(r.sssReaching).toBeNull();
    expect(r.madeGoal).toBe(false);
  });

  it('already inside a cylinder, but at the wrong altitude, is not reached', () => {
    // TP1 is a 12 km cylinder that contains the start, so presence-based
    // reaching would credit it at the start — but the start is at 1500 m
    // and TP1 only counts below 1000 m.
    const t = task({ tp1Limits: { upper: 1000 } });
    t.turnpoints[1].radius = 12_000;
    const r = resolveTurnpointSequence(t, glide(() => 1500));
    expect(r.lastTurnpointReached).toBe(0);
    expect(r.madeGoal).toBe(false);
  });

  it('the report card names only the turnpoint that stopped the sequence', () => {
    const t = task({ tp1Limits: { upper: 2000 } });
    const fixes = glide(() => 2500);
    const r = resolveTurnpointSequence(t, fixes);
    const flight = explainGapScore({
      task: t,
      result: r,
      entry: {
        pilot_name: 'p', rank: 1, made_goal: false, reached_ess: false,
        flown_distance: r.flownDistance, speed_section_time: null,
        distance_points: 100, distance_linear_points: 100, distance_difficulty_points: 0,
        time_points: 0, leading_points: 0, arrival_points: 0,
        penalty_points: 0, penalty_reason: null, total_score: 100,
      },
      classContext: {
        available_points: { distance: 500, time: 300, leading: 100, arrival: 0, total: 900 },
        task_validity: { launch: 1, distance: 1, time: 1, task: 1 },
        pilots: [],
      },
      params: { ...defaultsFor('hg') },
    } as Parameters<typeof explainGapScore>[0]).sections.find((s) => s.id === 'flight')!;
    const items = flight.items.filter((i) => i.id.startsWith('altitude-rejected-'));
    expect(items.map((i) => i.id)).toEqual(['altitude-rejected-1']);
    expect(items[0].text).toContain('below 2,000 m');
  });
});

describe('Elevated Goal scoring (§9.2.3.2, §13.1)', () => {
  const eg = task({ finishAltitude: 300 });
  /** Cross the goal cylinder's edge (400 m short of its centre) `aboveGoal`
   *  metres above the goal waypoint, descending at 1:10. */
  const arriving = (aboveGoal: number, startSeconds = 0) =>
    glide((m) => GOAL_ALT + aboveGoal + (19_600 - m) * 0.1, startSeconds);

  it('validates goal at any altitude, and records the factor', () => {
    const low = resolveTurnpointSequence(eg, arriving(60));
    expect(low.madeGoal).toBe(true);
    expect(low.elevatedGoal?.crossingAltitude).toBeCloseTo(GOAL_ALT + 60, 0);
    expect(low.elevatedGoal?.goalAltitudeFactor).toBeLessThan(1);
    expect(low.elevatedGoal?.goalAltitudeFactor).toBeGreaterThan(0.8);

    const high = resolveTurnpointSequence(eg, arriving(400));
    expect(high.madeGoal).toBe(true);
    expect(high.elevatedGoal?.goalAltitudeFactor).toBe(1);

    const ground = resolveTurnpointSequence(task(), arriving(60));
    expect(ground.elevatedGoal).toBeUndefined();
  });

  it('multiplies time points only, and publishes the factor', () => {
    const pilots = [
      { name: 'high', fixes: arriving(400) },
      { name: 'low', fixes: arriving(0) },
      { name: 'late', fixes: arriving(400, 120) },
    ];
    const flights: FlightScoringData[] = pilots.map((p) =>
      toFlightScoringData(
        { pilotName: p.name, trackFile: `${p.name}.igc`, fixes: p.fixes },
        resolveTurnpointSequence(eg, p.fixes),
        false,
      ),
    );
    // The same three flights under a ground goal, as the control.
    const ground = pilots.map((p) =>
      toFlightScoringData(
        { pilotName: p.name, trackFile: `${p.name}.igc`, fixes: p.fixes },
        resolveTurnpointSequence(task(), p.fixes),
        false,
      ),
    );
    const params = { ...defaultsFor('hg'), useLeading: false, nominalDistance: 20_000 };
    const r = scoreFlights(eg, flights, params);
    const g = scoreFlights(task(), ground, params);
    const by = (res: typeof r, name: string) => res.pilotScores.find((p) => p.pilotName === name)!;

    const low = by(r, 'low');
    expect(low.goalAltitudeFactor).toBeCloseTo(0.8, 6);
    expect(low.timePointsBeforeGoalAltitude).toBeCloseTo(by(g, 'low').timePoints, 1);
    expect(low.timePoints).toBeCloseTo(by(g, 'low').timePoints * 0.8, 0);
    expect(low.distancePoints).toBe(by(g, 'low').distancePoints);
    expect(low.arrivalPoints).toBe(by(g, 'low').arrivalPoints);

    const high = by(r, 'high');
    expect(high.goalAltitudeFactor).toBeUndefined();
    expect(high.timePoints).toBe(by(g, 'high').timePoints);
  });

  it('the report card prints the factor and its arithmetic', () => {
    const fixes = arriving(60);
    const others = [arriving(400), arriving(400, 60)];
    const all = [fixes, ...others];
    const results = all.map((f) => resolveTurnpointSequence(eg, f));
    const flights = all.map((f, i) =>
      toFlightScoringData({ pilotName: `p${i}`, trackFile: `p${i}.igc`, fixes: f }, results[i], false),
    );
    const params = { ...defaultsFor('hg'), useLeading: false, nominalDistance: 20_000 };
    const scored = scoreFlights(eg, flights, params);
    const me = scored.pilotScores.find((p) => p.pilotName === 'p0')!;
    const entry = {
      pilot_name: 'p0',
      rank: me.rank,
      made_goal: me.madeGoal,
      reached_ess: me.reachedESS,
      flown_distance: me.flownDistance,
      speed_section_time: me.speedSectionTime,
      distance_points: me.distancePoints,
      distance_linear_points: me.distanceLinearPoints,
      distance_difficulty_points: me.distanceDifficultyPoints,
      time_points: me.timePoints,
      leading_points: me.leadingPoints,
      arrival_points: me.arrivalPoints,
      penalty_points: 0,
      penalty_reason: null,
      total_score: me.totalScore,
      goal_altitude_factor: me.goalAltitudeFactor ?? null,
      time_points_before_goal_altitude: me.timePointsBeforeGoalAltitude ?? null,
    };
    const explanation = explainGapScore({
      task: eg,
      result: results[0],
      entry,
      classContext: {
        available_points: { ...scored.availablePoints },
        task_validity: scored.taskValidity,
        pilots: scored.pilotScores.map((p) => ({
          pilot_name: p.pilotName,
          rank: p.rank,
          made_goal: p.madeGoal,
          reached_ess: p.reachedESS,
          flown_distance: p.flownDistance,
          speed_section_time: p.speedSectionTime,
          time_points: p.timePoints,
          total_score: p.totalScore,
        })),
      },
      params,
    } as Parameters<typeof explainGapScore>[0]);
    const time = explanation.sections.find((s) => s.id === 'time')!;
    const item = time.items.find((i) => i.id === 'elevated-goal')!;
    expect(item.text).toContain('§13.1');
    expect(item.detail).toContain('AR = ');
    expect(item.detail).toContain('0.8 + 0.6·AR');
    const formula = time.items.find((i) => i.id === 'time-formula')!;
    expect(formula.detail).toContain('(elevated goal, §13.1)');
    expect(formula.detail).not.toContain('≈');
  });
});

describe('Elevated Goal on the report card — degrading', () => {
  const eg = task({ finishAltitude: 300 });
  const arrivingLow = glide((m) => GOAL_ALT + 60 + (19_600 - m) * 0.1);
  function timeSection(t: XCTask, publishedFactor: number | null) {
    const r = resolveTurnpointSequence(t, arrivingLow);
    return explainGapScore({
      task: t,
      result: r,
      entry: {
        pilot_name: 'p', rank: 1, made_goal: true, reached_ess: true,
        flown_distance: r.flownDistance, speed_section_time: r.speedSectionTime,
        distance_points: 400, distance_linear_points: 400, distance_difficulty_points: 0,
        time_points: publishedFactor === null ? 300 : 300 * publishedFactor,
        leading_points: 0, arrival_points: 0, penalty_points: 0, penalty_reason: null,
        total_score: 700, goal_altitude_factor: publishedFactor,
      },
      classContext: {
        available_points: { distance: 400, time: 300, leading: 0, arrival: 0, total: 700 },
        task_validity: { launch: 1, distance: 1, time: 1, task: 1 },
        pilots: [{
          pilot_name: 'p', rank: 1, made_goal: true, reached_ess: true,
          flown_distance: r.flownDistance, speed_section_time: r.speedSectionTime,
          time_points: 300, total_score: 700,
        }],
      },
      params: { ...defaultsFor('hg'), useLeading: false },
    } as Parameters<typeof explainGapScore>[0]).sections.find((s) => s.id === 'time')!;
  }

  it('an old payload without the factor is not told it kept full points', () => {
    const item = timeSection(eg, null).items.find((i) => i.id === 'elevated-goal')!;
    expect(item.text).toContain('computed before this was applied');
    expect(item.text).not.toContain('keeps full time points');
  });

  it('names the 1000 m cap when the task asked for more', () => {
    const high = task({ finishAltitude: 1500 });
    const r = resolveTurnpointSequence(high, arrivingLow);
    const item = timeSection(high, r.elevatedGoal!.goalAltitudeFactor!).items.find(
      (i) => i.id === 'elevated-goal',
    )!;
    expect(item.text).toContain('the task sets 1,500 m');
    expect(item.text).toContain('at most 1,000 m');
  });
});
