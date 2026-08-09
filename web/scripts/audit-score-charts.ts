/**
 * Audit the report card's component charts across a whole comp library.
 *
 * The charts claim something strong: the drawn curve is the scoring function,
 * and every dot on it is a pilot whose PUBLISHED points that function
 * reproduces. `score-explanation-charts.ts` enforces that by checking each
 * pilot against the curve and omitting anyone it cannot explain — which makes
 * the claim safe, but also means a mistake shows up as silence (dots quietly
 * missing, or a chart quietly absent) rather than as a wrong picture.
 *
 * This script is how that silence gets read. It scores every task in a comp
 * library with the real engine, builds the same class context the competition
 * API publishes, runs the chart builders for every pilot, and reports what was
 * drawn, what was omitted, and why.
 *
 * The sharp assertion is the distance chart. No spec reduction applies to
 * distance points — §12.1 and §12.3.5 dock time and arrival, not distance — so
 * a correct implementation explains EVERY pilot on that axis, including the
 * hang-gliding difficulty case whose curve this module reconstructs from the
 * field. Any distance omission at all means the reconstruction is wrong.
 *
 * Usage:
 *   bun web/scripts/audit-score-charts.ts                     # bundled comps
 *   GLIDECOMP_COMPS_DIR=<archive>/comps bun web/scripts/audit-score-charts.ts
 *   bun web/scripts/audit-score-charts.ts bright-open-2023    # one comp
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  scoreTask,
  resolveCompGapParams,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type TaskScoreResult,
} from '../engine/src/gap-scoring';
import { calculateOptimizedTaskDistance } from '../engine/src/task-optimizer';
import {
  buildTimeChart,
  buildLeadingChart,
  buildArrivalChart,
  buildDistanceChart,
} from '../engine/src/score-explanation-charts';
import type {
  ClassContextInput,
  ClassPilotInput,
  ScoreEntryInput,
} from '../engine/src/score-explanation-types';
import { loadCompManifest, readTaskDir } from '../engine/cli/comp-manifest';

const COMPS_ROOT =
  process.env.GLIDECOMP_COMPS_DIR ?? join(import.meta.dir, '..', 'samples', 'comps');

interface Tally {
  pilots: number;
  drawn: number;
  suppressed: number;
  omittedDots: number;
}

const EMPTY = (): Tally => ({ pilots: 0, drawn: 0, suppressed: 0, omittedDots: 0 });
const tallies: Record<string, Tally> = {
  distance: EMPTY(),
  time: EMPTY(),
  leading: EMPTY(),
  arrival: EMPTY(),
};
/** Distance omissions are the correctness signal — record them individually. */
const distanceAnomalies: string[] = [];
let tasksScored = 0;
let tasksSkipped = 0;

/** The class context the competition API publishes, from an engine result. */
function toClassContext(
  result: TaskScoreResult,
  params: GAPParameters,
  taskDistance: number,
): ClassContextInput {
  const pilots: ClassPilotInput[] = result.pilotScores.map((ps) => ({
    comp_pilot_id: ps.trackFile,
    pilot_name: ps.pilotName,
    flown_distance: ps.flownDistance,
    speed_section_time: ps.speedSectionTime,
    made_goal: ps.madeGoal,
    reached_ess: ps.reachedESS,
    rank: ps.rank,
    total_score: ps.totalScore,
    distance_points: ps.distancePoints,
    time_points: ps.timePoints,
    leading_points: ps.leadingPoints,
    arrival_points: ps.arrivalPoints,
    leading_coefficient: Number.isFinite(ps.leadingCoefficient)
      ? ps.leadingCoefficient
      : null,
    arrival_position: ps.arrivalPosition ?? null,
    ess_time_ms: ps.essTimeMs ?? null,
  }));
  const overMin = result.pilotScores.reduce(
    (s, p) => s + Math.max(0, p.flownDistance - params.minimumDistance),
    0,
  );
  return {
    task_validity: result.taskValidity,
    available_points: result.availablePoints,
    pilots,
    validity_inputs: {
      num_present: result.stats.numPresent,
      num_flying: result.stats.numFlying,
      num_in_goal: result.stats.numInGoal,
      num_reached_ess: result.stats.numReachedESS,
      best_distance: result.stats.bestDistance,
      best_time: result.stats.bestTime,
      goal_ratio: result.stats.goalRatio,
      task_distance: taskDistance,
      mean_distance_over_minimum:
        result.stats.numFlying > 0 ? overMin / result.stats.numFlying : 0,
      weights: result.weights,
    },
  };
}

