/**
 * AirScore parity checks against real published results — one fixture per
 * formula generation the importer maps (see
 * docs/2026-07-21-airscore-history-import-plan.md, workstream 3).
 *
 * 1. Corryong Cup 2026 Task 1 (comPk=466, tasPk=2027) — a 33-pilot HG task
 *    scored with `gap-2021` (modern generation: 5/6 time-points curve).
 *    The published comp ran with departure (leading) OFF, so there are no
 *    reference leading points; the test validates the shared pipeline
 *    (validity, weights, distance/time points) against AirScore's real
 *    numbers and sanity-checks the weighted leadout ordering.
 *
 * 2. Corryong Cup 2021 Task 1 (comPk=305, tasPk=1340) — a 32-pilot HG task
 *    scored with `gap-2018` (pre-2020 generation: classic 2/3 curve,
 *    ESS-but-not-goal keeps 0%). Scored here under the importer-mapped
 *    parameters, proving the workstream-1 formula mapping reproduces the
 *    published points of the older generation.
 *
 * Sample IGC/xctsk and the AirScore references live in web/samples (both
 * task folders carry a `.curated` marker so re-downloads never overwrite
 * them).
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { scoreTask, type PilotFlight } from '../src/gap-scoring';

const COMP_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../samples/comps/corryong-cup-2026-open-t1',
);

interface RefPilot {
  surname: string; name: string; start: string | null;
  distKm: number; timePts: number; distPts: number; total: number;
}
const ref = JSON.parse(readFileSync(resolve(COMP_DIR, 'airscore-result.json'), 'utf8')) as {
  weights: { distance: number; time: number };
  pilots: RefPilot[];
};
const refBySurname = new Map(ref.pilots.map((p) => [p.surname, p]));

const task = parseXCTask(readFileSync(resolve(COMP_DIR, 'task.xctsk'), 'utf8'));

function loadPilots(): PilotFlight[] {
  // Read the committed IGC files named <surname>_<id>_<date>.igc.
  return readdirSync(COMP_DIR)
    .filter((f: string) => f.endsWith('.igc'))
    .map((f: string) => {
      const igc = parseIGC(readFileSync(resolve(COMP_DIR, f), 'utf8'));
      return { pilotName: f.split('_')[0].toLowerCase(), trackFile: f, fixes: igc.fixes };
    });
}

// AirScore formula for this comp: departure off, arrival off, HG, gap-2021.
const baseParams = {
  scoring: 'HG' as const,
  useArrival: false,
  nominalDistance: 35000,
  nominalGoal: 0.3,
  nominalTime: 5400,
  minimumDistance: 5000,
};

describe('AirScore parity — Corryong Cup 2026 T1', () => {
  const pilots = loadPilots();

  it('loaded all 33 tracks', () => {
    expect(pilots.length).toBe(33);
  });

  it('distance/time weights match AirScore (departure & arrival off)', () => {
    const r = scoreTask(task, pilots, { ...baseParams, useLeading: false });
    expect(r.weights.distance).toBeCloseTo(ref.weights.distance, 2); // 0.4928
    expect(r.weights.time).toBeCloseTo(ref.weights.time, 2); // 0.5072
    expect(r.weights.leading).toBe(0);
    expect(r.weights.arrival).toBe(0);
  });

  it('goal pilots get full distance points and the winner full time points', () => {
    const r = scoreTask(task, pilots, { ...baseParams, useLeading: false });
    const byName = new Map(r.pilotScores.map((p) => [p.pilotName, p]));

    // Every pilot we score as goal must get AirScore's full distance points.
    const fullDistancePts = ref.weights.distance * 1000; // 492.8
    for (const p of r.pilotScores) {
      if (p.madeGoal) {
        expect(Math.abs(p.distancePoints - fullDistancePts)).toBeLessThan(1.5);
      }
    }

    // Durand: fastest in goal → full distance AND full time points.
    const durand = byName.get('durand')!;
    expect(durand.madeGoal).toBe(true);
    expect(Math.abs(durand.distancePoints - refBySurname.get('durand')!.distPts)).toBeLessThan(1.5);
    expect(Math.abs(durand.timePoints - refBySurname.get('durand')!.timePts)).toBeLessThan(1.5);
  });

  it('HG distance difficulty (FAI S7F): goal pilots split 50/50, landed-out pilots get a difficulty share', () => {
    const r = scoreTask(task, pilots, { ...baseParams, useLeading: false });
    const byName = new Map(r.pilotScores.map((p) => [p.pilotName, p]));
    // Goal pilot: half linear + half difficulty, summing to the total.
    const durand = byName.get('durand')!;
    expect(durand.distanceLinearPoints).toBeCloseTo(durand.distancePoints / 2, 1);
    expect(durand.distanceDifficultyPoints).toBeCloseTo(durand.distancePoints / 2, 1);
    // A landed-out pilot gets a non-zero difficulty half, bounded by half-available.
    const carrigan = byName.get('carrigan')!;
    expect(carrigan.madeGoal).toBe(false);
    expect(carrigan.distanceDifficultyPoints).toBeGreaterThan(0);
    expect(carrigan.distanceDifficultyPoints).toBeLessThanOrEqual(r.availablePoints.distance / 2 + 0.1);
    // Difficulty disabled ⇒ pure linear (smaller, no difficulty half).
    const linear = scoreTask(task, pilots, { ...baseParams, useLeading: false, useDistanceDifficulty: false });
    const carrLinear = linear.pilotScores.find((p) => p.pilotName === 'carrigan')!;
    expect(carrLinear.distanceDifficultyPoints).toBe(0);
  });

  it('time points match AirScore for every ESS pilot (start gates + gap2020+ 5/6)', () => {
    const r = scoreTask(task, pilots, { ...baseParams, useLeading: false });
    // This task is a gated race (8 gates every 15 min). With speed-section
    // times running from each pilot's start gate (S7F §8.3.1/§8.7), every
    // ESS pilot's time points land within 0.2 of AirScore's published
    // numbers — before gate support this needed a 20-point tolerance.
    let checked = 0;
    for (const p of r.pilotScores) {
      if (!p.reachedESS) continue;
      const ref = refBySurname.get(p.pilotName);
      if (!ref) continue;
      expect(Math.abs(p.timePoints - ref.timePts)).toBeLessThan(0.2);
      checked++;
    }
    expect(checked).toBe(12);
  });

  it('every pilot takes the same start gate AirScore assigned', () => {
    const r = scoreTask(task, pilots, { ...baseParams, useLeading: false });
    // AirScore publishes local start times (UTC+11): 14:45 → 03:45Z (gate 2),
    // 15:00 → 04:00Z (gate 3), 15:30 → 04:30Z (gate 5).
    let checked = 0;
    for (const p of r.pilotScores) {
      const ref = refBySurname.get(p.pilotName);
      if (!ref?.start) continue;
      const gate = p.turnpointResult.startGate;
      expect(gate).toBeDefined();
      const [hh, mm] = ref.start.split(':').map(Number);
      const utc = `${String((hh - 11 + 24) % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
      expect(gate!.time.toISOString().slice(11, 19)).toBe(utc);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it('distance origin: take-off matches AirScore; start excludes the launch leg', () => {
    const takeoff = scoreTask(task, pilots, { ...baseParams, useLeading: false, distanceOrigin: 'takeoff' });
    const start = scoreTask(task, pilots, { ...baseParams, useLeading: false, distanceOrigin: 'start' });
    const durandKm = (r: ReturnType<typeof scoreTask>) =>
      r.pilotScores.find((p) => p.pilotName === 'durand')!.flownDistance / 1000;
    // A goal pilot flies the whole task: take-off origin ≈ 78.85 km (matching
    // AirScore's task distance), start origin ≈ 73.85 km (speed section only).
    expect(durandKm(takeoff)).toBeCloseTo(78.85, 1);
    expect(durandKm(start)).toBeCloseTo(73.85, 1);

    // In take-off mode, flown distances track AirScore's published km very
    // closely — best-progress measures to each cylinder's optimal tag point,
    // so non-goal pilots match to within a fraction of a km.
    const byName = new Map(takeoff.pilotScores.map((p) => [p.pilotName, p]));
    let sum = 0;
    let count = 0;
    for (const p of takeoff.pilotScores) {
      const ref = refBySurname.get(p.pilotName);
      if (!ref || ref.distKm >= 78.5 || p.flownDistance === baseParams.minimumDistance) continue;
      sum += Math.abs(p.flownDistance / 1000 - ref.distKm);
      count++;
    }
    expect(count).toBeGreaterThan(10);
    expect(sum / count).toBeLessThan(0.15); // mean within ~150 m of AirScore
    // A previously-divergent pilot now lands within a few hundred metres.
    const horton = byName.get('horton')!.flownDistance / 1000;
    expect(Math.abs(horton - refBySurname.get('horton')!.distKm)).toBeLessThan(0.5);
  });

  it('weighted leadout rewards early course-leaders over the faster late starter', () => {
    const r = scoreTask(task, pilots, { ...baseParams, useLeading: true, leadingFormula: 'weighted' });
    const byName = new Map(r.pilotScores.map((p) => [p.pilotName, p]));

    expect(r.availablePoints.leading).toBeGreaterThan(0);

    const durand = byName.get('durand')!;     // fastest, but started 15:30
    const holtkamp = byName.get('holtkamp')!;  // started 14:45 (early gate)
    const burkitt = byName.get('burkitt')!;    // started 14:45 (early gate)

    // All three made ESS with finite LCs.
    for (const p of [durand, holtkamp, burkitt]) {
      expect(p.reachedESS).toBe(true);
      expect(Number.isFinite(p.leadingCoefficient)).toBe(true);
    }
    // Leading out front early beats finishing fastest later.
    expect(holtkamp.leadingPoints).toBeGreaterThan(durand.leadingPoints);
    expect(burkitt.leadingPoints).toBeGreaterThan(durand.leadingPoints);
    expect(holtkamp.leadingCoefficient).toBeLessThan(durand.leadingCoefficient);
  });
});

// ---------------------------------------------------------------------------
// gap-2018 generation (Corryong Cup 2021 T1) — the pre-2020 formula the
// importer maps: classic 2/3 time-points curve, leading/arrival off,
// essNotGoalFactor 0 (goal_penalty "1").
// ---------------------------------------------------------------------------

const COMP_DIR_2021 = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../samples/comps/corryong-cup-2021-open-t1',
);

interface RefPilot2021 {
  surname: string; name: string; start: string | null; time: string | null;
  distKm: number | null; timePts: number; distPts: number; total: number;
}
const ref2021 = JSON.parse(
  readFileSync(resolve(COMP_DIR_2021, 'airscore-result.json'), 'utf8'),
) as {
  quality: { task: number; distance: number; time: number; launch: number };
  goal: number; launched: number;
  weights: { distance: number; time: number };
  pilots: RefPilot2021[];
};
// Two Atkinsons share the surname key; both are minimum-distance pilots with
// identical published points, so first-wins keying is safe for every
// assertion below.
const ref2021BySurname = new Map(ref2021.pilots.map((p) => [p.surname, p]));

const task2021 = parseXCTask(readFileSync(resolve(COMP_DIR_2021, 'task.xctsk'), 'utf8'));

function loadPilots2021(): PilotFlight[] {
  // Full surname key: strip the trailing _<id>_<DDMMYY>.igc so multi-word
  // surnames (de_vecchi) keep their whole key.
  return readdirSync(COMP_DIR_2021)
    .filter((f: string) => f.endsWith('.igc'))
    .map((f: string) => {
      const igc = parseIGC(readFileSync(resolve(COMP_DIR_2021, f), 'utf8'));
      return {
        pilotName: f.replace(/_\d+_\d{6}\.igc$/, ''),
        trackFile: f,
        fixes: igc.fixes,
      };
    });
}

// The importer-mapped parameters for this task (comp.json formula capture):
// gap-2018 → 2/3 exponent, departure/arrival off, goal_penalty 1 → keep 0%.
const params2021 = {
  scoring: 'HG' as const,
  useLeading: false,
  useArrival: false,
  timePointsExponent: '2/3' as const,
  essNotGoalFactor: 0,
  nominalDistance: 35000,
  nominalGoal: 0.3,
  nominalTime: 5400,
  minimumDistance: 5000,
};

describe('AirScore parity — Corryong Cup 2021 T1 (gap-2018 generation)', () => {
  const pilots = loadPilots2021();
  const r = scoreTask(task2021, pilots, params2021);

  // KNOWN DEVIATION (legacy AirScore, every pre-Python comp on the host):
  // Gap.pm feeds the SECOND-fastest ESS time ("tqtime") into time validity,
  // where the FAI spec (and this engine) uses the fastest. Published task
  // quality is therefore 0.978 (from Adriaans' 4743 s) vs our spec-correct
  // 0.9696 (from Wisewould's 4600 s), and every published point value is
  // scaled by that ratio. The per-pilot assertions below compare through
  // qualityRatio so everything else must match exactly.
  const qualityRatio = r.taskValidity.task / ref2021.quality.task;

  it('loaded all 32 tracks', () => {
    expect(pilots.length).toBe(32);
  });

  it('reproduces the published goal count; task validity differs only by the legacy second-fastest rule', () => {
    const goal = r.pilotScores.filter((p) => p.madeGoal).length;
    expect(goal).toBe(ref2021.goal); // 15 — including the two zero-time-point finishers
    expect(r.taskValidity.distance).toBeCloseTo(ref2021.quality.distance, 2);
    expect(r.taskValidity.launch).toBeCloseTo(ref2021.quality.launch, 2);
    // Our time validity from the fastest time (spec §9.3)…
    expect(r.taskValidity.time).toBeCloseTo(0.9696, 3);
    // …while the published 0.978 reproduces exactly from the second-fastest
    // ESS time (4743 s) through the same cubic — proving the divergence is
    // the legacy tqtime rule and nothing else.
    const x = 4743 / 5400;
    const legacyTime = -0.271 + 2.912 * x - 2.098 * x * x + 0.457 * x * x * x;
    expect(legacyTime).toBeCloseTo(ref2021.quality.time, 3);
  });

  it('distance/time weights match the published goal ratio (leading & arrival off)', () => {
    expect(r.weights.distance).toBeCloseTo(ref2021.weights.distance, 3); // 0.4355
    expect(r.weights.time).toBeCloseTo(ref2021.weights.time, 3);
    expect(r.weights.leading).toBe(0);
    expect(r.weights.arrival).toBe(0);
  });

  it('goal pilots get AirScore\'s full distance points (quality-scaled)', () => {
    let checked = 0;
    for (const p of r.pilotScores) {
      if (!p.madeGoal) continue;
      const ref = ref2021BySurname.get(p.pilotName);
      if (!ref) continue;
      expect(Math.abs(p.distancePoints - ref.distPts * qualityRatio)).toBeLessThan(0.5);
      checked++;
    }
    expect(checked).toBe(15);
  });

  it('time points match AirScore for every ESS pilot under the classic 2/3 curve', () => {
    // The generation's distinguishing curve: 1 − (Δt/√Tmin)^(2/3) in hours.
    // Under the modern 5/6 curve the runner-up (Adriaans) would score ~518,
    // not the published 492.8. Divito and Pokle are goal pilots whose slow
    // times clamp the curve to 0 — also part of the reference.
    let checked = 0;
    for (const p of r.pilotScores) {
      if (!p.reachedESS) continue;
      const ref = ref2021BySurname.get(p.pilotName);
      if (!ref) continue;
      expect(Math.abs(p.timePoints - ref.timePts * qualityRatio)).toBeLessThan(1);
      checked++;
    }
    expect(checked).toBe(15);
  });

  it('goal-pilot totals match within a point (quality-scaled)', () => {
    let checked = 0;
    for (const p of r.pilotScores) {
      if (!p.madeGoal) continue;
      const ref = ref2021BySurname.get(p.pilotName);
      if (!ref) continue;
      expect(Math.abs(p.totalScore - ref.total * qualityRatio)).toBeLessThan(1.5);
      checked++;
    }
    expect(checked).toBe(15);
  });

  it('landed-out totals track AirScore, with the legacy difficulty curve as the only gap', () => {
    // KNOWN DEVIATION: legacy Gap.pm's km-difficulty (calc_kmdiff) counts
    // each pilot a full look-ahead BEFORE their landing slot and normalises
    // by the landed-out count, which is systematically more generous low
    // down than the S7F 2024 §11.1.1 construction this engine implements —
    // e.g. the eight minimum-distance pilots publish 120.8 where the
    // spec-2024 curve gives ~92. The gap shrinks with distance (Halsall,
    // best landed-out, is within ~3 points scaled). Bounded here so a
    // regression can't hide behind the documented difference.
    let maxGap = 0;
    let checked = 0;
    for (const p of r.pilotScores) {
      if (p.madeGoal) continue;
      const ref = ref2021BySurname.get(p.pilotName);
      if (!ref) continue;
      const gap = Math.abs(p.totalScore - ref.total * qualityRatio);
      maxGap = Math.max(maxGap, gap);
      expect(gap).toBeLessThan(30);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(16);
    expect(maxGap).toBeGreaterThan(5); // the deviation is real — see above
  });

  it('under the modern 5/6 exponent the runner-up would score visibly differently (regression guard)', () => {
    const modern = scoreTask(task2021, pilots, { ...params2021, timePointsExponent: '5/6' as const });
    const adriaans = modern.pilotScores.find((p) => p.pilotName === 'adriaans')!;
    const refAdriaans = ref2021BySurname.get('adriaans')!;
    // 5/6 is ~25 points more generous here — proving the fixture really
    // pins the 2/3 generation.
    expect(adriaans.timePoints - refAdriaans.timePts * qualityRatio).toBeGreaterThan(10);
  });
});
