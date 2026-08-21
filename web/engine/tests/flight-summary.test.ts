import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summariseFlight } from '../src/flight-summary';
import { parseIGC, type IGCFix, type TimeOrderReport } from '../src/igc-parser';
import type { AltitudeCleaningReport } from '../src/altitude-cleaning';
import { calculateTrackDistance, ellipsoidDistance } from '../src/geo';

/** A synthetic file's timestamps were already in order. */
const NO_TIME_ISSUES: TimeOrderReport = {
  totalRecordCount: 0,
  malformedRecordCount: 0,
  droppedFixCount: 0,
  duplicateTimeFixCount: 0,
  maxBackwardsJumpMs: 0,
  dayRollovers: 0,
  suppressedDayRollovers: 0,
};

/** A synthetic file's altitudes were never repaired. */
const NO_CLEANING: AltitudeCleaningReport = {
  totalFixCount: 0,
  repairedFixCount: 0,
  ranges: [],
  crossChecked: false,
};

/** A real competition tracklog — a full HG task flown at Corryong. */
function corryongTrack() {
  const text = readFileSync(
    join(import.meta.dir, '../../frontend/public/data/tracks/2025-01-05-Tushar-Corryong.igc'),
    'utf8'
  );
  return parseIGC(text);
}

/** Build a synthetic fix so the null-safety cases don't need a file. */
function fix(secondsFromMidnight: number, lat: number, lon: number, alt: number): IGCFix {
  return {
    time: new Date(Date.UTC(2026, 0, 5, 0, 0, secondsFromMidnight)),
    latitude: lat,
    longitude: lon,
    pressureAltitude: alt,
    gnssAltitude: alt,
    valid: true,
  };
}

describe('summariseFlight — a real tracklog', () => {
  const igc = corryongTrack();
  const summary = summariseFlight(igc);

  it('reads the date the file claims', () => {
    expect(summary.flightDate).toBe('2025-01-05');
  });

  it('detects an airborne window inside the file', () => {
    expect(summary.takeoffMs).not.toBeNull();
    expect(summary.landingMs).not.toBeNull();
    expect(summary.trackLengthIsAirborneOnly).toBe(true);
    // The window is a slice, so it cannot start before or end after the file.
    expect(summary.takeoffMs!).toBeGreaterThanOrEqual(summary.firstFixMs!);
    expect(summary.landingMs!).toBeLessThanOrEqual(summary.lastFixMs!);
  });

  it('reports a duration that agrees with its own takeoff and landing', () => {
    expect(summary.durationSeconds).toBe(
      (summary.landingMs! - summary.takeoffMs!) / 1000
    );
    // A competition task: more than 20 minutes, less than a day.
    expect(summary.durationSeconds!).toBeGreaterThan(20 * 60);
    expect(summary.durationSeconds!).toBeLessThan(24 * 3600);
  });

  it('reports a track longer than the straight line it covers', () => {
    const first = igc.fixes[0];
    const last = igc.fixes[igc.fixes.length - 1];
    const straightLine = ellipsoidDistance(
      first.latitude,
      first.longitude,
      last.latitude,
      last.longitude
    );
    expect(summary.trackLengthMeters!).toBeGreaterThan(straightLine);
  });

  it('measures the airborne slice, not the whole file', () => {
    const whole = calculateTrackDistance(igc.fixes);
    expect(summary.trackLengthMeters!).toBeLessThanOrEqual(whole);
  });

  it('reports a plausible climb above launch', () => {
    expect(summary.maxAltitudeMeters!).toBeGreaterThan(0);
    expect(summary.maxAltitudeAboveTakeoffMeters!).toBeGreaterThan(0);
    expect(summary.maxAltitudeAboveTakeoffMeters!).toBeLessThanOrEqual(
      summary.maxAltitudeMeters!
    );
  });

  it('reports the logger cadence', () => {
    expect(summary.fixCount).toBe(igc.fixes.length);
    expect(summary.medianFixIntervalSeconds!).toBeGreaterThan(0);
    expect(summary.medianFixIntervalSeconds!).toBeLessThanOrEqual(60);
  });
});

