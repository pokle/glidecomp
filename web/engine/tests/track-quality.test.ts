import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessTrackQuality, EMPTY_TRACK_QUALITY_REPORT } from '../src/track-quality';
import type { TrackQualityCheckId, TrackQualityReport } from '../src/track-quality';
import { parseIGC } from '../src/igc-parser';
import { destinationPoint } from '../src/geo';
import type { IGCFix } from '../src/igc-parser';
import type { XCTask } from '../src/xctsk-parser';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TaskDef {
  name: string;
  lat: number;
  lon: number;
  radius: number;
  type?: 'TAKEOFF' | 'SSS' | 'ESS';
}

function createTask(defs: TaskDef[]): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: defs.map((d) => ({
      type: d.type,
      radius: d.radius,
      waypoint: { name: d.name, lat: d.lat, lon: d.lon },
    })),
    sss: { type: 'RACE', direction: 'EXIT' },
    goal: { type: 'CYLINDER' },
  };
}

/** The real Corryong Cup 2025 task 4 route (ELLIOT, Victoria). */
function corryongTask(): XCTask {
  return createTask([
    { name: 'ELLIOT', lat: -36.185833, lon: 147.976667, radius: 1000, type: 'TAKEOFF' },
    { name: 'ELLIOT', lat: -36.185833, lon: 147.976667, radius: 5000, type: 'SSS' },
    { name: 'THOWGL', lat: -36.305417, lon: 147.898867, radius: 400 },
    { name: 'CUDGNO', lat: -36.096867, lon: 147.814283, radius: 400 },
    { name: 'CUDG', lat: -36.192283, lon: 147.770217, radius: 400 },
    { name: 'CORRY', lat: -36.185, lon: 147.8914, radius: 1000, type: 'ESS' },
    { name: 'CORRY', lat: -36.185, lon: 147.8914, radius: 1000 },
  ]);
}

/**
 * A track that walks a straight bearing from a start point at a fixed ground
 * speed, with `altAt(second)` supplying the altitude profile. One fix/second.
 */
function straightTrack(opts: {
  startISO: string;
  seconds: number;
  lat: number;
  lon: number;
  bearingDeg?: number;
  speedMs?: number;
  altAt?: (t: number) => number;
}): IGCFix[] {
  const {
    startISO,
    seconds,
    lat,
    lon,
    bearingDeg = 0,
    speedMs = 11,
    altAt = () => 1000,
  } = opts;
  const t0 = Date.parse(startISO);
  const bearing = (bearingDeg * Math.PI) / 180;
  const fixes: IGCFix[] = [];
  for (let s = 0; s <= seconds; s++) {
    const p = destinationPoint(lat, lon, s * speedMs, bearing);
    const alt = altAt(s);
    fixes.push({
      time: new Date(t0 + s * 1000),
      latitude: p.lat,
      longitude: p.lon,
      pressureAltitude: alt,
      gnssAltitude: alt,
      valid: true,
    });
  }
  return fixes;
}

/**
 * A vehicle on a switchback road: it climbs (or descends) slowly, reverses
 * heading every leg, and stops twice. The profile `never-airborne` exists to
 * separate from a real flight.
 */
function switchbackDrive(opts: {
  startISO: string;
  seconds: number;
  fromAlt: number;
  toAlt: number;
  lat: number;
  lon: number;
}): IGCFix[] {
  const { startISO, seconds, fromAlt, toAlt, lat, lon } = opts;
  const t0 = Date.parse(startISO);
  const rate = (toAlt - fromAlt) / seconds;
  const fixes: IGCFix[] = [];
  let curLat = lat;
  let curLon = lon;
  for (let s = 0; s <= seconds; s++) {
    // Two 60 s stops, and a heading reversal every 40 s.
    const stopped = (s > 300 && s <= 360) || (s > 900 && s <= 960);
    const speed = stopped ? 0 : 7; // 25 km/h
    const bearingDeg = Math.floor(s / 40) % 2 === 0 ? 20 : 200;
    const step = destinationPoint(curLat, curLon, speed, (bearingDeg * Math.PI) / 180);
    curLat = step.lat;
    curLon = step.lon;
    const alt = fromAlt + rate * s;
    fixes.push({
      time: new Date(t0 + s * 1000),
      latitude: curLat,
      longitude: curLon,
      pressureAltitude: alt,
      gnssAltitude: alt,
      valid: true,
    });
  }
  return fixes;
}

