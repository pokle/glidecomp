/**
 * AirScore parity check against real published results.
 *
 * Corryong Cup 2026 Task 1 (xc.highcloud.net comPk=466, tasPk=2027) — a
 * 33-pilot HG task scored by AirScore with `gap-2021` (the `weighted`
 * leading formula). The published comp ran with departure (leading) OFF,
 * so there are no reference leading points; this test therefore:
 *
 *  1. validates the shared pipeline (validity, weights, distance/time
 *     points) against AirScore's real numbers — these feed the LC, so a
 *     match gives indirect confidence in the LC inputs, and
 *  2. sanity-checks that our `weighted` leadout ranks early course-leaders
 *     above a faster-but-later finisher, as AirScore's weighted leadout does.
 *
 * Sample IGC/xctsk and the AirScore reference live in web/samples.
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
  '../../samples/comps/corryong-cup-2026-t1',
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

  it('time points track AirScore for the leading goal finishers (gap2020+ 5/6)', () => {
    const r = scoreTask(task, pilots, { ...baseParams, useLeading: false });
    const byName = new Map(r.pilotScores.map((p) => [p.pilotName, p]));
    // The 5/6 speed formula puts the top goal pilots within a handful of
    // points of AirScore (vs ~30+ off under the old 2/3 + sqrt-bug form).
    // A residual remains for slower pilots because this task uses interval
    // start gates and our speed-section time differs there — a separate,
    // out-of-scope pipeline detail.
    for (const surname of ['holtkamp', 'burkitt', 'opsanger']) {
      const ours = byName.get(surname)!;
      const ref = refBySurname.get(surname)!;
      expect(Math.abs(ours.timePoints - ref.timePts)).toBeLessThan(20);
    }
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

    // In take-off mode, flown distances track AirScore's published km closely.
    const byName = new Map(takeoff.pilotScores.map((p) => [p.pilotName, p]));
    for (const surname of ['reinauer', 'carrigan', 'drabble']) {
      const ours = byName.get(surname)!.flownDistance / 1000;
      const ref = refBySurname.get(surname)!.distKm;
      expect(Math.abs(ours - ref)).toBeLessThan(1.0);
    }
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
