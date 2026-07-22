import { describe, it, expect } from 'bun:test';
import { cleanAltitudes } from '../src/altitude-cleaning';
import { fixAltitude, parseIGC, type IGCFix } from '../src/igc-parser';

const BASE = new Date('2026-01-10T02:00:00Z');

/** One fix per second; gnss/baro settable independently. */
function fix(t: number, gnss: number, baro = gnss - 40): IGCFix {
  return {
    time: new Date(BASE.getTime() + t * 1000),
    latitude: -38.28 + t * 1e-5,
    longitude: 144.46,
    pressureAltitude: baro,
    gnssAltitude: gnss,
    valid: true,
  };
}

/** A smooth 1 m/s climb from 800 m with baro tracking 40 m below. */
function smoothTrack(seconds: number): IGCFix[] {
  return Array.from({ length: seconds + 1 }, (_, t) => fix(t, 800 + t));
}

describe('cleanAltitudes — cross-channel path', () => {
  it('a clean track gets no repairs', () => {
    const fixes = smoothTrack(300);
    const report = cleanAltitudes(fixes);
    expect(report.crossChecked).toBe(true);
    expect(report.repairedFixCount).toBe(0);
    expect(report.ranges).toEqual([]);
    expect(fixes.every((f) => f.cleanedAltitude === undefined)).toBe(true);
  });

  it('repairs a GNSS spike the barometer does not confirm', () => {
    const fixes = smoothTrack(300);
    // 3-fix multipath spike: +400 m on GNSS only.
    for (const t of [150, 151, 152]) fixes[t].gnssAltitude += 400;
    const report = cleanAltitudes(fixes);
    expect(report.repairedFixCount).toBe(3);
    expect(report.ranges.length).toBe(1);
    expect(report.ranges[0].method).toBe('cross-channel');
    expect(report.ranges[0].startTimeMs).toBe(fixes[150].time.getTime());
    expect(report.ranges[0].endTimeMs).toBe(fixes[152].time.getTime());
    expect(report.ranges[0].maxCorrectionMeters).toBeGreaterThan(300);
    // Repaired value = baro + rolling offset ≈ the true altitude.
    expect(Math.abs(fixAltitude(fixes[151]) - 951)).toBeLessThan(20);
    // Raw channels untouched.
    expect(fixes[151].gnssAltitude).toBe(951 + 400);
  });

  it('repairs a zero-GNSS dropout via the residual, keeping neighbours', () => {
    const fixes = smoothTrack(300);
    fixes[100].gnssAltitude = 0;
    const report = cleanAltitudes(fixes);
    expect(report.repairedFixCount).toBe(1);
    expect(Math.abs(fixAltitude(fixes[100]) - 900)).toBeLessThan(20);
  });

  it('a genuine rapid descent moves both channels and is NOT repaired', () => {
    // Spiral dive: −20 m/s for 40 s, both channels agreeing throughout.
    const fixes: IGCFix[] = [];
    for (let t = 0; t <= 100; t++) fixes.push(fix(t, 2000));
    for (let t = 101; t <= 140; t++) fixes.push(fix(t, 2000 - (t - 100) * 20));
    for (let t = 141; t <= 240; t++) fixes.push(fix(t, 1200));
    const report = cleanAltitudes(fixes);
    expect(report.repairedFixCount).toBe(0);
  });

  it('a genuine sea-level landing (0 m via negative-to-zero baro drift) is kept', () => {
    // Coastal landing: glide from 300 m down to a fix whose TRUE altitude is
    // ~0; GNSS legitimately logs small values around zero, baro agrees.
    const fixes: IGCFix[] = [];
    for (let t = 0; t <= 150; t++) {
      const alt = Math.max(2, Math.round(300 - t * 2));
      fixes.push(fix(t, alt, alt + 15));
    }
    const report = cleanAltitudes(fixes);
    expect(report.repairedFixCount).toBe(0);
    expect(fixAltitude(fixes[150])).toBe(2);
  });
});

describe('cleanAltitudes — single-channel rate path', () => {
  /** GNSS-only logger: pressure channel dead (all zeros). */
  function gnssOnly(seconds: number): IGCFix[] {
    return Array.from({ length: seconds + 1 }, (_, t) => fix(t, 1500, 0));
  }

  it('repairs an out-and-back excursion entered faster than a glider can fly', () => {
    const fixes = gnssOnly(200);
    for (const t of [100, 101]) fixes[t].gnssAltitude = 300; // −1200 m in 1 s
    const report = cleanAltitudes(fixes);
    expect(report.crossChecked).toBe(false);
    expect(report.repairedFixCount).toBe(2);
    expect(report.ranges[0].method).toBe('rate');
    // Interpolated across the excursion.
    expect(Math.abs(fixAltitude(fixes[100]) - 1500)).toBeLessThan(5);
  });

  it('a sustained shift (logger restart shape) is left alone', () => {
    const fixes = gnssOnly(200);
    for (let t = 100; t <= 200; t++) fixes[t].gnssAltitude = 300;
    const report = cleanAltitudes(fixes);
    expect(report.repairedFixCount).toBe(0);
  });

  it('a slow descent through zero and back is not touched', () => {
    // The 13th Beach case, single-channel: gentle descent to −5 m (below
    // the ellipsoid/AMSL datum) and climb back out. All rates are gentle.
    const fixes: IGCFix[] = [];
    for (let t = 0; t <= 100; t++) fixes.push(fix(t, 100 - t, 0));
    for (let t = 101; t <= 200; t++) fixes.push(fix(t, -5 + Math.min(105, t - 100), 0));
    const report = cleanAltitudes(fixes);
    expect(report.repairedFixCount).toBe(0);
  });
});

describe('parseIGC integration', () => {
  it('parses, cleans, and reports in one pass', () => {
    const lines = ['HFDTEDATE:100126'];
    for (let t = 0; t < 120; t++) {
      const hh = String(Math.floor(t / 3600) + 2).padStart(2, '0');
      const mm = String(Math.floor(t / 60) % 60).padStart(2, '0');
      const ss = String(t % 60).padStart(2, '0');
      const alt = t === 60 ? 0 : 800 + t; // one dropout fix
      const baro = 760 + t;
      lines.push(
        `B${hh}${mm}${ss}3816800S14427600EA${String(baro).padStart(5, '0')}${String(alt).padStart(5, '0')}`,
      );
    }
    const parsed = parseIGC(lines.join('\n'));
    expect(parsed.fixes.length).toBe(120);
    expect(parsed.altitudeCleaning.crossChecked).toBe(true);
    expect(parsed.altitudeCleaning.repairedFixCount).toBe(1);
    expect(parsed.altitudeCleaning.ranges[0].fixCount).toBe(1);
    expect(Math.abs(fixAltitude(parsed.fixes[60]) - 860)).toBeLessThan(20);
  });
});
