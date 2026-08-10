/**
 * The forge is only worth anything if the files it makes are ACCEPTED.
 *
 * So these tests do not inspect the output's shape and call it a day — they
 * push it through `parseIGC` and `assessTrackQuality`, the same code the
 * worker runs on upload. That is the whole claim: a clean verdict here means
 * the file will be stored AND scored, not that it looks about right.
 *
 * The sabotage cases matter just as much. A forge that can only make good
 * files cannot be used to test what a pilot sees when their track is
 * withheld, which is the path nobody can reach on demand otherwise.
 */
import { describe, it, expect } from 'bun:test';
import {
  forgeIgc,
  buildFlight,
  turnpointsFromTask,
  startSecondsFor,
  zoneOffsetHours,
  courseFor,
  forgeRange,
  openDistanceCourse,
  OPEN_DISTANCE_MAX_METERS,
  OPEN_DISTANCE_DEFAULT_METERS,
} from '../src/forge-igc';
import { parseIGC } from '../src/igc-parser';
import { resolveTurnpointSequence } from '../src/turnpoint-sequence';
import { assessTrackQuality } from '../src/track-quality';
import { summariseFlight } from '../src/flight-summary';
import { openDistanceForFlight } from '../src/open-distance-scoring';
import {
  ellipsoidDistance,
  calculateBearingRadians,
  destinationPoint,
} from '../src/geo';
import type { XCTask } from '../src/xctsk-parser';

/** Deterministic stand-in for Math.random, so a failure is reproducible. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** A real-shaped task in the Victorian Alps: launch, two turnpoints, goal. */
const TASK: XCTask = {
  taskType: 'CLASSIC',
  version: 1,
  earthModel: 'WGS84',
  turnpoints: [
    { type: 'TAKEOFF', radius: 400, waypoint: { name: 'MTBUFF', lat: -36.72, lon: 146.83, altSmoothed: 1700 } },
    { type: 'SSS', radius: 1000, waypoint: { name: 'START', lat: -36.70, lon: 146.85, altSmoothed: 1500 } },
    { radius: 2000, waypoint: { name: 'TP1', lat: -36.55, lon: 147.05, altSmoothed: 900 } },
    { radius: 400, waypoint: { name: 'GOAL', lat: -36.40, lon: 147.20, altSmoothed: 600 } },
  ],
  sss: { type: 'RACE', direction: 'EXIT' },
  goal: { type: 'CYLINDER' },
} as unknown as XCTask;

const TASK_DATE = '2026-01-05';
const ZONE = 'Australia/Melbourne';

function forge(
  sabotage: 'none' | 'day' | 'place' = 'none',
  stopAfterMeters: number | null = null
) {
  return forgeIgc(TASK, {
    stopAfterMeters,
    pilot: 'Test Pilot',
    glider: 'Forged Wing',
    startSec: startSecondsFor('13:00', TASK_DATE, ZONE),
    rate: 5,
    speedKmh: 32,
    headerDate: new Date(`${TASK_DATE}T00:00:00Z`),
    random: seeded(),
    sabotage,
  });
}

function judge(text: string) {
  const igc = parseIGC(text);
  return {
    igc,
    quality: assessTrackQuality(igc.fixes, igc.header, {
      task: TASK,
      taskDate: TASK_DATE,
      timeZone: ZONE,
      category: 'hg',
    }),
  };
}

