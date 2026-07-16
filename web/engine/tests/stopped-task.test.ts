/**
 * Stopped tasks (issue #264, FAI S7F §12.3).
 *
 * §12.3.1 stop time (PG score-back / HG gate interval), §12.3.2 minimum run,
 * §12.3.3 stopped-task validity, §12.3.4 scored time window, §12.3.5
 * complete flight at/after ESS + goal time-points reduction, §12.3.6
 * altitude bonus.
 */
import { describe, it, expect } from 'bun:test';
import { resolveTurnpointSequence, reviveTurnpointSequenceResult } from '../src/turnpoint-sequence';
import type { TurnpointSequenceResultJSON } from '../src/turnpoint-sequence';
import {
  scoreTask,
  resolveTaskStop,
  resolveScoredWindowEnds,
  stoppedGlideRatio,
  stoppedMinimumRunSeconds,
  resolveGoalAltitude,
  calculateStoppedTaskValidity,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type PilotFlight,
} from '../src/gap-scoring';
import { explainGapScore, type ScoreEntryInput, type ClassContextInput } from '../src/score-explanation';
import type { XCTask } from '../src/xctsk-parser';
import { createFix, BASE_TIME, type IGCFix } from './test-helpers';

// ---------------------------------------------------------------------------
// Fixtures — a straight-north task along lon 8.0. BASE_TIME is 10:00:00 UTC.
// All waypoints at 1000 m so the default-altitude tracks earn no altitude
// bonus unless a test sets altitudes explicitly.
// ---------------------------------------------------------------------------

/** SSS (EXIT) at 47.00, ESS at 47.05, goal at 47.10 — 400 m cylinders. */
function makeTask(overrides?: { timeGates?: string[]; essAtGoal?: boolean }): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: [
      { type: 'SSS', radius: 400, waypoint: { name: 'START', lat: 47.0, lon: 8.0, altSmoothed: 1000 } },
      {
        ...(overrides?.essAtGoal ? {} : { type: 'ESS' as const }),
        radius: 400,
        waypoint: { name: 'TP1', lat: 47.05, lon: 8.0, altSmoothed: 1000 },
      },
      {
        ...(overrides?.essAtGoal ? { type: 'ESS' as const } : {}),
        radius: 400,
        waypoint: { name: 'GOAL', lat: 47.1, lon: 8.0, altSmoothed: 1000 },
      },
    ],
    sss: {
      type: 'RACE',
      direction: 'EXIT',
      timeGates: overrides?.timeGates ?? ['10:00:00Z'],
    },
    goal: { type: 'CYLINDER' },
  };
}

/**
 * A track flying due north from 46.995 at `degPerMin`, one fix per minute.
 * At 0.005°/min it exits the SSS ~min 1.7, enters the 47.05 cylinder
 * ~min 10.3 and the goal cylinder ~min 20.3.
 */
function makeTrack(opts?: {
  degPerMin?: number;
  minutes?: number;
  startMin?: number;
  altitude?: number;
}): IGCFix[] {
  const degPerMin = opts?.degPerMin ?? 0.005;
  const minutes = opts?.minutes ?? 22;
  const startMin = opts?.startMin ?? 0;
  const fixes: IGCFix[] = [];
  for (let min = 0; min <= minutes; min++) {
    fixes.push(createFix(
      (startMin + min) * 60,
      46.995 + min * degPerMin,
      8.0,
      opts?.altitude ?? 1000,
    ));
  }
  return fixes;
}

function msAfterBase(minutes: number): number {
  return BASE_TIME.getTime() + minutes * 60_000;
}

function pgParams(overrides?: Partial<GAPParameters>): Partial<GAPParameters> {
  return { scoring: 'PG', ...overrides };
}

const PG_FULL: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, scoring: 'PG' };
const HG_FULL: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, scoring: 'HG' };

// ---------------------------------------------------------------------------
// §12.3.1 — stop time resolution
// ---------------------------------------------------------------------------

