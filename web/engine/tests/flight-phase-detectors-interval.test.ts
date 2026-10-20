/**
 * detectThermals measures its climb window and exit hysteresis in SECONDS.
 *
 * They used to be 10 fixes and 3 fixes: 10 s at 1 Hz, but 100 s on a 10 s
 * logger, so the same flight split into fewer, longer thermals and every task
 * analysis metric built on them moved a coarse-logger pilot against a 1 Hz
 * field (docs/2026-10-20-logger-interval-evidence.md). Two properties keep
 * the change honest:
 *  - on an evenly spaced 1 Hz track the result is EXACTLY the old one, and
 *  - thinning a 1 Hz track to a coarser logger changes the result far less.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIGC, fixAltitude, type IGCFix } from '../src/igc-parser';
import { detectThermals } from '../src/flight-phase-detectors';
import { DEFAULT_THRESHOLDS } from '../src/thresholds';

const COMP_DIR = join(import.meta.dir, '../../samples/comps/corryong-cup-2026-open-t1');
// Both log at exactly 1 Hz with no gaps, so the old fix-count rules and the
// new seconds rules must agree on them fix for fix.
const EVEN_1HZ_TRACKS = ['rowntree_2207635_050126.igc', 'rhodes_226312_050126.igc'];

function loadFixes(file: string): IGCFix[] {
  return parseIGC(readFileSync(join(COMP_DIR, file), 'utf-8')).fixes;
}

/** What a logger recording every `seconds` would have written. */
function thinTo(fixes: IGCFix[], seconds: number): IGCFix[] {
  const out = [fixes[0]];
  for (const f of fixes) {
    if (f.time.getTime() - out[out.length - 1].time.getTime() >= seconds * 1000) out.push(f);
  }
  return out;
}

/** The pre-2026-10 fix-count rules, kept only as the 1 Hz reference. */
function legacyThermalBounds(fixes: IGCFix[]): [number, number][] {
  const out: [number, number][] = [];
  const { minClimbRate, minThermalDuration, minThermalGap } = DEFAULT_THRESHOLDS.thermal;
  let inThermal = false;
  let start = 0;
  let exitCounter = 0;
  let lastEnd = -1;
  const sec = (i: number) => fixes[i].time.getTime() / 1000;
  for (let i = 10; i < fixes.length; i++) {
    const dt = sec(i) - sec(i - 10);
    const climb = dt > 0 ? (fixAltitude(fixes[i]) - fixAltitude(fixes[i - 10])) / dt : 0;
    if (!inThermal && climb > minClimbRate) {
      const s = i - 10;
      const gap = lastEnd >= 0 ? sec(s) - sec(lastEnd) : Infinity;
      if (s > lastEnd && gap >= minThermalGap) {
        inThermal = true;
        start = s;
        exitCounter = 0;
      }
    } else if (inThermal) {
      if (climb <= minClimbRate) {
        if (++exitCounter >= 3) {
          const end = i - 3;
          if (sec(end) - sec(start) >= minThermalDuration && sec(end) > sec(start)) {
            out.push([start, end]);
            lastEnd = end;
          }
          inThermal = false;
          exitCounter = 0;
        }
      } else {
        exitCounter = 0;
      }
    }
  }
  if (inThermal && sec(fixes.length - 1) - sec(start) >= minThermalDuration) {
    out.push([start, fixes.length - 1]);
  }
  return out;
}

function totalSeconds(fixes: IGCFix[]): number {
  return detectThermals(fixes, DEFAULT_THRESHOLDS).reduce((sum, t) => sum + t.duration, 0);
}

describe('detectThermals and the logger fix interval', () => {
  for (const file of EVEN_1HZ_TRACKS) {
    it(`matches the old fix-count rules exactly on an even 1 Hz track (${file})`, () => {
      const fixes = loadFixes(file);
      for (let i = 1; i < fixes.length; i++) {
        expect(fixes[i].time.getTime() - fixes[i - 1].time.getTime()).toBe(1000);
      }
      const bounds = detectThermals(fixes, DEFAULT_THRESHOLDS).map((t) => [t.startIndex, t.endIndex]);
      expect(bounds.length).toBeGreaterThan(10);
      expect(bounds).toEqual(legacyThermalBounds(fixes));
    });

    it(`keeps the climbing time when the same flight is logged coarser (${file})`, () => {
      const fixes = loadFixes(file);
      const at1 = totalSeconds(fixes);
      // A 2 s logger reads the same climbs; a 10 s one stays within a fifth.
      // The fix-count rules inflated these by up to 19% and 39%.
      expect(Math.abs(totalSeconds(thinTo(fixes, 2)) / at1 - 1)).toBeLessThan(0.03);
      expect(Math.abs(totalSeconds(thinTo(fixes, 10)) / at1 - 1)).toBeLessThan(0.2);
    });
  }

  it('averages the climb over at least 10 s, however few fixes that takes', () => {
    // 10 s logger: a steady 2 m/s climb for 2 minutes between level flight.
    const fixes: IGCFix[] = [];
    const t0 = Date.UTC(2026, 0, 5, 3, 0, 0);
    for (let s = 0; s <= 600; s += 10) {
      const alt = s < 200 ? 1000 : s <= 320 ? 1000 + (s - 200) * 2 : 1240;
      fixes.push({
        time: new Date(t0 + s * 1000),
        latitude: -36.2,
        longitude: 147.9 + s * 1e-4,
        pressureAltitude: alt,
        gnssAltitude: alt,
        valid: true,
      });
    }
    const [thermal, ...rest] = detectThermals(fixes, DEFAULT_THRESHOLDS);
    expect(rest).toHaveLength(0);
    // Ten fixes would have been a 100 s window, starting the thermal 90 s early.
    expect((fixes[thermal.startIndex].time.getTime() - t0) / 1000).toBe(200);
    expect((fixes[thermal.endIndex].time.getTime() - t0) / 1000).toBe(320);
  });
});
