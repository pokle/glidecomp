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
  type ForgeTurnpoint,
} from '../src/forge-igc';
import { parseIGC } from '../src/igc-parser';
import { assessTrackQuality } from '../src/track-quality';
import { summariseFlight } from '../src/flight-summary';
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

function forge(sabotage: 'none' | 'day' | 'place' = 'none') {
  const tps = turnpointsFromTask(TASK);
  return forgeIgc(tps, {
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

describe('the forge itself', () => {
  it('is deterministic given a seeded random', () => {
    // Otherwise a failure here could never be reproduced.
    expect(forge().text).toBe(forge().text);
  });

  it('refuses a route with nothing to fly', () => {
    const one: ForgeTurnpoint[] = [
      { lat: -36.7, lon: 146.8, radius: 400, alt: 1000, name: 'ONLY' },
    ];
    expect(() =>
      buildFlight(one, { rate: 5, speedKmh: 30, startSec: 0 })
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