describe('resolveTaskStop (§12.3.1)', () => {
  it('PG: stop time is the announcement minus the competition score-back time', () => {
    const stop = resolveTaskStop(makeTask(), msAfterBase(50), PG_FULL);
    expect(stop.scoreBackKind).toBe('pg_score_back');
    expect(stop.scoreBackSeconds).toBe(300); // default 5 minutes
    expect(stop.stopTimeMs).toBe(msAfterBase(45));
  });

  it('PG: a custom scoreBackTime is honoured', () => {
    const stop = resolveTaskStop(
      makeTask(), msAfterBase(50), { ...PG_FULL, scoreBackTime: 600 },
    );
    expect(stop.scoreBackSeconds).toBe(600);
    expect(stop.stopTimeMs).toBe(msAfterBase(40));
  });

  it('HG: one start-gate interval with multiple gates', () => {
    const stop = resolveTaskStop(
      makeTask({ timeGates: ['10:00:00Z', '10:20:00Z', '10:40:00Z'] }),
      msAfterBase(50),
      HG_FULL,
    );
    expect(stop.scoreBackKind).toBe('hg_gate_interval');
    expect(stop.scoreBackSeconds).toBe(20 * 60);
    expect(stop.stopTimeMs).toBe(msAfterBase(30));
  });

  it('HG: 15 minutes with a single gate (and without usable gates)', () => {
    const single = resolveTaskStop(makeTask(), msAfterBase(50), HG_FULL);
    expect(single.scoreBackKind).toBe('hg_single_gate');
    expect(single.scoreBackSeconds).toBe(15 * 60);
    expect(single.stopTimeMs).toBe(msAfterBase(35));

    const gateless = resolveTaskStop(
      makeTask({ timeGates: ['00:00:00Z'] }), // placeholder → no gates
      msAfterBase(50),
      HG_FULL,
    );
    expect(gateless.scoreBackKind).toBe('hg_single_gate');
    expect(gateless.scoreBackSeconds).toBe(15 * 60);
  });
});

describe('stoppedMinimumRunSeconds (§12.3.2)', () => {
  it('is min(1 hour, nominalTime / 2)', () => {
    expect(stoppedMinimumRunSeconds(5400)).toBe(2700);
    expect(stoppedMinimumRunSeconds(10000)).toBe(3600);
    expect(stoppedMinimumRunSeconds(1200)).toBe(600);
  });
});

