// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Adversarial-input coverage for altitude cleaning (issue #470, SEC-32).
 *
 * The IGC parser does not enforce monotonic or de-duplicated timestamps, so
 * a crafted file can stamp every fix with the same second. The old
 * crossChannelClean rebuilt and sorted the ±60 s window per fix — O(N² log N)
 * on that input, a per-upload CPU sink at the 2 MiB cap (~60k fixes). The fix
 * (an incremental order-statistic median) must be VALUE-IDENTICAL on every
 * input, so the tests here compare it, per fix, against a verbatim copy of
 * the old window loop — the oracle — across benign, duplicate-timestamp,
 * dead-channel and non-monotone tracks, then assert the degenerate inputs
 * complete in bounded time (the per-test timeout is the perf guard).
 */

import { describe, expect, it } from 'bun:test';
import { cleanAltitudes } from '../src/altitude-cleaning';
import { parseIGC, type IGCFix } from '../src/igc-parser';

// Constants copied from altitude-cleaning.ts — the oracle must match the old
// code exactly, not track future tuning.
const BASELINE_HALF_WINDOW_MS = 60_000;
const RESIDUAL_TOLERANCE_M = 150;
const MAX_PLAUSIBLE_VERTICAL_MS = 40;
const EXCURSION_MAX_MS = 30_000;
const EXCURSION_RETURN_TOLERANCE_M = 150;

/** Seeded PRNG (mulberry32) — oracle fuzz must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_MS = Date.parse('2026-01-10T02:00:00Z');

function fixAt(tMs: number, gnss: number, baro: number): IGCFix {
  return {
    time: new Date(BASE_MS + tMs),
    latitude: -38.28,
    longitude: 144.46,
    pressureAltitude: baro,
    gnssAltitude: gnss,
    valid: true,
  };
}

/** The old O(N² log N) crossChannelClean window loop, verbatim — the oracle. */
function referenceCrossChannelCorrections(fixes: IGCFix[]): Map<number, number> {
  const n = fixes.length;
  const times = fixes.map((f) => f.time.getTime());
  const residual = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    residual[i] =
      fixes[i].gnssAltitude !== 0 && fixes[i].pressureAltitude !== 0
        ? fixes[i].gnssAltitude - fixes[i].pressureAltitude
        : NaN;
  }
  const corrections = new Map<number, number>();
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < n && times[lo] < times[i] - BASELINE_HALF_WINDOW_MS) lo++;
    while (hi < n && times[hi] <= times[i] + BASELINE_HALF_WINDOW_MS) hi++;
    const window: number[] = [];
    for (let j = lo; j < hi; j++) {
      if (!Number.isNaN(residual[j])) window.push(residual[j]);
    }
    if (window.length === 0) continue;
    window.sort((a, b) => a - b);
    const mid = window.length >> 1;
    const baseline =
      window.length % 2 === 1 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
    const f = fixes[i];
    if (f.pressureAltitude === 0) continue;
    const isDropout = f.gnssAltitude === 0;
    const deviates =
      !isDropout && Math.abs(residual[i] - baseline) > RESIDUAL_TOLERANCE_M;
    if (isDropout || deviates) {
      corrections.set(i, f.pressureAltitude + baseline);
    }
  }
  return corrections;
}

/** The old rateClean loop, verbatim (no non-forward-time guard) — the oracle
 * for the single-channel path on monotone inputs. */
