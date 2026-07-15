/**
 * Task deadline + launch window enforcement (issue #260).
 *
 * FAI S7F §8.3.c: a valid crossing must be recorded no later than the task
 * deadline. §8.6.1: turnpoints reached count only within the timing
 * restrictions (launch window, valid start, deadline). §11.1: a landed-out
 * pilot's best distance is measured up until landing or the deadline,
 * whichever comes first.
 */
import { describe, it, expect } from 'bun:test';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
import { resolveTaskDeadline, resolveLaunchWindowOpen } from '../src/time-gates';
import { explainGapScore, type ScoreEntryInput, type ClassContextInput } from '../src/score-explanation';
import type { XCTask } from '../src/xctsk-parser';
import { createFix, BASE_TIME, type IGCFix } from './test-helpers';

// ---------------------------------------------------------------------------
// Fixtures — a straight-north task along lon 8.0. BASE_TIME is 10:00:00 UTC.
// ---------------------------------------------------------------------------

/** SSS (EXIT) at 47.00, TP1 at 47.05, ESS+goal at 47.10 — all 400 m cylinders. */
function makeTask(overrides?: {
  timeGates?: string[];
  deadline?: string;
  timeOpen?: string;
}): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: [
      { type: 'SSS', radius: 400, waypoint: { name: 'START', lat: 47.0, lon: 8.0 } },
      { radius: 400, waypoint: { name: 'TP1', lat: 47.05, lon: 8.0 } },
      { type: 'ESS', radius: 400, waypoint: { name: 'GOAL', lat: 47.1, lon: 8.0 } },
    ],
    sss: {
      type: 'RACE',
      direction: 'EXIT',
      ...(overrides?.timeGates ? { timeGates: overrides.timeGates } : {}),
    },
    goal: {
      type: 'CYLINDER',
      ...(overrides?.deadline ? { deadline: overrides.deadline } : {}),
    },
    ...(overrides?.timeOpen ? { takeoff: { timeOpen: overrides.timeOpen } } : {}),
  };
}

/**
 * A track flying due north from 46.995 to 47.105 at 0.005°/min (~556 m/min),
 * one fix per minute starting at BASE_TIME (10:00 UTC). It exits the SSS
 * around minute ~1.7, enters TP1 around minute ~10.3, and enters goal around
 * minute ~20.3.
 */
function makeTrack(): IGCFix[] {
  const fixes: IGCFix[] = [];
  for (let min = 0; min <= 22; min++) {
    fixes.push(createFix(min * 60, 46.995 + min * 0.005, 8.0));
  }
  return fixes;
}

/** "HH:MM:SSZ" for N minutes after BASE_TIME (10:00 UTC). */
function timeOfDay(minutesAfterBase: number): string {
  return `${new Date(BASE_TIME.getTime() + minutesAfterBase * 60_000)
    .toISOString()
    .slice(11, 19)}Z`;
}

function msAfterBase(minutes: number): number {
  return BASE_TIME.getTime() + minutes * 60_000;
}

// ---------------------------------------------------------------------------
// Deadline resolution helpers
// ---------------------------------------------------------------------------