describe('stoppedGlideRatio / resolveGoalAltitude (§12.3.6)', () => {
  it('uses the spec glide ratios and the goal waypoint altitude', () => {
    expect(stoppedGlideRatio('HG')).toBe(5.0);
    expect(stoppedGlideRatio('PG')).toBe(4.0);
    expect(resolveGoalAltitude(makeTask())).toBe(1000);
    const bare = makeTask();
    delete bare.turnpoints[2].waypoint.altSmoothed;
    expect(resolveGoalAltitude(bare)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §12.3.3 — stopped-task validity formula
// ---------------------------------------------------------------------------

describe('calculateStoppedTaskValidity (§12.3.3)', () => {
  it('is 1 when anyone reached ESS', () => {
    expect(calculateStoppedTaskValidity({
      pilotDistances: [10_000, 20_000],
      numReachedESS: 1,
      numLandedBeforeStop: 2,
      launchToEssDistance: 100_000,
    })).toBe(1);
  });

  it('is 0 when nobody launched', () => {
    expect(calculateStoppedTaskValidity({
      pilotDistances: [],
      numReachedESS: 0,
      numLandedBeforeStop: 0,
      launchToEssDistance: 100_000,
    })).toBe(0);
  });

  it('matches the spec formula on a hand-computed field', () => {
    // Distances 10/20/30/40 km, launch→ESS 100 km, 2 of 4 landed:
    //   best 40, avg 25, sample stdev √(500/3) ≈ 12.9099
    //   spread = √((15 / 61) × √(12.9099 / 5)) ≈ 0.62859
    //   landed³ = (2/4)³ = 0.125 → validity ≈ 0.75359
    const v = calculateStoppedTaskValidity({
      pilotDistances: [10_000, 20_000, 30_000, 40_000],
      numReachedESS: 0,
      numLandedBeforeStop: 2,
      launchToEssDistance: 100_000,
    });
    expect(v).toBeCloseTo(0.75359, 4);
  });

  it('is 1 when everyone landed before the stop (the field was done)', () => {
    // Equal distances → spread 0; everyone landed → (1)³ = 1.
    expect(calculateStoppedTaskValidity({
      pilotDistances: [15_000, 15_000, 15_000],
      numReachedESS: 0,
      numLandedBeforeStop: 3,
      launchToEssDistance: 100_000,
    })).toBe(1);
  });

  it('clamps at 1 and survives a best distance beyond the ESS buffer', () => {
    const v = calculateStoppedTaskValidity({
      pilotDistances: [99_500, 5_000, 101_000],
      numReachedESS: 0,
      numLandedBeforeStop: 3,
      launchToEssDistance: 100_000,
    });
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(Number.isFinite(v)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §12.3.4 / §12.3.5 / §12.3.6 — sequence resolution under a stop
// ---------------------------------------------------------------------------

describe('resolveTurnpointSequence with a stop (§12.3.4–§12.3.6)', () => {
  const stopBase = { glideRatio: 4, goalAltitude: 1000 };

  it('clips the scored flight at the window end', () => {
    // ESS co-located with goal (~min 20.3); stop at min 15 → the pilot was
    // NOT past ESS at the stop, so the flight is clipped.
    const result = resolveTurnpointSequence(makeTask({ essAtGoal: true }), makeTrack(), {
      stop: { ...stopBase, stopTimeMs: msAfterBase(15) },
    });
    expect(result.madeGoal).toBe(false);
    expect(result.lastTurnpointReached).toBe(1);
    expect(result.bestProgress!.time.getTime()).toBeLessThanOrEqual(msAfterBase(15));
    expect(result.flownDistance).toBeLessThan(result.taskDistance);

    expect(result.stopInfo).toBeDefined();
    expect(result.stopInfo!.stopTime.getTime()).toBe(msAfterBase(15));
    expect(result.stopInfo!.windowEnd.getTime()).toBe(msAfterBase(15));
    expect(result.stopInfo!.essBeforeStop).toBe(false);
    expect(result.stopInfo!.flyingAtStop).toBe(true);
    expect(result.stopInfo!.crossingsAfterStop).toBeGreaterThanOrEqual(1);
    expect(result.stopInfo!.altitudeBonus).toBe(0); // flying at goal altitude
    // The ignored goal crossing stays in the raw list for transparency.
    const lateGoal = result.crossings.filter(
      c => c.taskIndex === 2 && c.time.getTime() > msAfterBase(15),
    );
    expect(lateGoal.length).toBeGreaterThanOrEqual(1);
  });

  it('§12.3.5: a pilot past ESS at the stop is scored for the complete flight', () => {
    // ESS (47.05) reached ~min 10.3; stop at 15; goal reached ~20.3 — after
    // the stop, but the complete flight counts.
    const r = resolveTurnpointSequence(makeTask(), makeTrack(), {
      stop: { ...stopBase, stopTimeMs: msAfterBase(15) },
    });
    expect(r.essReaching).not.toBeNull();
    expect(r.essReaching!.time.getTime()).toBeLessThan(msAfterBase(15));
    expect(r.stopInfo!.essBeforeStop).toBe(true);
    expect(r.madeGoal).toBe(true); // goal after the stop still counts
  });

  it('a pilot landed before the stop is untouched (no clip, no bonus)', () => {
    const track = makeTrack({ minutes: 8, altitude: 1800 }); // lands min 8
    const plain = resolveTurnpointSequence(makeTask(), track);
    const stopped = resolveTurnpointSequence(makeTask(), track, {
      stop: { ...stopBase, stopTimeMs: msAfterBase(15) },
    });
    expect(stopped.flownDistance).toBe(plain.flownDistance);
    expect(stopped.stopInfo!.flyingAtStop).toBe(false);
    expect(stopped.stopInfo!.altitudeBonus).toBe(0);
  });

  it('§12.3.6: a pilot still flying at the stop earns the altitude bonus', () => {
    // 1400 m over a 1000 m goal at glide 4 → 1600 m of bonus distance.
    const atGoalAlt = resolveTurnpointSequence(
      makeTask({ essAtGoal: true }), makeTrack({ altitude: 1000 }),
      { stop: { ...stopBase, stopTimeMs: msAfterBase(15) } },
    );
    const high = resolveTurnpointSequence(
      makeTask({ essAtGoal: true }), makeTrack({ altitude: 1400 }),
      { stop: { ...stopBase, stopTimeMs: msAfterBase(15) } },
    );
    expect(high.stopInfo!.altitudeBonus).toBeCloseTo(1600, 6);
    expect(high.stopInfo!.bestPointAltitude).toBe(1400);
    expect(high.flownDistance).toBeCloseTo(atGoalAlt.flownDistance + 1600, 3);
    expect(high.bestProgress!.altitudeBonus).toBeCloseTo(1600, 6);
  });

  it('the altitude bonus is clamped at goal distance', () => {
    // Absurd altitude: the bonus cannot push flown distance past the task.
    const result = resolveTurnpointSequence(
      makeTask({ essAtGoal: true }), makeTrack({ altitude: 10_000 }),
      { stop: { ...stopBase, stopTimeMs: msAfterBase(15) } },
    );
    expect(result.flownDistance).toBeLessThanOrEqual(result.taskDistance);
    expect(result.madeGoal).toBe(false); // bonus distance is not goal
  });

  it('round-trips stopInfo through JSON', () => {
    const result = resolveTurnpointSequence(makeTask({ essAtGoal: true }), makeTrack(), {
      stop: { ...stopBase, stopTimeMs: msAfterBase(15) },
    });
    const revived = reviveTurnpointSequenceResult(
      JSON.parse(JSON.stringify(result)) as TurnpointSequenceResultJSON,
    );
    expect(revived.stopInfo).toBeDefined();
    expect(revived.stopInfo!.stopTime).toBeInstanceOf(Date);
    expect(revived.stopInfo!.windowEnd.getTime()).toBe(msAfterBase(15));
    expect(revived.stopInfo!.altitudeBonus).toBe(result.stopInfo!.altitudeBonus);
  });
});

// ---------------------------------------------------------------------------
// resolveScoredWindowEnds (§12.3.4)
// ---------------------------------------------------------------------------

describe('resolveScoredWindowEnds (§12.3.4)', () => {
  it('single-gate race: common window (null)', () => {
    expect(resolveScoredWindowEnds(
      makeTask(), [msAfterBase(0), msAfterBase(0)], msAfterBase(30),
    )).toBeNull();
  });

  it('nobody started: common window (null)', () => {
    expect(resolveScoredWindowEnds(
      makeTask({ timeGates: ['10:00:00Z', '10:15:00Z'] }), [null, null], msAfterBase(30),
    )).toBeNull();
  });

  it('multi-gate: every pilot gets the last starter\'s duration', () => {
    const ends = resolveScoredWindowEnds(
      makeTask({ timeGates: ['10:00:00Z', '10:15:00Z'] }),
      [msAfterBase(0), msAfterBase(15), null],
      msAfterBase(35),
    );
    // Last start 10:15, stop 10:35 → 20-minute window for everyone.
    expect(ends).toEqual([msAfterBase(20), msAfterBase(35), msAfterBase(35)]);
  });
});

// ---------------------------------------------------------------------------
// scoreTask end-to-end — single-gate PG race
// ---------------------------------------------------------------------------

/**
 * Three-pilot field on the SSS→ESS(47.05)→goal(47.10) task, gate 10:00:
 * - fast: 0.008°/min — ESS ~min 6.4, goal ~min 12.7, lands min 14
 * - slow: 0.0025°/min, 1400 m — at the stop (min 15) short of ESS, airborne
 * - early: lands at min 8 (short track)
 */
function makeField(): PilotFlight[] {
  return [
    { pilotName: 'Fast', trackFile: 'fast.igc', fixes: makeTrack({ degPerMin: 0.008, minutes: 14 }) },
    { pilotName: 'Slow', trackFile: 'slow.igc', fixes: makeTrack({ degPerMin: 0.0025, minutes: 22, altitude: 1400 }) },
    { pilotName: 'Early', trackFile: 'early.igc', fixes: makeTrack({ minutes: 8 }) },
  ];
}

describe('scoreTask — stopped single-gate race (PG)', () => {
  // nominalTime 1200 → minimum run 600 s; stop announcement 10:20 with the
  // default 300 s score-back → stop 10:15 → 15-minute window ≥ 10 minutes.
  const params = pgParams({ nominalTime: 1200 });
  const options = { stopAnnouncementMs: msAfterBase(20) };

  it('scores the stopped task with validity, reduction, bonus and flags', () => {
    const result = scoreTask(makeTask(), makeField(), params, undefined, options);

    expect(result.stopped).toBeDefined();
    const stopped = result.stopped!;
    expect(stopped.stopTimeMs).toBe(msAfterBase(15));
    expect(stopped.scoredWindowSeconds).toBe(900);
    expect(stopped.minimumRunSeconds).toBe(600);
    expect(stopped.requirementMet).toBe(true);
    expect(stopped.stoppedValidity).toBe(1); // Fast reached ESS
    expect(result.taskValidity.stopped).toBe(1);
    expect(result.taskValidity.task).toBeCloseTo(
      result.taskValidity.launch * result.taskValidity.distance * result.taskValidity.time,
      10,
    );

    const fast = result.pilotScores.find(p => p.trackFile === 'fast.igc')!;
    const slow = result.pilotScores.find(p => p.trackFile === 'slow.igc')!;
    const early = result.pilotScores.find(p => p.trackFile === 'early.igc')!;

    // §12.3.5: Fast reached ESS before the stop → complete flight, in goal,
    // and their time points are docked by the fixed reduction.
    expect(fast.madeGoal).toBe(true);
    expect(stopped.timePointsReduction).toBeGreaterThan(0);
    expect(fast.timePoints).toBeCloseTo(
      result.availablePoints.time - stopped.timePointsReduction, 0,
    );

    // §12.3.6: Slow was airborne at the stop 400 m above goal → 1600 m bonus.
    expect(slow.madeGoal).toBe(false);
    expect(slow.reachedESS).toBe(false);
    expect(slow.stoppedAltitudeBonus).toBeCloseTo(1600, 6);
    expect(slow.turnpointResult.stopInfo!.flyingAtStop).toBe(true);

    // Early landed before the stop: no bonus, counted landed.
    expect(early.stoppedAltitudeBonus).toBeUndefined();
    expect(early.turnpointResult.stopInfo!.flyingAtStop).toBe(false);
    expect(stopped.numLandedBeforeStop).toBe(2); // Fast (landed in goal) + Early
  });

  it('the goal pilot keeps more time points when the task is NOT stopped', () => {
    const stoppedRun = scoreTask(makeTask(), makeField(), params, undefined, options);
    const normalRun = scoreTask(makeTask(), makeField(), params);
    const fastStopped = stoppedRun.pilotScores.find(p => p.trackFile === 'fast.igc')!;
    const fastNormal = normalRun.pilotScores.find(p => p.trackFile === 'fast.igc')!;
    expect(normalRun.stopped).toBeUndefined();
    expect(fastNormal.turnpointResult.stopInfo).toBeUndefined();
    // Same weights/validity here (Fast makes goal either way), so the only
    // difference in his time points is the §12.3.5 reduction.
    expect(fastStopped.timePoints).toBeLessThan(fastNormal.timePoints);
  });

  it('§12.3.2: a stop before the minimum run zeroes the task', () => {
    // Announcement 10:10 → stop 10:05 → 5-minute window < 10-minute minimum.
    const result = scoreTask(
      makeTask(), makeField(), params, undefined,
      { stopAnnouncementMs: msAfterBase(10) },
    );
    expect(result.stopped!.requirementMet).toBe(false);
    expect(result.stopped!.stoppedValidity).toBe(0);
    expect(result.taskValidity.stopped).toBe(0);
    expect(result.taskValidity.task).toBe(0);
    expect(result.availablePoints.total).toBe(0);
    for (const p of result.pilotScores) expect(p.totalScore).toBe(0);
  });

  it('§12.3.3: stopped validity < 1 when nobody reached ESS', () => {
    // A slow field: nobody near the ESS by the stop.
    const field: PilotFlight[] = [
      { pilotName: 'A', trackFile: 'a.igc', fixes: makeTrack({ degPerMin: 0.002, minutes: 22 }) },
      { pilotName: 'B', trackFile: 'b.igc', fixes: makeTrack({ degPerMin: 0.001, minutes: 8 }) },
    ];
    const result = scoreTask(makeTask(), field, params, undefined, options);
    expect(result.stats.numReachedESS).toBe(0);
    expect(result.stopped!.stoppedValidity).toBeGreaterThan(0);
    expect(result.stopped!.stoppedValidity).toBeLessThan(1);
    expect(result.taskValidity.task).toBeCloseTo(
      result.taskValidity.launch * result.taskValidity.distance
        * result.taskValidity.time * result.stopped!.stoppedValidity,
      10,
    );
  });
});

// ---------------------------------------------------------------------------
// scoreTask — multi-gate window equalization (§12.3.4)
// ---------------------------------------------------------------------------

describe('score explanation — stopped task', () => {
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

  function makeClassContext(overrides?: Partial<ClassContextInput>): ClassContextInput {
    return {
      task_validity: { launch: 1, distance: 0.9, time: 1, stopped: 0.8, task: 0.72 },
      available_points: { distance: 400, time: 500, leading: 0, arrival: 0, total: 720 },
      pilots: [
        { flown_distance: 11_000, speed_section_time: null, made_goal: false, reached_ess: false },
        { flown_distance: 8_000, speed_section_time: null, made_goal: false, reached_ess: false },
      ],
      stopped: {
        stop_time_ms: msAfterBase(15),
        scored_window_seconds: 900,
        minimum_run_seconds: 600,
        requirement_met: true,
        stopped_validity: 0.8,
        time_points_reduction: 0,
        num_landed_before_stop: 1,
      },
      ...overrides,
    };
  }

  it('narrates the stop, the altitude bonus, and the stopped validity', () => {
    const task = makeTask({ essAtGoal: true });
    const result = resolveTurnpointSequence(task, makeTrack({ altitude: 1400 }), {
      stop: { glideRatio: 4, goalAltitude: 1000, stopTimeMs: msAfterBase(15) },
    });
    const explanation = explainGapScore({
      task,
      result,
      entry: makeEntry({
        flown_distance: result.flownDistance,
        stopped_altitude_bonus: result.stopInfo!.altitudeBonus,
      }),
      classContext: makeClassContext(),
      params: { scoring: 'PG' },
    });

    const flight = explanation.sections.find((s) => s.id === 'flight')!;
    const stopItem = flight.items.find((i) => i.id === 'task-stopped');
    expect(stopItem).toBeDefined();
    expect(stopItem!.text).toContain('stopped');
    expect(flight.items.find((i) => i.id === 'stop-ignored-crossings')).toBeDefined();

    const distance = explanation.sections.find((s) => s.id === 'distance')!;
    const bonusItem = distance.items.find((i) => i.id === 'stopped-altitude-bonus');
    expect(bonusItem).toBeDefined();
    expect(bonusItem!.text).toContain('altitude bonus');
    expect(bonusItem!.text).toContain('§12.3.6');

    const validity = explanation.sections.find((s) => s.id === 'validity')!;
    const stoppedValidity = validity.items.find((i) => i.id === 'stopped-validity');
    expect(stoppedValidity).toBeDefined();
    expect(stoppedValidity!.value).toContain('80');
    // The equation folds the fourth factor in and reconciles.
    const total = validity.items.find((i) => i.id === 'available-total')!;
    expect(total.detail).toContain('× 0.8');
    expect(total.detail).toContain('= 720');
  });

  it('explains the §12.3.5 goal time-points reduction', () => {
    const task = makeTask();
    const track = makeTrack();
    const result = resolveTurnpointSequence(task, track, {
      stop: { glideRatio: 4, goalAltitude: 1000, stopTimeMs: msAfterBase(15) },
    });
    expect(result.madeGoal).toBe(true); // §12.3.5 complete flight
    const explanation = explainGapScore({
      task,
      result,
      entry: makeEntry({
        made_goal: true,
        reached_ess: true,
        flown_distance: result.flownDistance,
        speed_section_time: result.speedSectionTime,
        time_points: 380,
      }),
      classContext: makeClassContext({
        pilots: [
          {
            flown_distance: result.flownDistance,
            speed_section_time: result.speedSectionTime,
            made_goal: true,
            reached_ess: true,
          },
        ],
        stopped: {
          stop_time_ms: msAfterBase(15),
          scored_window_seconds: 900,
          minimum_run_seconds: 600,
          requirement_met: true,
          stopped_validity: 1,
          time_points_reduction: 120,
          num_landed_before_stop: 0,
        },
      }),
      params: { scoring: 'PG' },
    });

    const flight = explanation.sections.find((s) => s.id === 'flight')!;
    expect(flight.items.find((i) => i.id === 'stop-ess-exemption')).toBeDefined();

    const time = explanation.sections.find((s) => s.id === 'time')!;
    const reduction = time.items.find((i) => i.id === 'stopped-time-reduction');
    expect(reduction).toBeDefined();
    expect(reduction!.text).toContain('120');
    expect(reduction!.text).toContain('§12.3.5');
    const formula = time.items.find((i) => i.id === 'time-formula')!;
    expect(formula.detail).toContain('− 120 (task stopped, §12.3.5)');
  });
});

describe('scoreTask — stopped multi-gate race (§12.3.4)', () => {
  it('every pilot is scored for the last starter\'s window', () => {
    // ESS co-located with goal so §12.3.5 can't exempt P1 from the clip.
    const task = makeTask({ timeGates: ['10:00:00Z', '10:15:00Z'], essAtGoal: true });
    // P1 takes the 10:00 gate and reaches goal ~10:20.3.
    // P2 launches late, takes the 10:15 gate (crossing ~10:15.7) and reaches
    // goal at track-min ~20.3 → ~10:34.3 absolute.
    const pilots: PilotFlight[] = [
      { pilotName: 'P1', trackFile: 'p1.igc', fixes: makeTrack() },
      { pilotName: 'P2', trackFile: 'p2.igc', fixes: makeTrack({ startMin: 14 }) },
    ];
    // PG, announcement 10:40, score-back 300 → stop 10:35. Last start 10:15
    // → a 20-minute window: P1 is scored only to 10:20, P2 to 10:35.
    const result = scoreTask(
      task, pilots, pgParams({ nominalTime: 1200 }), undefined,
      { stopAnnouncementMs: msAfterBase(40) },
    );
    expect(result.stopped!.scoredWindowSeconds).toBe(20 * 60);

    const p1 = result.pilotScores.find(p => p.trackFile === 'p1.igc')!;
    const p2 = result.pilotScores.find(p => p.trackFile === 'p2.igc')!;
    // P2 (goal at 10:34.3, inside their window) makes goal;
    // P1's goal crossing at 10:20.3 is past their equalized 10:20 window.
    expect(p2.madeGoal).toBe(true);
    expect(p1.madeGoal).toBe(false);
    expect(p1.turnpointResult.stopInfo!.windowEnd.getTime()).toBe(msAfterBase(20));
    expect(p2.turnpointResult.stopInfo!.windowEnd.getTime()).toBe(msAfterBase(35));
  });
});