describe('a forged flight is one the engine accepts', () => {
  it('passes the upload shape check (SEC-04)', () => {
    // The worker refuses anything that does not start with an A record and
    // contain HFDTE, before the file ever reaches R2.
    const { text } = forge();
    expect(text[0]).toBe('A');
    expect(text).toContain('HFDTE');
  });

  it('parses into real fixes, not an empty header', () => {
    // Several bundled sample IGCs are header-only stubs that parse to ZERO
    // fixes — and track quality is then silently never assessed. A forge that
    // produced one of those would look fine and test nothing.
    const { igc } = judge(forge().text);
    expect(igc.fixes.length).toBeGreaterThan(500);
  });

  it('is clean against the very task it flew', () => {
    const { quality } = judge(forge().text);
    expect(quality.hardFailed).toBe(false);
    expect(quality.findings.map((f) => `${f.severity}/${f.id}`)).toEqual([]);
  });

  it('reads as a plausible flight, not a teleport', () => {
    const { igc } = judge(forge().text);
    const s = summariseFlight(igc);
    expect(s.flightDate).toBe(TASK_DATE);
    // Took off and landed, so there is a duration to report at all.
    expect(s.durationSeconds ?? 0).toBeGreaterThan(30 * 60);
    expect(s.durationSeconds ?? 0).toBeLessThan(8 * 3600);
    // Flew the route rather than sitting on the hill.
    expect((s.trackLengthMeters ?? 0) / 1000).toBeGreaterThan(40);
    // And stayed in the atmosphere pilots actually use.
    expect(s.maxAltitudeMeters ?? 0).toBeLessThan(4300);
    expect(s.headerPilotName).toBe('Test Pilot');
  });

  it('takes off at the local time asked for, in the comp zone', () => {
    // The wrong-day check judges fixes against the task's day IN THE COMP'S
    // zone, so a flight placed by UTC lands on the wrong side of midnight for
    // half the world.
    const { igc } = judge(forge().text);
    const first = igc.fixes[0].time;
    const localHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        hour12: false,
        timeZone: ZONE,
      }).format(first)
    );
    expect(localHour).toBe(13);
  });
});

describe('the flight flies INTO the turnpoints, not past them', () => {
  // The regression this pins down: the forge used to follow the optimised
  // line exactly, whose vertices sit ON each cylinder boundary — and then
  // turned for the next vertex a cruise step early. The track grazed or
  // missed every cylinder, the sequence resolver credited none of them, and
  // a "made goal" forge scored as a land-out a few km past the start.
  it('a full-distance forge is credited with every turnpoint and goal', () => {
    const { igc } = judge(forge().text);
    const seq = resolveTurnpointSequence(TASK, igc.fixes);
    expect(seq.madeGoal).toBe(true);
    expect(seq.lastTurnpointReached).toBe(TASK.turnpoints.length - 1);
  });

  it('puts a fix at least 5 m inside every cylinder', () => {
    const { igc } = judge(forge().text);
    for (const tp of TASK.turnpoints) {
      const closest = Math.min(
        ...igc.fixes.map((f) =>
          ellipsoidDistance(tp.waypoint.lat, tp.waypoint.lon, f.latitude, f.longitude)
        )
      );
      expect(closest).toBeLessThan(tp.radius - 5);
    }
  });

  it('crosses a goal LINE, not just its nearest point', () => {
    // A goal line is crossed, not entered: pulling its optimised point
    // "towards the centre" would only slide it along the line, so the forge
    // has to fly through it instead.
    const lineTask = {
      ...TASK,
      goal: { type: 'LINE' },
    } as unknown as XCTask;
    const { text } = forgeIgc(lineTask, {
      stopAfterMeters: null,
      pilot: 'Test Pilot',
      glider: 'Forged Wing',
      startSec: startSecondsFor('13:00', TASK_DATE, ZONE),
      rate: 5,
      speedKmh: 32,
      headerDate: new Date(`${TASK_DATE}T00:00:00Z`),
      random: seeded(),
    });
    const seq = resolveTurnpointSequence(lineTask, parseIGC(text).fixes);
    expect(seq.madeGoal).toBe(true);
  });

  it('drifts off the optimised line rather than flying it exactly', () => {
    // A real pilot wanders hunting lift; a track lying pixel-perfect on the
    // optimised line reads as fabricated on the very map it is shown on. The
    // wander is bounded, though — it must never cost the cylinder hits above.
    const { points } = courseFor(TASK);
    const samples: { lat: number; lon: number }[] = [];
    for (let i = 1; i < points.length; i++) {
      const leg = ellipsoidDistance(
        points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon
      );
      const bearing = calculateBearingRadians(
        points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon
      );
      for (let m = 0; m <= leg; m += 100) {
        samples.push(destinationPoint(points[i - 1].lat, points[i - 1].lon, m, bearing));
      }
    }
    const offLine = (f: { latitude: number; longitude: number }) =>
      Math.min(
        ...samples.map((s) => ellipsoidDistance(s.lat, s.lon, f.latitude, f.longitude))
      );
    const { igc } = judge(forge().text);
    const worst = Math.max(...igc.fixes.map(offLine));
    expect(worst).toBeGreaterThan(60); // visibly not the optimised line
    expect(worst).toBeLessThan(2_000); // but still recognisably flying it
  });
});

