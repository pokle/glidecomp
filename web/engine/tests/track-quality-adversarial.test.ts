// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Adversarial-input coverage for the never-airborne check (issue #471,
 * SEC-33).
 *
 * The S2 sustained-glide loop used to rescan its whole window per fix for the
 * minimum instantaneous speed — quadratic when dense duplicate timestamps
 * pack tens of thousands of fixes into one 90 s window. The fix (a monotone
 * deque) must return the SAME minimum over the same (lo, i] window, so the
 * tests here pin the window's boundary semantics with single-slow-fix tracks,
 * compare the reported evidence against a verbatim copy of the old scan on a
 * duplicate-timestamp track, and assert the dense degenerate input completes
 * in bounded time (the per-test timeout is the perf guard).
 */

import { describe, expect, it } from 'bun:test';
import { assessTrackQuality } from '../src/track-quality';
import type { TrackQualityCheckId, TrackQualityReport } from '../src/track-quality';
import { fixAltitude, type IGCFix } from '../src/igc-parser';
import { ellipsoidDistance, destinationPoint } from '../src/geo';
import type { XCTask } from '../src/xctsk-parser';

// Constants copied from track-quality.ts — the oracle must match the old
// code exactly, not track future tuning.
const AIRBORNE_CLIMB_MS = 1.5;
const AIRBORNE_CLIMB_SECONDS = 120;
const AIRBORNE_GLIDE_SECONDS = 90;
const AIRBORNE_GLIDE_SINK_MS = 0.8;
const AIRBORNE_GLIDE_MIN_SPEED_MS = 4;
const AIRBORNE_GLIDE_STRAIGHTNESS = 0.55;

const LAUNCH = { lat: -36.185833, lon: 147.976667 }; // ELLIOT, Corryong

function launchTask(): XCTask {
  return {
    taskType: 'CLASSIC',
    version: 1,
    earthModel: 'WGS84',
    turnpoints: [
      {
        type: 'TAKEOFF',
        radius: 1000,
        waypoint: { name: 'ELLIOT', lat: LAUNCH.lat, lon: LAUNCH.lon },
      },
    ],
    sss: { type: 'RACE', direction: 'EXIT' },
    goal: { type: 'CYLINDER' },
  };
}

const CONTEXT = {
  task: launchTask(),
  taskDate: '2025-01-11',
  timeZone: 'Australia/Melbourne',
  category: 'hg' as const,
};
const HEADER = { date: new Date('2025-01-11T00:00:00Z') };
const START_ISO = '2025-01-11T00:09:00Z';

function fired(report: TrackQualityReport, id: TrackQualityCheckId): boolean {
  return report.findings.some((f) => f.id === id);
}

function neverAirborneEvidence(report: TrackQualityReport) {
  const finding = report.findings.find((f) => f.id === 'never-airborne');
  if (finding?.evidence.id !== 'never-airborne') throw new Error('never-airborne did not fire');
  return finding.evidence;
}

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

/**
 * A track built from explicit per-fix ground steps: fix s sits `stepMeters
 * [s-1]` beyond fix s-1 along `bearingAt(s)`, `dtSeconds[s-1]` later (so
 * duplicate timestamps are expressible). One fix per entry plus the start.
 */
function stepTrack(opts: {
  stepMeters: number[];
  dtSeconds?: number[];
  altAt: (s: number, elapsed: number) => number;
  bearingAt?: (s: number) => number;
}): IGCFix[] {
  const { stepMeters, dtSeconds, altAt, bearingAt = () => 0 } = opts;
  const t0 = Date.parse(START_ISO);
  const fixes: IGCFix[] = [];
  let lat = LAUNCH.lat;
  let lon = LAUNCH.lon;
  let elapsed = 0;
  for (let s = 0; s <= stepMeters.length; s++) {
    if (s > 0) {
      const p = destinationPoint(lat, lon, stepMeters[s - 1], (bearingAt(s) * Math.PI) / 180);
      lat = p.lat;
      lon = p.lon;
      elapsed += dtSeconds ? dtSeconds[s - 1] : 1;
    }
    const alt = altAt(s, elapsed);
    fixes.push({
      time: new Date(t0 + elapsed * 1000),
      latitude: lat,
      longitude: lon,
      pressureAltitude: alt,
      gnssAltitude: alt,
      valid: true,
    });
  }
  return fixes;
}

