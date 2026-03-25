/**
 * Integration test: scores real IGC tracks from Corryong Cup 2026 Task 1
 * against the actual task file and verifies results match expected snapshots.
 *
 * Reference: https://xc.highcloud.net/task_result.html?comPk=466&tasPk=2027
 *
 * Note: Our task distance (73.9 km) differs from Airscore's (78.85 km) due to
 * different optimized-path algorithms. Scores here are our internally-consistent
 * values, not Airscore's. The test guards against regressions in the full
 * pipeline: IGC parsing → turnpoint sequence → GAP scoring.
 */

import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { scoreTask, type PilotFlight } from '../src/gap-scoring';
import { resolveCompDir } from '@glidecomp/samples/node';

const FIXTURES_DIR = resolveCompDir('corryong-cup-2026-t1');

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
    'Rory Duncan',
    'Vic Hare',
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
    // First 20 are in strict order
    expect(rankedNames.slice(0, 20)).toEqual(expectedRankOrder.slice(0, 20));

    // Hooke and Halsall are tied at rank 21
    const tied21 = new Set(rankedNames.slice(20, 22));
    expect(tied21).toEqual(new Set(['Neil Hooke', 'Neale Halsall']));

    // Remaining ranked pilots (23-28)
    expect(rankedNames.slice(22, 28)).toEqual(expectedRankOrder.slice(22));

    // Last 4 are tied at rank 29
    const tiedPilots = new Set(rankedNames.slice(28));
    expect(tiedPilots).toEqual(new Set([
      'Rennick Kerr', 'Stuart McElroy', 'Daniel Rhodes', 'Ivo van der Leeden',
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
    // Leading — goal finishers
    { name: 'Jon Durand',        rank: 1,  total: 1000, distPts: 485.6, timePts: 514.4, madeGoal: true },
    { name: 'Rohan Holtkamp',    rank: 2,  total: 872,  distPts: 485.6, timePts: 386.9, madeGoal: true },
    { name: 'Peter  Burkitt',    rank: 3,  total: 844,  distPts: 485.6, timePts: 358.9, madeGoal: true },

    // Mid-pack — goal finishers
    { name: 'Glen Mcfarlane',    rank: 5,  total: 624,  distPts: 485.6, timePts: 138.5, madeGoal: true },
    { name: 'Todd Wisewould',    rank: 10, total: 515,  distPts: 485.6, timePts: 29.6,  madeGoal: true },
    { name: 'Craig Taylor',      rank: 12, total: 486,  distPts: 485.6, timePts: 0,     madeGoal: true },

    // First non-goal pilot
    { name: 'Rich Reinauer',     rank: 13, total: 473,  distPts: 473.1, timePts: 0, madeGoal: false },

    // Mid-pack — non-goal
    { name: 'Steve Blenkinsop',  rank: 17, total: 308,  distPts: 308.5, timePts: 0, madeGoal: false },
    { name: 'Neale Halsall',     rank: 21, total: 164,  distPts: 163.5, timePts: 0, madeGoal: false },

    // Trailing — at minimum distance floor
    { name: 'Rennick Kerr',     rank: 29, total: 33,  distPts: 32.9, timePts: 0, madeGoal: false },
    { name: 'Ivo van der Leeden', rank: 29, total: 33, distPts: 32.9, timePts: 0, madeGoal: false },
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
    // Kerr (1.6km actual), McElroy (0), Ivo (0), Rhodes (negative)
    expect(minDistPilots.length).toBe(4);
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