describe('sabotage reaches the paths nobody can reach on demand', () => {
  it('wrong day fails HARD, and only on the day', () => {
    const { quality } = judge(forge('day').text);
    expect(quality.hardFailed).toBe(true);
    expect(quality.findings.map((f) => f.id)).toContain('wrong-day');
  });

  it('wrong place fails HARD', () => {
    const { quality } = judge(forge('place').text);
    expect(quality.hardFailed).toBe(true);
  });

  it('a sabotaged file is still a VALID file', () => {
    // The point of these is a track that uploads and is then withheld from
    // scoring. A file that failed validation instead would exercise a
    // completely different path.
    for (const s of ['day', 'place'] as const) {
      const { text } = forge(s);
      expect(text[0]).toBe('A');
      expect(judge(text).igc.fixes.length).toBeGreaterThan(500);
    }
  });
});

describe('landing out part way round', () => {
  const { points, totalMeters } = courseFor(TASK);

  /** Walk the optimised line independently, so the expectation is derived
   *  rather than read back out of the code under test. */
  function pointAt(meters: number) {
    let left = meters;
    for (let i = 1; i < points.length; i++) {
      const leg = ellipsoidDistance(
        points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon
      );
      if (left > leg) { left -= leg; continue; }
      const b = calculateBearingRadians(
        points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon
      );
      return destinationPoint(points[i - 1].lat, points[i - 1].lon, left, b);
    }
    return points[points.length - 1];
  }

  function landedAt(text: string) {
    const fixes = parseIGC(text).fixes;
    const last = fixes[fixes.length - 1];
    return { lat: last.latitude, lon: last.longitude };
  }

  it('comes down where the slider says, not at a turnpoint', () => {
    // The whole feature: pick 40 km, get a pilot who landed 40 km along the
    // course — mid-leg if that is where 40 km falls.
    const target = 40_000;
    const { text, courseMeters } = forge('none', target);
    expect(courseMeters).toBe(target);

    const want = pointAt(target);
    const got = landedAt(text);
    // Within a few hundred metres: the last leg is flown in cruise-sized
    // steps, and the landing wanders a little on the ground.
    expect(ellipsoidDistance(want.lat, want.lon, got.lat, got.lon)).toBeLessThan(600);
  });

  it('flies further when you ask for further', () => {
    const short = forge('none', 20_000);
    const long = forge('none', 60_000);
    const km = (t: string) => (summariseFlight(parseIGC(t)).trackLengthMeters ?? 0);
    expect(km(long.text)).toBeGreaterThan(km(short.text));
  });

  it('reaches goal when the slider is at the end', () => {
    const full = forge('none', totalMeters);
    const goal = points[points.length - 1];
    const got = landedAt(full.text);
    expect(ellipsoidDistance(goal.lat, goal.lon, got.lat, got.lon)).toBeLessThan(600);
  });

  it('is the same flight as not asking at all', () => {
    // Null means the whole task; passing the total explicitly must not be a
    // second, subtly different path.
    expect(forge('none', totalMeters).text).toBe(forge('none', null).text);
  });

  it('clamps beyond the end rather than flying past goal', () => {
    const { courseMeters } = forge('none', totalMeters * 5);
    expect(courseMeters).toBe(totalMeters);
  });

  it('at zero, the pilot lands back at launch', () => {
    // A real outcome, not a degenerate one: launched, never connected, landed
    // on the hill. It has to produce a FLIGHT — a zero-length course would
    // otherwise have nothing to fly and throw.
    const { text, courseMeters } = forge('none', 0);
    expect(courseMeters).toBe(0);
    const got = landedAt(text);
    expect(ellipsoidDistance(points[0].lat, points[0].lon, got.lat, got.lon))
      .toBeLessThan(3_000);
    const { quality } = judge(text);
    expect(quality.hardFailed).toBe(false);
  });

  it('still produces a file the engine accepts', () => {
    const { text } = forge('none', 25_000);
    expect(text[0]).toBe('A');
    expect(judge(text).quality.hardFailed).toBe(false);
    expect(parseIGC(text).fixes.length).toBeGreaterThan(200);
  });
});