/** The old checkNeverAirborne S1+S2 loops, verbatim scan and all — the
 * oracle for the reported evidence values. */
function referenceEvidence(fixes: IGCFix[]) {
  const n = fixes.length;
  const times = fixes.map((f) => f.time.getTime());
  const altitudes = fixes.map(fixAltitude);
  const pathLength = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    pathLength[i] =
      pathLength[i - 1] +
      ellipsoidDistance(
        fixes[i - 1].latitude,
        fixes[i - 1].longitude,
        fixes[i].latitude,
        fixes[i].longitude
      );
  }
  const speed = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dt = (times[i] - times[i - 1]) / 1000;
    speed[i] = dt > 0 ? (pathLength[i] - pathLength[i - 1]) / dt : 0;
  }
  if (n > 1) speed[0] = speed[1];

  let bestClimb = -Infinity;
  let bestGlideSink = -Infinity;
  let bestGlideMinSpeed = 0;
  let bestGlideStraightness = 0;
  let glideFound = false;

  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && (times[i] - times[lo]) / 1000 > AIRBORNE_CLIMB_SECONDS) lo++;
    if (lo === 0 && (times[i] - times[0]) / 1000 < AIRBORNE_CLIMB_SECONDS) continue;
    const seconds = (times[i] - times[lo]) / 1000;
    if (seconds < AIRBORNE_CLIMB_SECONDS) continue;
    const rate = (altitudes[i] - altitudes[lo]) / seconds;
    if (rate > bestClimb) bestClimb = rate;
  }

  lo = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && (times[i] - times[lo]) / 1000 > AIRBORNE_GLIDE_SECONDS) lo++;
    const seconds = (times[i] - times[lo]) / 1000;
    if (seconds < AIRBORNE_GLIDE_SECONDS) continue;
    const sink = (altitudes[lo] - altitudes[i]) / seconds;
    let minSpeed = Infinity;
    for (let j = lo + 1; j <= i; j++) if (speed[j] < minSpeed) minSpeed = speed[j];
    const path = pathLength[i] - pathLength[lo];
    const displacement = ellipsoidDistance(
      fixes[lo].latitude,
      fixes[lo].longitude,
      fixes[i].latitude,
      fixes[i].longitude
    );
    const straightness = path > 0 ? displacement / path : 0;
    if (sink > bestGlideSink) {
      bestGlideSink = sink;
      bestGlideMinSpeed = minSpeed === Infinity ? 0 : minSpeed;
      bestGlideStraightness = straightness;
    }
    if (
      sink >= AIRBORNE_GLIDE_SINK_MS &&
      minSpeed >= AIRBORNE_GLIDE_MIN_SPEED_MS &&
      straightness >= AIRBORNE_GLIDE_STRAIGHTNESS
    ) {
      glideFound = true;
      break;
    }
  }

  return {
    glideFound,
    bestSustainedClimbMs: Number.isFinite(bestClimb) ? bestClimb : 0,
    bestGlideSinkMs: Number.isFinite(bestGlideSink) ? bestGlideSink : 0,
    bestGlideMinSpeedMs: bestGlideMinSpeed,
    bestGlideStraightness,
  };
}