function referenceRateCorrections(fixes: IGCFix[]): Map<number, number> {
  const rawAltitude = (f: IGCFix) => (f.gnssAltitude !== 0 ? f.gnssAltitude : f.pressureAltitude);
  const n = fixes.length;
  const alt = fixes.map(rawAltitude);
  const times = fixes.map((f) => f.time.getTime());
  const corrections = new Map<number, number>();
  let i = 1;
  while (i < n) {
    const dt = (times[i] - times[i - 1]) / 1000;
    if (dt <= 0) {
      i++;
      continue;
    }
    const rate = (alt[i] - alt[i - 1]) / dt;
    if (Math.abs(rate) <= MAX_PLAUSIBLE_VERTICAL_MS) {
      i++;
      continue;
    }
    const base = alt[i - 1];
    let ret = -1;
    for (let j = i; j < n && times[j] - times[i - 1] <= EXCURSION_MAX_MS; j++) {
      if (Math.abs(alt[j] - base) <= EXCURSION_RETURN_TOLERANCE_M) {
        ret = j;
        break;
      }
    }
    if (ret < 0) {
      i++;
      continue;
    }
    const t0 = times[i - 1];
    const span = times[ret] - t0;
    for (let j = i; j < ret; j++) {
      const frac = span > 0 ? (times[j] - t0) / span : 0;
      corrections.set(j, base + (alt[ret] - base) * frac);
    }
    i = ret + 1;
  }
  return corrections;
}

function expectCleanEquals(fixes: IGCFix[], expected: Map<number, number>, crossChecked: boolean) {
  const report = cleanAltitudes(fixes);
  expect(report.crossChecked).toBe(crossChecked);
  expect(report.repairedFixCount).toBe(expected.size);
  for (let i = 0; i < fixes.length; i++) {
    const want = expected.get(i);
    if (want === undefined) {
      expect(fixes[i].cleanedAltitude).toBeUndefined();
    } else {
      expect(Object.is(fixes[i].cleanedAltitude, want)).toBe(true);
    }
  }
}

describe('crossChannelClean is value-identical to the old sort-median loop', () => {
  it('random spikes and dropouts, 1 fix/s', () => {
    const rand = mulberry32(0x470a);
    const fixes: IGCFix[] = [];
    for (let t = 0; t < 2000; t++) {
      let gnss = 800 + Math.round(t * 0.5) + Math.round(rand() * 6 - 3);
      const roll = rand();
      if (roll < 0.02) gnss += Math.round(300 + rand() * 500); // multipath spike
      else if (roll < 0.03) gnss = 0; // dropout
      fixes.push(fixAt(t * 1000, gnss, 760 + Math.round(t * 0.5)));
    }
    expectCleanEquals(fixes, referenceCrossChannelCorrections(fixes), true);
  });

  it('duplicate-timestamp runs (a >1 Hz logger at the format 1 s resolution)', () => {
    const rand = mulberry32(0x470b);
    const fixes: IGCFix[] = [];
    let tMs = 0;
    for (let k = 0; k < 2000; k++) {
      if (rand() < 0.3) tMs += 1000; // ~3 fixes per stamped second
      let gnss = 1200 + Math.round(rand() * 8 - 4);
      if (rand() < 0.02) gnss += 400;
      fixes.push(fixAt(tMs, gnss, 1160 + Math.round(rand() * 4 - 2)));
    }
    expectCleanEquals(fixes, referenceCrossChannelCorrections(fixes), true);
  });

  it('dead-fix patterns: scattered zero channels feed NaN residuals', () => {
    const rand = mulberry32(0x470c);
    const fixes: IGCFix[] = [];
    for (let t = 0; t < 2000; t++) {
      let gnss = 900 + Math.round(rand() * 10 - 5);
      let baro = 860 + Math.round(rand() * 10 - 5);
      const roll = rand();
      if (roll < 0.1) gnss = 0;
      else if (roll < 0.2) baro = 0;
      else if (roll < 0.22) gnss += 500;
      fixes.push(fixAt(t * 1000, gnss, baro));
    }
    expectCleanEquals(fixes, referenceCrossChannelCorrections(fixes), true);
  });

  it('non-monotone timestamps that drive lo past hi', () => {
    // times (s): 0, 10, 500, 1000, 1001… — index 2 blocks hi (500 > 10+60)
    // until i=3 (t=1000) has already advanced lo past it (500 < 1000−60), so
    // lo overtakes hi mid-iteration. The old loop read an empty span; the
    // incremental median must skip the add and never remove index 2.
    const seconds = [0, 10, 500, 1000];
    for (let k = 1; k <= 120; k++) seconds.push(1000 + k);
    const rand = mulberry32(0x470d);
    const fixes = seconds.map((s, k) => {
      let gnss = 1000 + Math.round(rand() * 6 - 3);
      if (k === 60) gnss += 400;
      return fixAt(s * 1000, gnss, 960);
    });
    expectCleanEquals(fixes, referenceCrossChannelCorrections(fixes), true);
  });
});

