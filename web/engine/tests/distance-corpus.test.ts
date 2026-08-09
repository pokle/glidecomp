/**
 * Distance-definition invariants over the real competition corpus.
 *
 * Two suites:
 *
 * 1. The bundled tasks (web/samples/comps — always present, runs in CI):
 *    the S7F §7.2 structural property on every task — the task path's
 *    launch→ESS prefix equals an independent launchToESS optimisation,
 *    which is what the §7.2 ESS pin guarantees by construction.
 *
 * 2. The archive back-catalogue (pokle/glidecomp-archive): the same
 *    invariant over every archived task, plus task-distance parity against
 *    the AirScore-published `task_dist` for the modern-generation comps
 *    (2025 onward — earlier years were scored by a legacy AirScore whose
 *    optimiser did not fully converge, did not pin the ESS, and measured
 *    an identical concentric ESS/goal to the goal CENTRE, so their
 *    published distances are not a reference for the current spec).
 *    Skipped silently when the archive is not checked out — point
 *    GLIDECOMP_COMPS_DIR at its comps/ directory (see the archive README).
 */

import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  calculateOptimizedTaskDistance,
  getOptimizedSegmentDistances,
} from '../src/task-optimizer';
import { parseXCTask, getESSIndex, type XCTask } from '../src/xctsk-parser';

const SAMPLES_ROOT = resolve(__dirname, '../../samples/comps');
const ARCHIVE_ROOT = process.env.GLIDECOMP_COMPS_DIR
  ? resolve(process.env.GLIDECOMP_COMPS_DIR)
  : resolve(__dirname, '../../../../glidecomp-archive/comps');

function taskDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => /-t\d+$/.test(d) && existsSync(join(root, d, 'task.xctsk')))
    .sort();
}

function loadTask(root: string, dir: string): XCTask | null {
  try {
    const task = parseXCTask(readFileSync(join(root, dir, 'task.xctsk'), 'utf-8'));
    return task.turnpoints.length >= 3 ? task : null;
  } catch {
    return null;
  }
}

/** §7.2: the task path's launch→ESS prefix must equal the independent
 * launchToESS optimisation — the property the ESS pin establishes. */
function assertPrefixMatchesIndependent(task: XCTask, label: string): void {
  const essIdx = getESSIndex(task);
  if (essIdx <= 0 || essIdx >= task.turnpoints.length - 1) return; // pin is a no-op
  const segs = getOptimizedSegmentDistances(task);
  let prefix = 0;
  for (let i = 0; i < essIdx; i++) prefix += segs[i];
  const independent = calculateOptimizedTaskDistance({
    ...task,
    turnpoints: task.turnpoints.slice(0, essIdx + 1),
    goal: undefined,
  });
  // Both are 1 m-tolerance iterative optimisations of the same route.
  expect(
    Math.abs(prefix - independent),
    `${label}: launch→ESS prefix ${prefix.toFixed(1)} vs independent ${independent.toFixed(1)}`,
  ).toBeLessThan(3);
}

describe('bundled tasks: §7.2 launch→ESS prefix equals its own optimisation', () => {
  for (const dir of taskDirs(SAMPLES_ROOT)) {
    it(dir, () => {
      const task = loadTask(SAMPLES_ROOT, dir);
      if (!task) return;
      assertPrefixMatchesIndependent(task, dir);
    });
  }
});

const archiveDirs = taskDirs(ARCHIVE_ROOT);

describe.if(archiveDirs.length > 0)('archive corpus (glidecomp-archive)', () => {
  it('every task satisfies the §7.2 prefix property', () => {
    let checked = 0;
    for (const dir of archiveDirs) {
      const task = loadTask(ARCHIVE_ROOT, dir);
      if (!task) continue;
      assertPrefixMatchesIndependent(task, dir);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('modern-generation comps (2025+): task distance matches the published task_dist', () => {
    // Known divergences, each understood — not silently absorbed into a
    // wider tolerance:
    const exceptions: Record<string, string> = {
      // The engine finds a shorter converged path than the legacy optimiser
      // published (its fixed-pass search did not converge on this
      // geometry); the per-waypoint cumulatives bracket the published ones.
      'forbes-flatlands-2025-open-t5': 'legacy optimiser convergence (engine 989 m shorter)',
      // Scored by legacy AirScore, which optimises the whole route globally
      // instead of pinning the ESS (§7.2): the engine matches the
      // published cumulatives to metres up to the ESS, then the pin
      // deliberately kinks the path (+403 m total). Same class of
      // divergence as forbes-flatlands-2025-open-t5. (Originally suspected
      // to be the issue-#577 ENTER-start geometry; the sweep that fixed
      // #577 showed it is not.)
      'dalby-big-air-2026-floater-t2': 'legacy optimiser does not pin the ESS (engine +403 m)',
      'forbes-flatlands-2026-open-t5': 'task.xctsk does not match the flown task (95 km apart)',
    };
    let checked = 0;
    const failures: string[] = [];
    for (const dir of archiveDirs) {
      const year = Number((dir.match(/-(20\d\d)-/) ?? [])[1] ?? 0);
      if (year < 2025) continue;
      if (exceptions[dir]) continue;
      const rawPath = join(ARCHIVE_ROOT, dir, 'airscore-result-raw.json');
      if (!existsSync(rawPath)) continue;
      const published = JSON.parse(readFileSync(rawPath, 'utf-8')).task?.task_dist;
      if (typeof published !== 'number' || published <= 0) continue;
      const task = loadTask(ARCHIVE_ROOT, dir);
      if (!task) continue;
      const engine = calculateOptimizedTaskDistance(task);
      const diff = engine - published * 1000;
      // Engine may be marginally SHORTER (it converges further than the
      // reference) but must never claim a longer task. The upper bound
      // allows the publication's quantisation: long tasks are published
      // with one decimal (half-ulp 50 m).
      const tolerance = Math.max(250, published * 1000 * 0.005);
      if (diff > 60 || diff < -tolerance) {
        failures.push(`${dir}: engine ${(engine / 1000).toFixed(3)} km vs published ${published} km (${diff.toFixed(0)} m)`);
      }
      checked++;
    }
    expect(failures, failures.join('\n')).toEqual([]);
    expect(checked).toBeGreaterThan(30);
  });
});