describe('a task with no route to fly (open distance)', () => {
  /** Jil Jil Farm, the Big Chip launch: one take-off cylinder, no goal. */
  const OPEN_TASK: XCTask = {
    taskType: 'OPEN-DISTANCE',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: [
      {
        type: 'TAKEOFF',
        radius: 5000,
        waypoint: { name: 'JILJIL', lat: -35.86, lon: 142.89, altSmoothed: 90 },
      },
    ],
  } as unknown as XCTask;

  const OPEN_DATE = '2026-02-14';

  function forgeOpen(
    meters: number | null = null,
    sabotage: 'none' | 'day' | 'place' = 'none',
    seed = 7
  ) {
    return forgeIgc(OPEN_TASK, {
      stopAfterMeters: meters,
      pilot: 'Test Pilot',
      glider: 'Forged Wing',
      startSec: startSecondsFor('12:00', OPEN_DATE, ZONE),
      rate: 5,
      speedKmh: 45,
      headerDate: new Date(`${OPEN_DATE}T00:00:00Z`),
      random: seeded(seed),
      sabotage,
    });
  }

  function judgeOpen(text: string) {
    const igc = parseIGC(text);
    return {
      igc,
      quality: assessTrackQuality(igc.fixes, igc.header, {
        task: OPEN_TASK,
        taskDate: OPEN_DATE,
        timeZone: ZONE,
        category: 'hg',
      }),
      /** What the scorer will credit, read back off the finished file. */
      scored: openDistanceForFlight(OPEN_TASK, {
        pilotName: 'Test Pilot',
        trackFile: 'forged.igc',
        fixes: igc.fixes,
      }),
    };
  }

  it('has a range at all, rather than a zero-width one', () => {
    // The bug: asking the optimiser for a task line a one-turnpoint task does
    // not have gives zero, so the slider ran 0→0 and its reading was NaN.
    expect(courseFor(OPEN_TASK).totalMeters).toBe(0);
    const range = forgeRange(OPEN_TASK);
    expect(range).toEqual({
      maxMeters: OPEN_DISTANCE_MAX_METERS,
      defaultMeters: OPEN_DISTANCE_DEFAULT_METERS,
      openDistance: true,
    });
    // And a task that DOES have a route still answers from its own geometry.
    expect(forgeRange(TASK)).toEqual({
      maxMeters: courseFor(TASK).totalMeters,
      defaultMeters: courseFor(TASK).totalMeters,
      openDistance: false,
    });
  });

  it('makes a file the engine accepts and scores', () => {
    const { text, fixCount, openDistance } = forgeOpen(80_000);
    expect(openDistance).toBe(true);
    expect(text[0]).toBe('A');
    expect(text).toContain('HFDTE');
    expect(fixCount).toBeGreaterThan(500);

    const { igc, quality } = judgeOpen(text);
    expect(igc.fixes.length).toBe(fixCount);
    expect(quality.hardFailed).toBe(false);
    expect(quality.findings.map((f) => `${f.severity}/${f.id}`)).toEqual([]);
  });

  it('scores the distance the slider asked for', () => {
    // The whole point of the control: pick 120 km and get a pilot the scorer
    // credits with 120 km of open distance. Within a cruise step or two — the
    // last leg is flown in finite steps and the landing wanders on the ground.
    for (const asked of [5_000, 40_000, 120_000]) {
      const { courseMeters } = forgeOpen(asked);
      expect(Math.abs(courseMeters - asked)).toBeLessThan(200);
      const { scored } = judgeOpen(forgeOpen(asked).text);
      expect(Math.abs(scored - asked)).toBeLessThan(200);
    }
  });

  it('lands at its furthest point, so a detour is never the score', () => {
    // Open distance is measured to the FURTHEST fix, so the search wander has
    // to stay inside the landing's radius or the pilot quietly scores more
    // than was asked for.
    const { igc } = judgeOpen(forgeOpen(120_000).text);
    const centre = OPEN_TASK.turnpoints[0].waypoint;
    const from = (f: { latitude: number; longitude: number }) =>
      ellipsoidDistance(centre.lat, centre.lon, f.latitude, f.longitude);
    const last = igc.fixes[igc.fixes.length - 1];
    const furthest = Math.max(...igc.fixes.map(from));
    expect(furthest - from(last)).toBeLessThan(50);
  });

  it('goes off in a random direction, not one fixed bearing', () => {
    // There is no route, so the direction is the forge's to choose — and a
    // forge that always flew due north would put every test track in one line.
    const bearings = [1, 2, 3, 4, 5].map(
      (s) => openDistanceCourse(OPEN_TASK, 60_000, seeded(s)).bearing
    );
    expect(new Set(bearings.map((b) => Math.round(b * 100))).size).toBe(5);
  });

  it('flies further when you ask for further', () => {
    const km = (t: string) => (summariseFlight(parseIGC(t)).trackLengthMeters ?? 0);
    expect(km(forgeOpen(150_000).text)).toBeGreaterThan(km(forgeOpen(30_000).text));
  });

  it('stops at the maximum rather than flying past it', () => {
    const { courseMeters, taskMeters } = forgeOpen(OPEN_DISTANCE_MAX_METERS * 5);
    expect(taskMeters).toBe(OPEN_DISTANCE_MAX_METERS);
    expect(Math.abs(courseMeters - OPEN_DISTANCE_MAX_METERS)).toBeLessThan(200);
  });

  it('asked for nothing in particular, flies the default distance', () => {
    expect(Math.abs(forgeOpen(null).courseMeters - OPEN_DISTANCE_DEFAULT_METERS))
      .toBeLessThan(200);
  });

  it('at zero, the pilot never leaves the launch cylinder', () => {
    // The real outcome an open-distance day always has some of: towed up, sank
    // out, landed in the paddock — scored nothing, and flagged SOFT for it
    // rather than withheld.
    const { text, courseMeters } = forgeOpen(0);
    expect(courseMeters).toBe(0);
    const { quality, scored } = judgeOpen(text);
    expect(scored).toBe(0);
    expect(quality.hardFailed).toBe(false);
    expect(quality.findings.map((f) => f.id)).toEqual(['never-left-takeoff']);
  });

  it('reads as a plausible flight, not a teleport', () => {
    const s = summariseFlight(parseIGC(forgeOpen(80_000).text));
    expect(s.flightDate).toBe(OPEN_DATE);
    expect(s.durationSeconds ?? 0).toBeGreaterThan(30 * 60);
    expect(s.maxAltitudeMeters ?? 0).toBeLessThan(4300);
    // Thermalled its way there rather than gliding one impossible glide.
    expect((s.trackLengthMeters ?? 0) / 1000).toBeGreaterThan(80);
  });

  it('can still be sabotaged', () => {
    // The withheld-track paths are no less needed on an open-distance comp.
    for (const s of ['day', 'place'] as const) {
      const { text } = forgeOpen(60_000, s);
      expect(text[0]).toBe('A');
      const { igc, quality } = judgeOpen(text);
      expect(igc.fixes.length).toBeGreaterThan(500);
      expect(quality.hardFailed).toBe(true);
    }
  });

  it('is deterministic given a seeded random', () => {
    expect(forgeOpen(60_000).text).toBe(forgeOpen(60_000).text);
    expect(forgeOpen(60_000, 'none', 8).text).not.toBe(forgeOpen(60_000).text);
  });
});

