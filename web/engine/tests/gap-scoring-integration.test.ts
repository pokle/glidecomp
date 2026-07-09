/**
 * Integration test: scores real IGC tracks from Corryong Cup 2026 Task 1
 * against the actual task file and verifies results match expected snapshots.
 *
 * Reference: https://xc.highcloud.net/task_result.html?comPk=466&tasPk=2027
 *
 * The committed task.xctsk is the full task including the takeoff cylinder,
 * so with the default 'takeoff' distance origin our optimized task distance
 * (78.85 km) matches AirScore's. Distance (incl. the HG difficulty half,
 * FAI S7F §11.1.1), time and leading points all follow the CIVL GAP
 * formulas. Exact distance *points* for non-goal pilots can still differ
 * from AirScore because per-pilot flown distances aren't bit-identical
 * (optimizer detail), not because of the formula. The snapshot values below
 * are our own output — this test guards against regressions in the full
 * pipeline: IGC parsing → turnpoint sequence → GAP scoring.
 */

import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { scoreTask, type PilotFlight } from '../src/gap-scoring';
import { resolveCompDir } from '@glidecomp/samples/node';

const FIXTURES_DIR = resolveCompDir('corryong-cup-2026-open-t1');

function loadTask() {
  const taskContent = readFileSync(resolve(FIXTURES_DIR, 'task.xctsk'), 'utf-8');
  return parseXCTask(taskContent);
}

function loadPilots(): PilotFlight[] {
  const pilots: PilotFlight[] = [];
  const files = readdirSync(FIXTURES_DIR)
    .filter(f => extname(f).toLowerCase() === '.igc')
    .sort();

  for (const file of files) {
    const igcPath = resolve(FIXTURES_DIR, file);
    const igc = parseIGC(readFileSync(igcPath, 'utf-8'));
    if (igc.fixes.length === 0) continue;
    const pilotName = igc.header.pilot || igc.header.competitionId || basename(file, '.igc');
    pilots.push({ pilotName, trackFile: igcPath, fixes: igc.fixes });
  }
  return pilots;
}

// Competition parameters matching the Corryong Cup 2026 Open config
const COMP_PARAMS = {
  scoring: 'HG' as const,
  useLeading: false,
  useArrival: false,
  nominalDistance: 35000,
  nominalGoal: 0.3,
  nominalTime: 5400,
  minimumDistance: 5000,
};

