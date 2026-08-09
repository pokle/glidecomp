// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Did a scoring change move anyone's points?
 *
 * Scores every task of every comp in a comps tree and dumps the numbers a
 * formula change can move — the weight split, the available points, and each
 * pilot's four components and total. Point it at the 211-comp archive
 * (pokle/glidecomp-archive) to answer the question over real competitions
 * rather than fixtures.
 *
 * Run it on both sides of a scoring change and diff the two JSON files: that
 * is the evidence that a "no pilot's points change" claim is true, and the
 * measurement of the ones that do.
 *
 *   GLIDECOMP_COMPS_DIR=<archive>/comps bun web/scripts/audit-scoring-change.ts > before.json
 *   # …apply the change…
 *   GLIDECOMP_COMPS_DIR=<archive>/comps bun web/scripts/audit-scoring-change.ts > after.json
 *   bun web/scripts/audit-scoring-change.ts --diff before.json after.json
 *
 * Parameter resolution deliberately mirrors geometryFromRow in
 * web/workers/competition-api/src/scoring/config.ts — the comp manifest's
 * `gap_params` stand in for the comp row and each task spec's `gap_params`
 * for the task row (migration 0021), with the task's overriding the comp's,
 * then `resolveCompGapParams` over the pair and the 70% nominal-distance
 * fallback keyed off the *stored* value's absence. Scoring an archive comp
 * any other way measures a formula the competition never ran.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import {
  scoreTask,
  resolveCompGapParams,
  type GAPParameters,
  type TaskScoreResult,
} from '../engine/src/gap-scoring';
import { calculateOptimizedTaskDistance } from '../engine/src/task-optimizer';
import { loadCompManifest, readTaskDir } from '../engine/cli/comp-manifest';

interface TaskSpec {
  pilot_class: string;
  name: string;
  date: string;
  dir: string;
  gap_params?: Partial<GAPParameters>;
}

/** One scored task, flattened to the values a weight change can move. */
interface TaskRow {
  comp: string;
  pilotClass: string;
  task: string;
  scoring: string;
  numFlying: number;
  numInGoal: number;
  numReachedESS: number;
  goalRatio: number;
  useLeading: boolean;
  weights: TaskScoreResult['weights'];
  availablePoints: TaskScoreResult['availablePoints'];
  pilots: Array<{
    name: string;
    distance: number;
    time: number;
    leading: number;
    arrival: number;
    total: number;
  }>;
}

function compsRootFromEnv(): string {
  const dir = process.env.GLIDECOMP_COMPS_DIR;
  if (!dir) {
    throw new Error(
      'Set GLIDECOMP_COMPS_DIR to a comps tree (e.g. <glidecomp-archive>/comps).',
    );
  }
  if (!existsSync(dir)) throw new Error(`GLIDECOMP_COMPS_DIR does not exist: ${dir}`);
  return resolve(dir);
}