describe('the forge itself', () => {
  it('is deterministic given a seeded random', () => {
    // Otherwise a failure here could never be reproduced.
    expect(forge().text).toBe(forge().text);
  });

  it('refuses a route with nothing to fly', () => {
    expect(() =>
      buildFlight([{ lat: -36.7, lon: 146.8 }], {
        rate: 5,
        speedKmh: 30,
        startSec: 0,
        groundAlt: 1000,
        landAlt: 1000,
      })
    ).toThrow(/at least two turnpoints/);
  });

  it("reads a task's own route, defaulting what it lacks", () => {
    const tps = turnpointsFromTask({
      turnpoints: [
        { radius: 0, waypoint: { name: 'A', lat: 1, lon: 2 } },
        { radius: 800, waypoint: { name: 'B', lat: 3, lon: 4, altSmoothed: 120 } },
      ],
    } as unknown as XCTask);
    expect(tps[0]).toEqual({ lat: 1, lon: 2, radius: 400, alt: 500, name: 'A' });
    expect(tps[1].radius).toBe(800);
    expect(tps[1].alt).toBe(120);
  });

  it('knows the competition is not on UTC', () => {
    // Melbourne is +11 in January (daylight saving) and +10 in July. Getting
    // this wrong is how a forged flight ends up dated the day before.
    expect(zoneOffsetHours('2026-01-05', ZONE)).toBe(11);
    expect(zoneOffsetHours('2026-07-05', ZONE)).toBe(10);
    expect(zoneOffsetHours('2026-01-05', 'UTC')).toBe(0);
  });
});