describe('Corryong Cup 2026 Task 1 — integration', () => {
  const task = loadTask();
  const pilots = loadPilots();
  const result = scoreTask(task, pilots, COMP_PARAMS);

  // -------------------------------------------------------------------------
  // Aggregate stats
  // -------------------------------------------------------------------------

  it('parses the expected number of pilots', () => {
    // 33 IGC files, 1 has no fixes (lamb), so 32 scored
    expect(result.stats.numFlying).toBe(32);
  });

  it('identifies correct number of goal/ESS pilots', () => {
    expect(result.stats.numInGoal).toBe(12);
    expect(result.stats.numReachedESS).toBe(12);
  });

  it('has full task validity', () => {
    expect(result.taskValidity.task).toBeCloseTo(1.0, 2);
    expect(result.taskValidity.launch).toBeCloseTo(1.0, 2);
    expect(result.taskValidity.distance).toBeCloseTo(1.0, 2);
    expect(result.taskValidity.time).toBeCloseTo(1.0, 2);
  });

  it('has correct weight distribution (no leading, no arrival)', () => {
    expect(result.weights.leading).toBe(0);
    expect(result.weights.arrival).toBe(0);
    expect(result.weights.distance + result.weights.time).toBeCloseTo(1, 5);
  });

  // -------------------------------------------------------------------------
  // Ranking order (must match exactly)
  // -------------------------------------------------------------------------

  const expectedRankOrder = [
    'Jon Durand',
    'Rohan Holtkamp',
    'Peter  Burkitt',
    'Olav Opsanger',
    'Glen Mcfarlane',
    'Paul Bissett-Amess',
    'Steven Crosby',
    'Vic Hare',
    'Rory Duncan',
    'Todd Wisewould',
    'Gordon Rigg',
    'Craig Taylor',
    'Rich Reinauer',
    'Enda Carrigan',
    'Troy Horton',
    'Mitch Butler',
    'Steve Blenkinsop',
    'David Drabble',
    'John Harriott',
    'Nils Vesk',
    'Neil Hooke',
    'Neale Halsall',
    'Harrison Rowntree',
    'Ward Gunn',
    'Trent Brown',
    'Andrew Sutton',
    'Hossain Tefaili',
    'Gary Herman',
  ];

  it('ranks all pilots in the correct order', () => {
    const rankedNames = result.pilotScores.map(p => p.pilotName);
    // Ranks 1–28 are in strict order
    expect(rankedNames.slice(0, 28)).toEqual(expectedRankOrder);

    // Rank 29
    expect(rankedNames[28]).toBe('Rennick Kerr');

    // Last 3 are tied at rank 30 (minimum distance floor)
    const tied30 = new Set(rankedNames.slice(29));
    expect(tied30).toEqual(new Set([
      'Stuart McElroy', 'Daniel Rhodes', 'Ivo van der Leeden',
    ]));
  });

  // -------------------------------------------------------------------------
  // Individual pilot score snapshots — leading, mid, trailing
  // -------------------------------------------------------------------------

  /**
   * Snapshot format: [name, rank, totalScore, distPts, timePts, madeGoal]
   * Covers:
   *  - Top 3 (leading)
   *  - Mid-pack goal finishers (#5, #10, #12)
   *  - First non-goal (#13)
   *  - Mid-pack non-goal (#17, #22)
   *  - Trailing pilots at minimum distance (#29 tied)
   */
  const snapshots: Array<{
    name: string;
    rank: number;
    total: number;
    distPts: number;
    timePts: number;
    madeGoal: boolean;
  }> = [
    // Leading — goal finishers. This task is a gated race (8 start gates
    // every 15 min), so speed-section times run from each pilot's start
    // gate (S7F §8.3.1/§8.7) — these totals track AirScore's published
    // results (Holtkamp 907, Burkitt 890 there; ±1–2 pts here from the
    // different launch-validity denominator and difficulty residuals).
    // Totals are rounded to one decimal place per S7F §11.
    { name: 'Jon Durand',        rank: 1,  total: 1000,  distPts: 485.6, timePts: 514.4, madeGoal: true },
    { name: 'Rohan Holtkamp',    rank: 2,  total: 905.6, distPts: 485.6, timePts: 420.1, madeGoal: true },
    { name: 'Peter  Burkitt',    rank: 3,  total: 887.9, distPts: 485.6, timePts: 402.4, madeGoal: true },

    // Mid-pack — goal finishers
    { name: 'Glen Mcfarlane',    rank: 5,  total: 670.7, distPts: 485.6, timePts: 185.2, madeGoal: true },
    { name: 'Todd Wisewould',    rank: 10, total: 545.5, distPts: 485.6, timePts: 59.9,  madeGoal: true },
    { name: 'Craig Taylor',      rank: 12, total: 485.6, distPts: 485.6, timePts: 0,     madeGoal: true },

    // First non-goal pilot (distance points now include the HG difficulty half)
    { name: 'Rich Reinauer',     rank: 13, total: 479.7, distPts: 479.7, timePts: 0, madeGoal: false },

    // Mid-pack — non-goal
    { name: 'Steve Blenkinsop',  rank: 17, total: 358.8, distPts: 358.8, timePts: 0, madeGoal: false },
    { name: 'Neale Halsall',     rank: 22, total: 237.4, distPts: 237.4, timePts: 0, madeGoal: false },

    // Trailing — at minimum distance floor (tied at rank 30)
    { name: 'Ivo van der Leeden', rank: 30, total: 41.8, distPts: 41.8, timePts: 0, madeGoal: false },
  ];

  for (const snap of snapshots) {
    it(`${snap.name}: rank ${snap.rank}, total ${snap.total}`, () => {
      const pilot = result.pilotScores.find(p => p.pilotName === snap.name);
      expect(pilot).toBeDefined();
      expect(pilot!.rank).toBe(snap.rank);
      expect(pilot!.totalScore).toBe(snap.total);
      expect(pilot!.distancePoints).toBe(snap.distPts);
      expect(pilot!.timePoints).toBe(snap.timePts);
      expect(pilot!.madeGoal).toBe(snap.madeGoal);
    });
  }

  // -------------------------------------------------------------------------
  // Minimum distance enforcement
  // -------------------------------------------------------------------------

  it('all pilots have non-negative scores', () => {
    for (const p of result.pilotScores) {
      expect(p.totalScore).toBeGreaterThanOrEqual(0);
      expect(p.flownDistance).toBeGreaterThanOrEqual(0);
    }
  });

  it('pilots below minimum distance are scored at minimum distance', () => {
    const minDistPilots = result.pilotScores.filter(p =>
      p.flownDistance === COMP_PARAMS.minimumDistance
    );
    // McElroy (0), Rhodes (negative), Ivo (0). With the take-off origin
    // Kerr's flown distance (~6.5 km) now clears the 5 km floor.
    expect(minDistPilots.length).toBe(3);
    for (const p of minDistPilots) {
      expect(p.flownDistance).toBe(5000);
      expect(p.distancePoints).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Leading and arrival disabled
  // -------------------------------------------------------------------------

  it('no pilot has leading or arrival points', () => {
    for (const p of result.pilotScores) {
      expect(p.leadingPoints).toBe(0);
      expect(p.arrivalPoints).toBe(0);
    }
  });
});