describe('summariseFlight — altitude', () => {
  it('does not read a GNSS dropout as sea level', () => {
    // The IGC "no GPS altitude" sentinel is a literal 0 in the GNSS field.
    // fixAltitude falls back to the barometer; a summary that read
    // gnssAltitude directly would report a max of 1500 and a peak that never
    // happened.
    const fixes: IGCFix[] = [];
    for (let i = 0; i < 40; i++) {
      const alt = 1000 + i * 25;
      fixes.push({
        ...fix(i * 5, -36.2 + i * 0.002, 147.9 + i * 0.002, alt),
        gnssAltitude: i === 20 ? 0 : alt,
        pressureAltitude: alt,
      });
    }
    const summary = summariseFlight({
      header: {},
      fixes,
      events: [],
      altitudeCleaning: NO_CLEANING,
      timeOrder: NO_TIME_ISSUES,
    });
    expect(summary.maxAltitudeMeters).toBe(1975);
  });
});

describe('summariseFlight — files that say little', () => {
  it('summarises an empty file without throwing', () => {
    const summary = summariseFlight({
      header: {},
      fixes: [],
      events: [],
      altitudeCleaning: NO_CLEANING,
      timeOrder: NO_TIME_ISSUES,
    });
    expect(summary.fixCount).toBe(0);
    expect(summary.flightDate).toBeNull();
    expect(summary.durationSeconds).toBeNull();
    expect(summary.trackLengthMeters).toBeNull();
    expect(summary.maxAltitudeMeters).toBeNull();
  });

  it('reports the file span but no duration when nothing was detected', () => {
    // Three fixes is below the detector's floor, so there is no airborne
    // window — but the reader still gets the file's own bounds.
    const fixes = [
      fix(0, -36.2, 147.9, 500),
      fix(10, -36.201, 147.901, 505),
      fix(20, -36.202, 147.902, 510),
    ];
    const summary = summariseFlight({
      header: {},
      fixes,
      events: [],
      altitudeCleaning: NO_CLEANING,
      timeOrder: NO_TIME_ISSUES,
    });
    expect(summary.fixCount).toBe(3);
    expect(summary.takeoffMs).toBeNull();
    expect(summary.landingMs).toBeNull();
    expect(summary.durationSeconds).toBeNull();
    expect(summary.trackLengthIsAirborneOnly).toBe(false);
    expect(summary.firstFixMs).toBe(fixes[0].time.getTime());
    expect(summary.lastFixMs).toBe(fixes[2].time.getTime());
    expect(summary.trackLengthMeters!).toBeGreaterThan(0);
  });

  it('reports no date when the header carried none', () => {
    // The parser dates such a file from the PARSE day, so flightDate must be
    // null rather than today — otherwise the summary asserts a day the file
    // never claimed.
    const summary = summariseFlight({
      header: {},
      fixes: [fix(0, -36.2, 147.9, 500)],
      events: [],
      altitudeCleaning: NO_CLEANING,
      timeOrder: NO_TIME_ISSUES,
    });
    expect(summary.flightDate).toBeNull();
  });
});

describe('summariseFlight — header strings', () => {
  const base = {
    fixes: [],
    events: [],
    altitudeCleaning: NO_CLEANING,
    timeOrder: NO_TIME_ISSUES,
  };

  it('keeps a non-ASCII pilot name intact', () => {
    const summary = summariseFlight({
      ...base,
      header: { pilot: 'Ómar Þórðarson', gliderType: 'Moyes RX 3.5' },
    });
    expect(summary.headerPilotName).toBe('Ómar Þórðarson');
    expect(summary.headerGliderType).toBe('Moyes RX 3.5');
  });

  it('treats an unconfigured logger as no name at all', () => {
    for (const placeholder of ['not set', 'UNKNOWN', 'pilot', '---', '  ']) {
      const summary = summariseFlight({ ...base, header: { pilot: placeholder } });
      expect(summary.headerPilotName).toBeNull();
    }
  });
});