function scoreOneComp(compDir: string): TaskRow[] {
  const { manifest, compsRoot } = loadCompManifest(compDir);
  // Open distance never reaches the GAP weight split (scoreOpenDistance
  // publishes zeroes and never calls calculateWeights), so scoring one here
  // as GAP would measure a formula the competition never ran — and its
  // single-turnpoint tasks resolve no ESS at all, which would read as a
  // §10 "nobody reached ESS" day that it is not.
  if (manifest.scoring_format === 'open_distance') return [];
  const category: 'hg' | 'pg' = manifest.category === 'pg' ? 'pg' : 'hg';
  const compGapParams =
    (manifest as { gap_params?: Partial<GAPParameters> }).gap_params ?? null;
  const rows: TaskRow[] = [];

  for (const spec of (manifest.tasks ?? []) as TaskSpec[]) {
    let taskDir;
    try {
      taskDir = readTaskDir(join(compsRoot, spec.dir));
    } catch {
      continue; // no .xctsk, or an unreadable folder — not this audit's business
    }
    const { task, pilots } = taskDir;
    if (pilots.length === 0) continue;

    // The task's own gap_params over the comp's (migration 0021), exactly as
    // the scorer merges them.
    const stored: Partial<GAPParameters> | null =
      compGapParams || spec.gap_params
        ? { ...(compGapParams ?? {}), ...(spec.gap_params ?? {}) }
        : null;
    const gapParams = resolveCompGapParams(category, stored);
    if (stored?.nominalDistance == null) {
      gapParams.nominalDistance = calculateOptimizedTaskDistance(task) * 0.7;
    }

    const result = scoreTask(task, pilots, gapParams);
    rows.push({
      comp: manifest.slug,
      pilotClass: spec.pilot_class,
      task: spec.name,
      scoring: gapParams.scoring ?? (category === 'pg' ? 'PG' : 'HG'),
      numFlying: result.stats.numFlying,
      numInGoal: result.stats.numInGoal,
      numReachedESS: result.stats.numReachedESS,
      goalRatio: result.stats.goalRatio,
      useLeading: gapParams.useLeading ?? true,
      weights: result.weights,
      availablePoints: result.availablePoints,
      pilots: result.pilotScores.map((p) => ({
        name: p.pilotName,
        distance: p.distancePoints,
        time: p.timePoints,
        leading: p.leadingPoints,
        arrival: p.arrivalPoints,
        total: p.totalScore,
      })),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// --diff: what actually moved
// ---------------------------------------------------------------------------

function key(r: TaskRow): string {
  return `${r.comp}/${r.pilotClass}/${r.task}`;
}

function runDiff(beforePath: string, afterPath: string): void {
  const before = JSON.parse(readFileSync(beforePath, 'utf-8')) as TaskRow[];
  const after = JSON.parse(readFileSync(afterPath, 'utf-8')) as TaskRow[];
  const beforeByKey = new Map(before.map((r) => [key(r), r]));

  let tasksCompared = 0;
  let tasksMoved = 0;
  let pilotsMoved = 0;
  let worstPilot = 0;
  const movedTasks: string[] = [];

  for (const a of after) {
    const b = beforeByKey.get(key(a));
    if (!b) continue;
    tasksCompared++;
    let taskMoved = false;
    let taskWorst = 0;
    const byName = new Map(b.pilots.map((p) => [p.name, p]));
    for (const pa of a.pilots) {
      const pb = byName.get(pa.name);
      if (!pb) continue;
      const delta = Math.abs(pa.total - pb.total);
      if (delta > 0.05) {
        pilotsMoved++;
        taskMoved = true;
        taskWorst = Math.max(taskWorst, delta);
        worstPilot = Math.max(worstPilot, delta);
      }
    }
    const weightMoved =
      Math.abs(a.weights.leading - b.weights.leading) > 1e-9 ||
      Math.abs(a.weights.time - b.weights.time) > 1e-9 ||
      Math.abs(a.weights.arrival - b.weights.arrival) > 1e-9;
    if (taskMoved || weightMoved) {
      tasksMoved++;
      movedTasks.push(
        `${key(a)} [${a.scoring}] flying=${a.numFlying} goal=${a.numInGoal} ess=${a.numReachedESS} ` +
          `lead ${b.weights.leading.toFixed(4)}→${a.weights.leading.toFixed(4)} ` +
          `time ${b.weights.time.toFixed(4)}→${a.weights.time.toFixed(4)} ` +
          `availLead ${b.availablePoints.leading.toFixed(1)}→${a.availablePoints.leading.toFixed(1)} ` +
          `worstPilotΔ=${taskWorst.toFixed(1)}`,
      );
    }
  }

  console.log(`tasks compared: ${tasksCompared}`);
  console.log(`tasks whose weights or points moved: ${tasksMoved}`);
  console.log(`pilot totals moved (>0.05 pts): ${pilotsMoved}`);
  console.log(`largest single-pilot change: ${worstPilot.toFixed(1)} pts`);
  if (movedTasks.length > 0) {
    console.log('\nmoved:');
    for (const line of movedTasks) console.log(`  ${line}`);
  }
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args[0] === '--diff') {
  if (args.length !== 3) {
    process.stderr.write('Usage: --diff <before.json> <after.json>\n');
    process.exit(1);
  }
  runDiff(args[1], args[2]);
} else {
  const root = compsRootFromEnv();
  const rows: TaskRow[] = [];
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, 'comp.json'))) continue; // a task folder, not a comp
    try {
      rows.push(...scoreOneComp(dir));
    } catch (err) {
      process.stderr.write(`Warning: skipping ${entry}: ${err}\n`);
    }
    process.stderr.write(`scored ${entry}\n`);
  }
  process.stdout.write(JSON.stringify(rows));
}