describe('resolveTaskDeadline / resolveLaunchWindowOpen', () => {
  it('resolves the deadline time-of-day onto the flight day', () => {
    const task = makeTask({ deadline: '10:15:00Z' });
    expect(resolveTaskDeadline(task, msAfterBase(20))).toBe(msAfterBase(15));
  });

  it('returns null for a missing or unparseable deadline', () => {
    expect(resolveTaskDeadline(makeTask(), msAfterBase(0))).toBeNull();
    expect(resolveTaskDeadline(makeTask({ deadline: 'banana' }), msAfterBase(0))).toBeNull();
  });

  it('resolves the launch-window open time', () => {
    const task = makeTask({ timeOpen: '09:00:00Z' });
    expect(resolveLaunchWindowOpen(task, msAfterBase(0))).toBe(msAfterBase(-60));
    expect(resolveLaunchWindowOpen(makeTask(), msAfterBase(0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deadline enforcement in sequence resolution
// ---------------------------------------------------------------------------

describe('task deadline enforcement (S7F §8.3.c, §11.1)', () => {
  it('without a deadline the goal crossing counts and no deadline info is reported', () => {
    const result = resolveTurnpointSequence(makeTask(), makeTrack());
    expect(result.madeGoal).toBe(true);
    expect(result.deadline).toBeUndefined();
  });

  it('a goal crossing after the deadline does not count, and distance is clipped at the deadline', () => {
    // Deadline at 10:15 — after TP1 (~10:10.3) but before goal (~10:20.3).
    const result = resolveTurnpointSequence(
      makeTask({ deadline: timeOfDay(15) }),
      makeTrack(),
    );

    expect(result.madeGoal).toBe(false);
    expect(result.lastTurnpointReached).toBe(1);

    // The deadline is reported for the explanation…
    expect(result.deadline).toBeDefined();
    expect(result.deadline!.time.getTime()).toBe(msAfterBase(15));
    expect(result.deadline!.crossingsAfter).toBeGreaterThanOrEqual(1);
    expect(result.deadline!.trackContinuesPastDeadline).toBe(true);

    // …and the ignored goal crossing stays in the raw crossing list.
    const postDeadlineGoal = result.crossings.filter(
      (c) => c.taskIndex === 2 && c.time.getTime() > msAfterBase(15),
    );
    expect(postDeadlineGoal.length).toBeGreaterThanOrEqual(1);

    // Best progress is measured only up to the deadline (§11.1): the best
    // fix is exactly the minute-15 fix, not anything flown later.
    expect(result.bestProgress).not.toBeNull();
    expect(result.bestProgress!.time.getTime()).toBeLessThanOrEqual(msAfterBase(15));
    expect(result.bestProgress!.latitude).toBeCloseTo(46.995 + 15 * 0.005, 6);
    expect(result.flownDistance).toBeGreaterThan(0);
    expect(result.flownDistance).toBeLessThan(result.taskDistance);
  });

  it('a later deadline credits more distance than an earlier one', () => {
    const early = resolveTurnpointSequence(
      makeTask({ deadline: timeOfDay(12) }),
      makeTrack(),
    );
    const late = resolveTurnpointSequence(
      makeTask({ deadline: timeOfDay(18) }),
      makeTrack(),
    );
    expect(late.flownDistance).toBeGreaterThan(early.flownDistance);
  });

  it('a deadline after the whole flight changes nothing but is still reported', () => {
    const result = resolveTurnpointSequence(
      makeTask({ deadline: timeOfDay(60) }),
      makeTrack(),
    );
    expect(result.madeGoal).toBe(true);
    expect(result.deadline).toBeDefined();
    expect(result.deadline!.crossingsAfter).toBe(0);
    expect(result.deadline!.trackContinuesPastDeadline).toBe(false);
  });

  it('a deadline at/before the first start gate is a mis-set task and is ignored', () => {
    const result = resolveTurnpointSequence(
      makeTask({ timeGates: ['10:30:00Z'], deadline: '10:10:00Z' }),
      makeTrack(),
    );
    expect(result.deadline).toBeUndefined();
    // The flight still resolves (as an early start against the 10:30 gate).
    expect(result.madeGoal).toBe(true);
    expect(result.earlyStart).toBeDefined();
  });

  it('the goal ratio input (madeGoal) reflects the deadline clip', () => {
    // Same flight, two tasks: with the tight deadline the pilot no longer
    // counts as a goal pilot — §10's "reached goal before the task deadline".
    const inTime = resolveTurnpointSequence(makeTask(), makeTrack());
    const tooLate = resolveTurnpointSequence(
      makeTask({ deadline: timeOfDay(15) }),
      makeTrack(),
    );
    expect(inTime.madeGoal).toBe(true);
    expect(tooLate.madeGoal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Launch window (S7F §8.6.1)
// ---------------------------------------------------------------------------

describe('launch window enforcement (S7F §8.6.1)', () => {
  it('start crossings before the window opens cannot validate a start', () => {
    // Window opens 10:30; the only start exit is ~10:01.7 — provably airborne
    // before launching was allowed.
    const result = resolveTurnpointSequence(
      makeTask({ timeOpen: '10:30:00Z' }),
      makeTrack(),
    );
    expect(result.sssReaching).toBeNull();
    expect(result.madeGoal).toBe(false);
    expect(result.flownDistance).toBe(0);
    expect(result.launchWindow).toBeDefined();
    expect(result.launchWindow!.openTime.getTime()).toBe(msAfterBase(30));
    expect(result.launchWindow!.droppedStartCrossings).toBeGreaterThanOrEqual(1);
  });

  it('a window that opened before the flight drops nothing', () => {
    const result = resolveTurnpointSequence(
      makeTask({ timeOpen: '09:00:00Z' }),
      makeTrack(),
    );
    expect(result.madeGoal).toBe(true);
    expect(result.launchWindow).toBeDefined();
    expect(result.launchWindow!.droppedStartCrossings).toBe(0);
  });

  it('a window open after the first start gate is a mis-set task and is ignored', () => {
    const result = resolveTurnpointSequence(
      makeTask({ timeGates: ['10:20:00Z'], timeOpen: '10:40:00Z' }),
      makeTrack(),
    );
    expect(result.launchWindow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Score explanation
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ScoreEntryInput>): ScoreEntryInput {
  return {
    made_goal: false,
    reached_ess: false,
    flown_distance: 8_000,
    speed_section_time: null,
    distance_points: 100,
    distance_linear_points: 100,
    distance_difficulty_points: 0,
    time_points: 0,
    leading_points: 0,
    arrival_points: 0,
    penalty_points: 0,
    penalty_reason: null,
    total_score: 100,
    ...overrides,
  };
}

function makeClassContext(): ClassContextInput {
  return {
    task_validity: { launch: 1, distance: 0.9, time: 1, task: 0.9 },
    available_points: { distance: 400, time: 500, leading: 0, arrival: 0, total: 900 },
    pilots: [
      { flown_distance: 11_000, speed_section_time: null, made_goal: false, reached_ess: false },
      { flown_distance: 8_000, speed_section_time: null, made_goal: false, reached_ess: false },
    ],
  };
}

describe('score explanation — deadline and launch window', () => {
  it('narrates the deadline cutoff and lists the ignored goal crossing', () => {
    const task = makeTask({ deadline: timeOfDay(15) });
    const result = resolveTurnpointSequence(task, makeTrack());
    const explanation = explainGapScore({
      task,
      result,
      entry: makeEntry({ flown_distance: result.flownDistance }),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });

    const flight = explanation.sections.find((s) => s.id === 'flight')!;
    const deadlineItem = flight.items.find((i) => i.id === 'task-deadline');
    expect(deadlineItem).toBeDefined();
    expect(deadlineItem!.emphasis).toBe('warning');
    expect(deadlineItem!.text).toContain('do not count');
    expect(deadlineItem!.value).toContain('10:15:00');

    // The too-late goal entry is called out, anchored to where it happened.
    const ignored = flight.items.filter((i) => i.id.startsWith('deadline-ignored-'));
    expect(ignored.length).toBeGreaterThanOrEqual(1);
    const goalIgnored = ignored.find((i) => i.text.includes('Goal'));
    expect(goalIgnored).toBeDefined();
    expect(goalIgnored!.text).toContain('not counted');
    expect(goalIgnored!.emphasis).toBe('warning');
    expect(goalIgnored!.anchor).toBeDefined();

    // The deadline note comes after the scored reachings, before landed-out.
    const ids = flight.items.map((i) => i.id);
    expect(ids.indexOf('task-deadline')).toBeGreaterThan(ids.indexOf('reaching-1'));
    expect(ids.indexOf('task-deadline')).toBeLessThan(ids.indexOf('best-progress'));
  });

  it('does not mention the deadline when it never shaped the flight', () => {
    const task = makeTask({ deadline: timeOfDay(60) });
    const result = resolveTurnpointSequence(task, makeTrack());
    const explanation = explainGapScore({
      task,
      result,
      entry: makeEntry({
        made_goal: true,
        reached_ess: true,
        flown_distance: result.flownDistance,
        speed_section_time: result.speedSectionTime,
      }),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    const flight = explanation.sections.find((s) => s.id === 'flight')!;
    expect(flight.items.find((i) => i.id === 'task-deadline')).toBeUndefined();
  });

  it('explains a start voided by the launch window', () => {
    const task = makeTask({ timeOpen: '10:30:00Z' });
    const result = resolveTurnpointSequence(task, makeTrack());
    const explanation = explainGapScore({
      task,
      result,
      entry: makeEntry({ flown_distance: 0, total_score: 0, distance_points: 0, distance_linear_points: 0 }),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });
    const flight = explanation.sections.find((s) => s.id === 'flight')!;
    const windowItem = flight.items.find((i) => i.id === 'launch-window');
    expect(windowItem).toBeDefined();
    expect(windowItem!.emphasis).toBe('warning');
    expect(windowItem!.text).toContain('launch window');
    // The generic no-start item still follows, so the two read together.
    expect(flight.items.find((i) => i.id === 'no-start')).toBeDefined();
  });
});