describe('never-airborne S2 window boundary (the deque must match (lo, i])', () => {
  // A 1 m/s straight descent at 11 m/s with ONE 2 m step. Whether that slow
  // step falls inside a qualifying 90 s window decides the whole check.
  const steadyAlt = (s: number) => 1000 - s;

  it('a slow step the window has slid past no longer vetoes the glide', () => {
    // 92 fixes: the only slow step is into fix 1. At i=90 (window (0,90]) it
    // vetoes; at i=91, lo=1 and the window (1,91] excludes speed[1] — the
    // glide is found and the finding must NOT fire. A deque that failed to
    // evict indices ≤ lo would keep vetoing.
    const steps = Array(91).fill(11);
    steps[0] = 2;
    const fixes = stepTrack({ stepMeters: steps, altAt: steadyAlt });
    const report = assessTrackQuality(fixes, HEADER, CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(false);
  });

  it('a slow step at the window start (index lo+1) vetoes the glide', () => {
    // 91 fixes: only i=90 qualifies, window (0,90], slow speed[1] included.
    const steps = Array(90).fill(11);
    steps[0] = 2;
    const fixes = stepTrack({ stepMeters: steps, altAt: steadyAlt });
    const report = assessTrackQuality(fixes, HEADER, CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(true);
    const evidence = neverAirborneEvidence(report);
    expect(evidence.bestGlideMinSpeedMs).toBeLessThan(AIRBORNE_GLIDE_MIN_SPEED_MS);
    expect(evidence.bestGlideMinSpeedMs).toBeCloseTo(2, 2);
  });

  it('a slow step at the window end (index i) vetoes the glide', () => {
    const steps = Array(90).fill(11);
    steps[89] = 2;
    const fixes = stepTrack({ stepMeters: steps, altAt: steadyAlt });
    const report = assessTrackQuality(fixes, HEADER, CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(true);
    expect(neverAirborneEvidence(report).bestGlideMinSpeedMs).toBeCloseTo(2, 2);
  });

  it('duplicate-timestamp track reports evidence identical to the old scan', () => {
    // ~4 fixes per stamped second, wandering bearing, gentle 0.2 m/s descent
    // with noise: no climb, no qualifying glide (duplicate steps read as
    // 0 m/s), so the finding fires and every evidence number must equal the
    // old rescanning loop's output bit-for-bit.
    const rand = mulberry32(0x471a);
    const n = 3000;
    const steps: number[] = [];
    const dts: number[] = [];
    for (let s = 0; s < n; s++) {
      steps.push(rand() * 13);
      dts.push(rand() < 0.25 ? 1 : 0);
    }
    const fixes = stepTrack({
      stepMeters: steps,
      dtSeconds: dts,
      altAt: (s, elapsed) => 1000 - elapsed * 0.2 + (rand() - 0.5) * 4,
      bearingAt: (s) => (s * 7) % 360,
    });
    const report = assessTrackQuality(fixes, HEADER, CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(true);
    const evidence = neverAirborneEvidence(report);
    const oracle = referenceEvidence(fixes);
    expect(oracle.glideFound).toBe(false);
    expect(Object.is(evidence.bestSustainedClimbMs, oracle.bestSustainedClimbMs)).toBe(true);
    expect(Object.is(evidence.bestGlideSinkMs, oracle.bestGlideSinkMs)).toBe(true);
    expect(Object.is(evidence.bestGlideMinSpeedMs, oracle.bestGlideMinSpeedMs)).toBe(true);
    expect(Object.is(evidence.bestGlideStraightness, oracle.bestGlideStraightness)).toBe(true);
  });
});

describe('dense-timestamp DoS regression (SEC-33)', () => {
  it('57k fixes in a 180 s span assess in bounded time', () => {
    // Every qualifying 90 s window holds ~28k fixes; the old inner rescan did
    // ~8×10⁸ operations here. The deque pushes and evicts each fix at most
    // once, so this completes in well under the test timeout.
    const n = 57_000;
    const period = Math.ceil(n / 180); // one stamped second per ~317 fixes
    const steps: number[] = [];
    const dts: number[] = [];
    for (let s = 0; s < n; s++) {
      steps.push(7);
      dts.push(s % period === period - 1 ? 1 : 0);
    }
    const fixes = stepTrack({
      stepMeters: steps,
      dtSeconds: dts,
      altAt: (s, elapsed) => 1000 - elapsed * 0.2,
      bearingAt: (s) => (s * 11) % 360,
    });
    const report = assessTrackQuality(fixes, HEADER, CONTEXT);
    expect(fired(report, 'never-airborne')).toBe(true);
  }, 15_000);
});