describe('rateClean (single live channel)', () => {
  it('is value-identical on a duplicate-timestamp monotone track', () => {
    // 5000 fixes, ~50 per stamped second: dt > 0 only at second boundaries,
    // where the crafted excursions sit.
    const fixes: IGCFix[] = [];
    for (let k = 0; k < 5000; k++) {
      const sec = Math.floor(k / 50);
      let gnss = 1500;
      // An out-and-back excursion spanning seconds 40–41 (returns at 42).
      if (sec === 40 || sec === 41) gnss = 400;
      fixes.push(fixAt(sec * 1000, gnss, 0)); // baro channel dead
    }
    expectCleanEquals(fixes, referenceRateCorrections(fixes), false);
  });

  it('completes on backwards-jumping timestamps (scan bounded by the guard)', () => {
    // Alternating 0 s / 1 s stamps with a +200 m/fix ramp: every odd fix is an
    // implausible-rate trigger whose return-scan the old code ran to the end
    // of the file (the 30 s window never expires when time never advances) —
    // quadratic. The guard stops each scan at the first non-forward stamp.
    // Behaviour on these already-corrupt files intentionally differs from the
    // old unbounded scan; on any non-decreasing input the guard never fires
    // (see the value-identity case above).
    const fixes: IGCFix[] = [];
    for (let k = 0; k < 50_000; k++) {
      fixes.push(fixAt((k % 2) * 1000, 1000 + k * 200, 0));
    }
    const report = cleanAltitudes(fixes);
    expect(report.totalFixCount).toBe(50_000);
    expect(report.crossChecked).toBe(false);
  }, 20_000);
});

describe('degenerate-timestamp DoS regression (SEC-32)', () => {
  it('60k fixes on one timestamp: cleans in bounded time with exact repairs', () => {
    // Every window is the whole track; the old loop sorted a 60k-value
    // window 60k times (minutes of CPU). The rolling median is now
    // incremental, so this completes in well under the test timeout.
    const n = 60_000;
    const fixes: IGCFix[] = [];
    for (let k = 0; k < n; k++) {
      const spiked = k % 600 === 0; // 100 spiked fixes
      fixes.push(fixAt(0, spiked ? 1440 : 1040, 1000));
    }
    const report = cleanAltitudes(fixes);
    expect(report.crossChecked).toBe(true);
    // Median residual is 40; the spikes' residual of 440 deviates by 400.
    expect(report.repairedFixCount).toBe(100);
    expect(fixes[0].cleanedAltitude).toBe(1040);
  }, 20_000);

  it('a crafted same-second IGC file parses end-to-end in bounded time', () => {
    // The actual attack surface: parseIGC runs cleanAltitudes on every
    // upload. ~50k B-records all stamped 02:00:00, both channels alive.
    const lines = ['HFDTEDATE:100126'];
    for (let k = 0; k < 50_000; k++) {
      const baro = 1000 + (k % 40);
      const gnss = baro + 40;
      lines.push(
        `B0200003816800S14427600EA${String(baro).padStart(5, '0')}${String(gnss).padStart(5, '0')}`,
      );
    }
    const parsed = parseIGC(lines.join('\n'));
    expect(parsed.fixes.length).toBe(50_000);
    expect(parsed.altitudeCleaning.crossChecked).toBe(true);
  }, 20_000);
});
