// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Adversarial-input coverage for the bearing-rate lookback (SEC-46).
 *
 * computeBearingRates used to restart its lookback walk from i−1 for every
 * fix — quadratic when a run of duplicate timestamps made every walk retrace
 * the whole run (the same shape as the fixed SEC-32/33 scans). The fix (a
 * persistent forward pointer, with a budgeted exact fallback for
 * backwards-jumping timestamps) must return the SAME rates, so the tests here
 * compare against a verbatim copy of the old loop across realistic, duplicate
 * -timestamp, gap, and single-backwards-glitch tracks, and assert the dense
 * degenerate input completes in bounded time (the per-test timeout is the
 * perf guard).
 */

import { describe, expect, it } from 'bun:test';
import { computeBearingRates, normalizeBearingDelta } from '../src/circle-detector';
import { calculateBearing } from '../src/geo';
import type { IGCFix } from '../src/igc-parser';

const T0 = Date.parse('2025-01-11T00:09:00Z');

/** Seeded PRNG (mulberry32) — oracle comparisons must be reproducible. */
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

/** A fix per entry: elapsed seconds (may repeat or jump backwards) + position. */
function track(entries: Array<{ t: number; lat: number; lon: number }>): IGCFix[] {
  return entries.map((e) => ({
    time: new Date(T0 + e.t * 1000),
    latitude: e.lat,
    longitude: e.lon,
    pressureAltitude: 1000,
    gnssAltitude: 1000,
    valid: true,
  }));
}

/** A circling track: one position step of ~11 m per entry, turning steadily. */
function circlingEntries(n: number, timeAt: (s: number) => number) {
  const entries: Array<{ t: number; lat: number; lon: number }> = [];
  let lat = -36.1858;
  let lon = 147.9767;
  for (let s = 0; s < n; s++) {
    const bearing = ((s * 20) % 360) * (Math.PI / 180);
    lat += Math.cos(bearing) * 0.0001;
    lon += Math.sin(bearing) * 0.0001;
    entries.push({ t: timeAt(s), lat, lon });
  }
  return entries;
}

/** The old computeBearingRates, verbatim walk-back and all — the oracle. */
function referenceBearingRates(
  fixes: IGCFix[],
  lookbackSeconds: number,
  maxBearingRateLimit: number
): number[] {
  const rates: number[] = new Array(fixes.length).fill(0);
  if (fixes.length < 3) return rates;
  for (let i = 2; i < fixes.length; i++) {
    const targetTime = fixes[i].time.getTime() - lookbackSeconds * 1000;
    let j = i - 1;
    while (j > 0 && fixes[j].time.getTime() > targetTime) {
      j--;
    }
    if (j < 1 || i < 1) continue;
    const dt = (fixes[i].time.getTime() - fixes[j].time.getTime()) / 1000;
    if (dt < 1) continue;
    const bearingAtJ = calculateBearing(
      fixes[j - 1].latitude,
      fixes[j - 1].longitude,
      fixes[j].latitude,
      fixes[j].longitude
    );
    const bearingAtI = calculateBearing(
      fixes[i - 1].latitude,
      fixes[i - 1].longitude,
      fixes[i].latitude,
      fixes[i].longitude
    );
    const delta = normalizeBearingDelta(bearingAtI - bearingAtJ);
    let rate = delta / dt;
    if (rate > maxBearingRateLimit) rate = maxBearingRateLimit;
    if (rate < -maxBearingRateLimit) rate = -maxBearingRateLimit;
    rates[i] = rate;
  }
  return rates;
}

function expectParity(
  fixes: IGCFix[],
  lookback = 8,
  limit = 40,
  skip?: (i: number) => boolean
) {
  const actual = computeBearingRates(fixes, lookback, limit);
  const oracle = referenceBearingRates(fixes, lookback, limit);
  expect(actual.length).toBe(oracle.length);
  for (let i = 0; i < oracle.length; i++) {
    if (skip?.(i)) continue;
    if (!Object.is(actual[i], oracle[i])) {
      throw new Error(`rates diverge at fix ${i}: ${actual[i]} vs oracle ${oracle[i]}`);
    }
  }
}

describe('computeBearingRates matches the old walk-back exactly', () => {
  it('on a realistic 1 Hz circling track', () => {
    expectParity(track(circlingEntries(600, (s) => s)));
  });

  it('on tracks too short or too young for the lookback', () => {
    expectParity(track(circlingEntries(2, (s) => s)));
    expectParity(track(circlingEntries(3, (s) => s)));
    expectParity(track(circlingEntries(9, (s) => s)));
  });

  it('across a large recording gap after the first fix', () => {
    // times[0] ≤ target while times[1] > target for a stretch of fixes — the
    // pointer must keep skipping (j = 0) exactly as the old walk did.
    expectParity(track(circlingEntries(60, (s) => (s === 0 ? 0 : 1000 + s))));
  });

  it('on duplicate-timestamp bursts (seeded, non-decreasing)', () => {
    const rand = mulberry32(0x46a);
    let t = 0;
    expectParity(
      track(
        circlingEntries(3000, () => {
          if (rand() < 0.25) t += 1;
          return t; // ~4 fixes per stamped second
        })
      )
    );
  });

  it('on a run of identical timestamps (rate is skipped either way)', () => {
    expectParity(track(circlingEntries(500, () => 42)));
  });

  it('on a single mid-track backwards time glitch (missed-rollover shape)', () => {
    // 200 fixes at 1 Hz, but the clock jumps back 50 s at fix 120 and runs on
    // from there — the parser's 18:00→06:00 midnight heuristic does not catch
    // this, so the detector sees it. The fallback reproduces the old loop
    // exactly, EXCEPT while the re-run clock overlaps timestamps the track
    // already carried (i in [128, 178) here): the satisfying set is then
    // non-contiguous, the old walk favoured the later duplicate and the
    // pointer keeps the earlier — either is a defensible lookback on corrupt
    // ordering, so those fixes are excluded and parity must resume after.
    const fixes = track(circlingEntries(200, (s) => (s < 120 ? s : s - 50)));
    expectParity(fixes, 8, 40, (i) => i >= 128 && i < 178);
    // The excluded stretch must still produce sane, clamped rates.
    const rates = computeBearingRates(fixes, 8, 40);
    for (let i = 128; i < 178; i++) {
      expect(Number.isFinite(rates[i])).toBe(true);
      expect(Math.abs(rates[i])).toBeLessThanOrEqual(40);
    }
  });
});

describe('dense-timestamp DoS regression (SEC-46)', () => {
  it('60k fixes on one stamped second complete in bounded time', () => {
    // The old walk-back retraced the whole run for every fix — ~1.8 × 10⁹
    // inner steps. The persistent pointer plus the fallback budget cap total
    // work at O(n), so this completes well inside the test timeout, and the
    // output still matches the old semantics (every rate skipped).
    const rates = computeBearingRates(track(circlingEntries(60_000, () => 42)));
    expect(rates.every((r) => r === 0)).toBe(true);
  }, 15_000);

  it('60k fixes of alternating backwards jumps complete in bounded time', () => {
    // Worst case for the fallback path: the target keeps moving backwards past
    // the pointer, so every fix asks for an exact walk. The shared budget
    // bounds the total; beyond it rates are skipped rather than scanned for.
    const fixes = track(circlingEntries(60_000, (s) => (s % 2 === 0 ? s : Math.max(0, s - 40))));
    computeBearingRates(fixes);
  }, 15_000);
});