function entryFor(p: ClassPilotInput): ScoreEntryInput {
  return {
    comp_pilot_id: p.comp_pilot_id,
    made_goal: p.made_goal,
    reached_ess: p.reached_ess,
    flown_distance: p.flown_distance,
    speed_section_time: p.speed_section_time,
    distance_points: p.distance_points ?? 0,
    distance_linear_points: 0,
    distance_difficulty_points: 0,
    time_points: p.time_points ?? 0,
    leading_points: p.leading_points ?? 0,
    arrival_points: p.arrival_points ?? 0,
    penalty_points: 0,
    penalty_reason: null,
    total_score: p.total_score ?? 0,
    leading_coefficient: p.leading_coefficient,
    arrival_position: p.arrival_position,
    ess_time_ms: p.ess_time_ms,
  };
}

function auditTask(label: string, compsRoot: string, dir: string, category: 'hg' | 'pg'): void {
  let taskDir;
  try {
    taskDir = readTaskDir(join(compsRoot, dir));
  } catch {
    tasksSkipped++;
    return;
  }
  const { task, pilots } = taskDir;
  if (pilots.length === 0) {
    tasksSkipped++;
    return;
  }
  const params: GAPParameters = {
    ...DEFAULT_GAP_PARAMETERS,
    ...resolveCompGapParams(category, null),
  };
  params.nominalDistance = calculateOptimizedTaskDistance(task) * 0.7;

  let result: TaskScoreResult;
  try {
    result = scoreTask(task, pilots, params);
  } catch (err) {
    process.stderr.write(`  ! ${label}: scoring failed — ${err}\n`);
    tasksSkipped++;
    return;
  }
  tasksScored++;

  const ctx = toClassContext(result, params, calculateOptimizedTaskDistance(task));
  for (const p of ctx.pilots) {
    const entry = entryFor(p);
    const charts = {
      distance: buildDistanceChart(entry, ctx, params),
      time: buildTimeChart(entry, ctx, params),
      leading: buildLeadingChart(entry, ctx),
      arrival: buildArrivalChart(entry, ctx),
    };
    for (const [name, c] of Object.entries(charts)) {
      // Every builder here returns the curve variant; ScoreChart is a union
      // only because the validity sparklines and distribution share the type.
      const chart = c && c.kind === 'curve' ? c : null;
      const t = tallies[name];
      t.pilots++;
      if (chart) {
        t.drawn++;
        t.omittedDots += chart.omitted;
        if (name === 'distance' && chart.omitted > 0 && distanceAnomalies.length < 12) {
          distanceAnomalies.push(
            `${label}: ${chart.omitted} pilot(s) unexplained on the distance curve`,
          );
        }
      } else {
        t.suppressed++;
      }
    }
  }
}

function auditComp(slug: string): void {
  let loaded;
  try {
    // Full path, not a bare slug: loadCompManifest resolves a slug against the
    // BUNDLED comps root, which would silently score the wrong library (or
    // nothing) when pointed at the archive via GLIDECOMP_COMPS_DIR.
    loaded = loadCompManifest(join(COMPS_ROOT, slug));
  } catch (err) {
    process.stderr.write(`  ! ${slug}: ${err}\n`);
    return;
  }
  const { manifest, compsRoot } = loaded;
  if (manifest.scoring_format === 'open_distance') return; // no GAP components
  const category: 'hg' | 'pg' = manifest.category === 'pg' ? 'pg' : 'hg';
  for (const spec of manifest.tasks) {
    auditTask(`${slug} ${spec.name} (${spec.pilot_class})`, compsRoot, spec.dir, category);
  }
}

// ---------------------------------------------------------------------------

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const slugs =
  requested.length > 0
    ? requested
    : readdirSync(COMPS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(COMPS_ROOT, e.name, 'comp.json')))
        .map((e) => e.name)
        .sort();

process.stderr.write(`Auditing ${slugs.length} comp(s) under ${COMPS_ROOT}\n`);
for (const slug of slugs) auditComp(slug);

console.log('');
console.log(`Tasks scored: ${tasksScored}   skipped: ${tasksSkipped}`);
console.log('');
console.log('component  pilot-views   charts drawn   suppressed   dots omitted');
for (const [name, t] of Object.entries(tallies)) {
  const pct = t.pilots > 0 ? ((100 * t.drawn) / t.pilots).toFixed(1) : '0.0';
  console.log(
    `${name.padEnd(10)} ${String(t.pilots).padStart(11)} ${String(t.drawn).padStart(14)} (${pct.padStart(5)}%) ${String(
      t.suppressed,
    ).padStart(9)} ${String(t.omittedDots).padStart(13)}`,
  );
}

if (distanceAnomalies.length > 0) {
  console.log('');
  console.log('DISTANCE ANOMALIES — no spec reduction applies to distance points,');
  console.log('so any omission here means the curve reconstruction is wrong:');
  for (const a of distanceAnomalies) console.log(`  ${a}`);
  process.exitCode = 1;
} else {
  console.log('');
  console.log('No distance-curve anomalies: every plotted pilot on every');
  console.log('distance chart is explained by the reconstructed formula.');
}