function fired(report: TrackQualityReport, id: TrackQualityCheckId): boolean {
  return report.findings.some((f) => f.id === id);
}

function skipped(report: TrackQualityReport, id: TrackQualityCheckId): boolean {
  return report.skipped.some((s) => s.id === id);
}

/** The trimmed real New Zealand track submitted to Corryong 2025 task 4. */
function mckirdyFixes() {
  const text = readFileSync(join(import.meta.dir, 'fixtures/mckirdy-wrong-day-nz.igc'), 'utf8');
  return parseIGC(text);
}

const CORRYONG_CONTEXT = {
  task: corryongTask(),
  taskDate: '2025-01-11',
  timeZone: 'Australia/Melbourne',
  category: 'hg' as const,
};

// ---------------------------------------------------------------------------
// wrong-day
// ---------------------------------------------------------------------------

describe('track quality: wrong-day', () => {
  it('does not fire on the honest Corryong field', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z', // 11:09 local
      seconds: 4 * 3600,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'wrong-day')).toBe(false);
    expect(report.hardFailed).toBe(false);
  });

  // THE test that pins the local-vs-UTC day decision, and the only one here
  // that discriminates: an Australian flight launching at 06:00 local on the
  // task's day is 19:00 UTC the day BEFORE. The task's local day (padded)
  // opens at 09:00 UTC on the 10th and accepts it; the task's UTC day
  // (padded) opens at 20:00 UTC on the 10th and would hard-fail an honest
  // pilot for launching early. Every other case in this file passes under
  // either rule, so if someone simplifies the window to a UTC date
  // comparison, this is the assertion that stops them.
  it('accepts a dawn launch, where the UTC date is the day before', () => {
    // Short on purpose: the rule fires only when EVERY fix is outside the
    // window, so a long flight would drift into a UTC-day window anyway and
    // the test would prove nothing. 06:00-06:45 local is wholly before the
    // UTC-day window opens.
    const fixes = straightTrack({
      startISO: '2025-01-10T19:00:00Z', // 06:00 local on the 11th
      seconds: 45 * 60,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-10T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'wrong-day')).toBe(false);
    expect(report.hardFailed).toBe(false);
  });

  it('fires on the real New Zealand track, ten days off', () => {
    const igc = mckirdyFixes();
    const report = assessTrackQuality(igc.fixes, igc.header, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'wrong-day');
    expect(finding?.severity).toBe('hard');
    expect(finding?.detail).toContain('2025-01-11');
    expect(report.hardFailed).toBe(true);
    if (finding?.evidence.id !== 'wrong-day') throw new Error('wrong evidence');
    expect(finding.evidence.headerDateMissing).toBe(false);
    expect(new Date(finding.evidence.firstFixMs).toISOString()).toBe('2025-01-21T00:01:29.000Z');
  });

  // The regression that forced the soft/hard split. Bright Open 2020 task 1
  // has three pilots (of 80) whose recorders were set one day ahead. They
  // launched in the field's own window, flew the task, and AirScore scored
  // them normally — Phillip Mansell came 4th, in goal, with 675 points. A
  // hard verdict on a one-day offset would have zeroed him.
  it('flags a recorder set one day ahead, but never hard-fails it', () => {
    const fixes = straightTrack({
      startISO: '2020-02-12T01:57:00Z',
      seconds: 100 * 60,
      lat: -36.7,
      lon: 146.97,
      bearingDeg: 30,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2020-02-12T00:00:00Z') }, {
      taskDate: '2020-02-11',
      timeZone: 'Australia/Melbourne',
    });
    const finding = report.findings.find((f) => f.id === 'wrong-day');
    expect(finding?.severity).toBe('soft');
    expect(report.hardFailed).toBe(false);
  });

  it('hard-fails once the track is more than a day out', () => {
    const fixes = straightTrack({
      startISO: '2025-01-08T00:09:00Z',
      seconds: 4 * 3600,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-08T00:00:00Z') }, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'wrong-day');
    expect(finding?.severity).toBe('hard');
    expect(report.hardFailed).toBe(true);
  });

  it('does not fire when a logger ran from the evening before', () => {
    // 22:00 local on the 10th through the flight — one fix inside the day is
    // enough, because the rule requires EVERY fix to be outside.
    const fixes = straightTrack({
      startISO: '2025-01-10T11:00:00Z', // 22:00 local on the 10th
      seconds: 15 * 3600,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-10T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'wrong-day')).toBe(false);
  });

  it('does not fire on a logger writing local time as UTC', () => {
    // 11:00-15:00 local mis-stamped as 11:00-15:00 UTC: still inside the
    // padded local day, so it is a diagnosable fault, not a wrong flight.
    const fixes = straightTrack({
      startISO: '2025-01-11T11:00:00Z',
      seconds: 4 * 3600,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'wrong-day')).toBe(false);
  });

  it('never hard-fails a file with no usable date header', () => {
    // parseIGC stamps such a file with the PARSE day, so "wrong day" would be
    // a statement about the scoring machine's clock.
    const fixes = straightTrack({
      startISO: '2026-05-04T02:00:00Z',
      seconds: 3600,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, {}, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'wrong-day');
    expect(finding?.severity).toBe('soft');
    expect(report.hardFailed).toBe(false);
  });

  it('skips when the task has no date', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 3600,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, {}, { task: corryongTask() });
    expect(skipped(report, 'wrong-day')).toBe(true);
    expect(report.hardFailed).toBe(false);
  });

  it('widens the window to every civil offset when no zone is known', () => {
    // 11 Jan 20:00 local in a UTC+14 zone is 10 Jan 06:00 UTC — outside the
    // UTC day, and it must not hard-fail a pilot for a missing comp setting.
    const fixes = straightTrack({
      startISO: '2025-01-10T11:00:00Z',
      seconds: 3600,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-10T00:00:00Z') }, {
      task: corryongTask(),
      taskDate: '2025-01-11',
    });
    expect(fired(report, 'wrong-day')).toBe(false);
  });

  it('resolves a DST-transition day as a 23-hour local day, not midnight + 24h', () => {
    // Pacific/Auckland leaves DST on 2025-04-06 (a 25-hour day) and enters it
    // on 2025-09-28 (a 23-hour day). A +24h day end would misplace the window.
    const fixes = straightTrack({
      startISO: '2025-09-28T09:00:00Z', // 22:00 NZDT on the 28th
      seconds: 3600,
      lat: -41.5,
      lon: 172.5,
      speedMs: 5,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-09-28T00:00:00Z') }, {
      taskDate: '2025-09-28',
      timeZone: 'Pacific/Auckland',
    });
    expect(fired(report, 'wrong-day')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wrong-place
// ---------------------------------------------------------------------------

describe('track quality: wrong-place', () => {
  it('fires on the real New Zealand track, with the exact nearest approach', () => {
    const igc = mckirdyFixes();
    const report = assessTrackQuality(igc.fixes, igc.header, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'wrong-place');
    expect(finding?.severity).toBe('hard');
    if (finding?.evidence.id !== 'wrong-place') throw new Error('wrong evidence');
    // ~2,186 km to ELLIOT — assert the order of magnitude, not the metre.
    expect(finding.evidence.nearestApproachMeters).toBeGreaterThan(2_100_000);
    expect(finding.evidence.nearestApproachMeters).toBeLessThan(2_250_000);
    expect(finding.evidence.nearestTurnpointName).toBe('ELLIOT');
  });

  // Above 100 km the prose drops to whole thousands-separated kilometres
  // (score-explanation-format's `km` with wholeAbove100): a track at the
  // wrong competition is thousands of kilometres out, where a tenth of a
  // kilometre is noise. Below it the same formatter keeps one decimal — see
  // the never-left-takeoff finding.
  it('states a huge nearest approach in whole kilometres', () => {
    const igc = mckirdyFixes();
    const report = assessTrackQuality(igc.fixes, igc.header, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'wrong-place');
    expect(finding?.detail).toMatch(/turnpoint is \d,\d{3} km \(to ELLIOT\)/);
  });

  it('does not fire on an honest track at the task', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 4 * 3600,
      lat: -36.185833,
      lon: 147.976667,
      bearingDeg: 220,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'wrong-place')).toBe(false);
  });

  // The empirical worst honest case across 4,762 archive tracks: a Forbes
  // flatlands pilot 45.4 km from every turnpoint. This is what stops anyone
  // "tightening" the threshold to 25 km.
  it('does not fire 45 km off course — the worst honest case on record', () => {
    const start = destinationPoint(-36.185833, 147.976667, 45_400, Math.PI / 2);
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 600,
      lat: start.lat,
      lon: start.lon,
      speedMs: 2,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'wrong-place')).toBe(false);
  });

  it('agrees with a brute-force scan when the track straddles the threshold', () => {
    // Spans from 60 km out to 140 km out, so neither bbox tier can decide.
    const start = destinationPoint(-36.185833, 147.976667, 60_000, Math.PI / 2);
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 4000,
      lat: start.lat,
      lon: start.lon,
      bearingDeg: 90,
      speedMs: 20,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'wrong-place')).toBe(false); // 60 km < 100 km threshold
  });

  it('skips when there is no task geometry', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 3600,
      lat: -41.5,
      lon: 172.5,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, {
      taskDate: '2025-01-11',
      timeZone: 'Australia/Melbourne',
    });
    expect(skipped(report, 'wrong-place')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// never-left-takeoff
// ---------------------------------------------------------------------------

describe('track quality: never-left-takeoff', () => {
  it('fires when every fix stays inside the take-off cylinder', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 480,
      lat: -36.185833,
      lon: 147.976667,
      speedMs: 1, // 480 m — inside the 1 km cylinder
      altAt: (t) => 900 - t * 0.5,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'never-left-takeoff');
    expect(finding?.severity).toBe('soft');
    // Under 100 km the finding keeps one decimal (the 1 km cylinder).
    expect(finding?.detail).toContain('1.0 km ELLIOT take-off cylinder');
    expect(report.hardFailed).toBe(false);
  });

  it('does not fire once the track leaves the cylinder', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 1800,
      lat: -36.185833,
      lon: 147.976667,
      speedMs: 11,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'never-left-takeoff')).toBe(false);
  });

  // Falling back to turnpoint 0 would test the 5 km SSS instead, where
  // "never left" means something entirely different.
  it('skips a task that declares no TAKEOFF turnpoint', () => {
    const task = createTask([
      { name: 'ELLIOT', lat: -36.185833, lon: 147.976667, radius: 5000, type: 'SSS' },
      { name: 'CORRY', lat: -36.185, lon: 147.8914, radius: 1000, type: 'ESS' },
    ]);
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 480,
      lat: -36.185833,
      lon: 147.976667,
      speedMs: 1,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, {
      ...CORRYONG_CONTEXT,
      task,
    });
    expect(skipped(report, 'never-left-takeoff')).toBe(true);
    expect(fired(report, 'never-left-takeoff')).toBe(false);
  });

  it('skips a track too short to judge', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 6,
      lat: -36.185833,
      lon: 147.976667,
      speedMs: 1,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(skipped(report, 'never-left-takeoff')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// never-airborne
// ---------------------------------------------------------------------------

describe('track quality: never-airborne', () => {
  // A sled ride never climbs, so the glide signature is the only thing
  // standing between an honest short flight and a false accusation.
  it('does not fire on a legitimate 3-minute sled ride', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 180,
      lat: -36.185833,
      lon: 147.976667,
      speedMs: 11,
      altAt: (t) => 935 - t * 2.2,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(false);
  });

  it('does not fire on a thermalling flight that never glides away', () => {
    const t0 = Date.parse('2025-01-11T00:09:00Z');
    const fixes: IGCFix[] = [];
    for (let s = 0; s <= 600; s++) {
      // A 20 s circle, climbing at 2 m/s.
      const angle = (s / 20) * 2 * Math.PI;
      const p = destinationPoint(-36.185833, 147.976667, 60, angle);
      const alt = 900 + s * 2;
      fixes.push({
        time: new Date(t0 + s * 1000),
        latitude: p.lat,
        longitude: p.lon,
        pressureAltitude: alt,
        gnssAltitude: alt,
        valid: true,
      });
    }
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(false);
  });

  it('fires on a drive up to launch', () => {
    const fixes = switchbackDrive({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 1500,
      fromAlt: 300,
      toAlt: 935,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'never-airborne');
    expect(finding?.severity).toBe('soft');
    if (finding?.evidence.id !== 'never-airborne') throw new Error('wrong evidence');
    // The reason detectTakeoffLanding is evidence and not the gate: it says
    // a car took off.
    expect(finding.evidence.takeoffDetected).toBe(true);
  });

  it('fires on a drive back down after a cancelled day', () => {
    const fixes = switchbackDrive({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 1500,
      fromAlt: 935,
      toAlt: 300,
      lat: -36.185833,
      lon: 147.976667,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// implausible-speed
// ---------------------------------------------------------------------------

describe('track quality: implausible-speed', () => {
  // An instantaneous rule would fire here, which is why the window measures
  // displacement over a full minute instead.
  it('ignores a single GPS jump', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 600,
      lat: -36.185833,
      lon: 147.976667,
      speedMs: 11,
    });
    const jumped = destinationPoint(fixes[300].latitude, fixes[300].longitude, 500, 0);
    fixes[300] = { ...fixes[300], latitude: jumped.lat, longitude: jumped.lon };
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'implausible-speed')).toBe(false);
  });

  it('separates a fast hang glider from a fast paraglider', () => {
    const make = () =>
      straightTrack({
        startISO: '2025-01-11T00:09:00Z',
        seconds: 300,
        lat: -36.185833,
        lon: 147.976667,
        speedMs: 40,
        altAt: (t) => 2000 - t * 0.9,
      });
    const header = { date: new Date('2025-01-11T00:00:00Z') };
    const hg = assessTrackQuality(make(), header, { ...CORRYONG_CONTEXT, category: 'hg' });
    const pg = assessTrackQuality(make(), header, { ...CORRYONG_CONTEXT, category: 'pg' });
    expect(fired(hg, 'implausible-speed')).toBe(false);
    expect(fired(pg, 'implausible-speed')).toBe(true);
  });

  it('fires on an airliner segment for either class', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 300,
      lat: -36.185833,
      lon: 147.976667,
      speedMs: 250,
      altAt: () => 10_000,
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    const finding = report.findings.find((f) => f.id === 'implausible-speed');
    expect(finding).toBeDefined();
    if (finding?.evidence.id !== 'implausible-speed') throw new Error('wrong evidence');
    expect(finding.evidence.maxSustainedSpeedMs).toBeGreaterThan(200);
  });

  it('skips a logger too coarse to measure', () => {
    const t0 = Date.parse('2025-01-11T00:09:00Z');
    const fixes: IGCFix[] = [];
    for (let i = 0; i < 20; i++) {
      const p = destinationPoint(-36.185833, 147.976667, i * 3000, 0);
      fixes.push({
        time: new Date(t0 + i * 300_000), // one fix every 5 minutes
        latitude: p.lat,
        longitude: p.lon,
        pressureAltitude: 1000,
        gnssAltitude: 1000,
        valid: true,
      });
    }
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(fired(report, 'implausible-speed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ordering and report shape
// ---------------------------------------------------------------------------

describe('track quality: report shape', () => {
  it('reports both hard findings and skips the soft checks', () => {
    const igc = mckirdyFixes();
    const report = assessTrackQuality(igc.fixes, igc.header, CORRYONG_CONTEXT);
    expect(report.findings.map((f) => f.id).sort()).toEqual(['wrong-day', 'wrong-place']);
    expect(report.findings.every((f) => f.severity === 'hard')).toBe(true);
    expect(report.hardFailed).toBe(true);
    for (const id of ['never-left-takeoff', 'never-airborne', 'implausible-speed'] as const) {
      expect(skipped(report, id)).toBe(true);
    }
  });

  it('reports a clean track as clean, with every check run', () => {
    const fixes = straightTrack({
      startISO: '2025-01-11T00:09:00Z',
      seconds: 4 * 3600,
      lat: -36.185833,
      lon: 147.976667,
      bearingDeg: 220,
      altAt: (t) => 900 + 600 * Math.sin(t / 400),
    });
    const report = assessTrackQuality(fixes, { date: new Date('2025-01-11T00:00:00Z') }, CORRYONG_CONTEXT);
    expect(report.findings).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.checked).toHaveLength(5);
    expect(report.hardFailed).toBe(false);
  });

  it('reports an empty track as five skips, not five passes', () => {
    const report = assessTrackQuality([], {}, CORRYONG_CONTEXT);
    expect(report.findings).toEqual([]);
    expect(report.skipped).toHaveLength(5);
    expect(report.totalFixCount).toBe(0);
    expect(report.firstFixMs).toBeNull();
    expect(EMPTY_TRACK_QUALITY_REPORT.hardFailed).toBe(false);
  });

  it('is pure: same report twice, and no fix is mutated', () => {
    const igc = mckirdyFixes();
    const before = JSON.stringify(igc.fixes);
    const a = assessTrackQuality(igc.fixes, igc.header, CORRYONG_CONTEXT);
    const b = assessTrackQuality(igc.fixes, igc.header, CORRYONG_CONTEXT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(igc.fixes)).toBe(before);
  });
});
