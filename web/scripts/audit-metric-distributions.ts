#!/usr/bin/env bun
/**
 * Sweep every bundled (and, with GLIDECOMP_COMPS_DIR, every archived) task
 * through the behavioural task analysis and report, per metric, the
 * distribution of its Spearman ρ against GAP rank and of its own per-pilot
 * values.
 *
 * This is the evidence the metric registry is otherwise missing. A metric
 * earns its place by SEPARATING the field: the plan's premise is that ρ vs GAP
 * rank says which behaviours mattered. Whether a given metric ever clears its
 * noise floor, how often it declines to answer at all, and whether its sign is
 * stable across days are all questions only a sweep over every real task can
 * settle — the unit tests fix behaviour on a handful of fixtures and say
 * nothing about explanatory power.
 *
 *   bun web/scripts/audit-metric-distributions.ts
 *   GLIDECOMP_COMPS_DIR=~/dev/glidecomp-archive/comps \
 *     bun web/scripts/audit-metric-distributions.ts --json out.json
 *
 * The bundled comps alone are 10 tasks, which can expose a structural defect
 * but cannot settle whether a metric has explanatory power. The full sweep —
 * bundled AND archived together, 27 comps / 194 tasks / 4,959 pilot-task rows —
 * is written up in docs/2026-09-02-metric-evidence.md, which also says how to
 * point one GLIDECOMP_COMPS_DIR at both repositories at once.
 *
 * Options:
 *   --json <path>          Write the full distribution report as JSON
 *                          (histograms included). Without it, only the text
 *                          summary is printed.
 *   --limit <n>            Stop after n tasks (a smoke run over a large archive).
 *   --include-synthetic    Also sweep comps whose manifest sets `synthetic`.
 *
 * SYNTHETIC COMPS ARE EXCLUDED BY DEFAULT, and that is not a tidiness
 * preference. The forged fixtures (kosci-loop, big-chip) are built to exercise
 * turnpoint and open-distance edge cases, so their "pilots" carry no
 * behavioural truth at all — and because their fields are large and uniform,
 * they produce enormous, entirely artificial coefficients. Swept in with the
 * real comps, kosci-loop alone drove race.start_delay to ρ ≈ −0.95 on three
 * tasks, exactly inverting the sign every real task shows.
 *
 * Scoring mirrors the web app: the manifest's comp-level `gap_params` with the
 * task's own merged over them (migration 0021 — an imported AirScore comp
 * publishes a different formula per task), over the per-category FAI defaults.
 * Getting that right matters here in a way it does not for a track sweep: the
 * params decide the RANK, and the rank is what every ρ is measured against.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scoreTask, type GAPParameters, type PilotFlight } from '../engine/src/gap-scoring';
import { resolveCompGapParams } from '../engine/src/gap-params';
import { scoreOpenDistance } from '../engine/src/open-distance-scoring';
import { calculateOptimizedTaskDistance } from '../engine/src/task-optimizer';
import { buildFieldContext, evaluateField, ALL_METRICS, FAMILY_LABELS } from '../engine/src/analysis';
import { spearmanNoiseFloor, median, percentile } from '../engine/src/analysis/stats';
import { readTaskDir } from '../engine/cli/comp-manifest';
import type { MetricReport } from '../engine/src/analysis/types';

const COMPS_DIR =
  process.env.GLIDECOMP_COMPS_DIR ?? join(import.meta.dir, '..', 'samples', 'comps');

const argv = process.argv.slice(2);
const jsonAt = argv.indexOf('--json');
const jsonPath = jsonAt >= 0 ? argv[jsonAt + 1] : null;
const limitAt = argv.indexOf('--limit');
const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : Infinity;
const includeSynthetic = argv.includes('--include-synthetic');

// ---------------------------------------------------------------------------
// Task collection
// ---------------------------------------------------------------------------

interface TaskSpec {
  compSlug: string;
  compName: string;
  pilotClass: string;
  taskName: string;
  date: string;
  dir: string;
  category: 'hg' | 'pg';
  openDistance: boolean;
  /** Comp gap_params with the task's own merged over them. */
  gapParams: Partial<GAPParameters> | null;
}

const syntheticSkipped: string[] = [];

function collectTasks(): TaskSpec[] {
  const out: TaskSpec[] = [];
  for (const name of readdirSync(COMPS_DIR).sort()) {
    const manifestPath = join(COMPS_DIR, name, 'comp.json');
    if (!existsSync(manifestPath)) continue;
    let comp: any;
    try {
      comp = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      process.stderr.write(`Warning: unreadable manifest ${manifestPath}: ${err}\n`);
      continue;
    }
    if (comp.synthetic === true && !includeSynthetic) {
      syntheticSkipped.push(comp.slug ?? name);
      continue;
    }
    const category: 'hg' | 'pg' = comp.category === 'pg' ? 'pg' : 'hg';
    const openDistance = comp.scoring_format === 'open_distance';
    for (const task of comp.tasks ?? []) {
      if (!task.dir || !task.date) continue;
      if (!existsSync(join(COMPS_DIR, task.dir, 'task.xctsk'))) continue;
      out.push({
        compSlug: comp.slug ?? name,
        compName: comp.name ?? comp.slug ?? name,
        pilotClass: task.pilot_class ?? 'open',
        taskName: task.name ?? task.dir,
        date: task.date,
        dir: task.dir,
        category,
        openDistance,
        gapParams: { ...(comp.gap_params ?? {}), ...(task.gap_params ?? {}) },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Accumulators
// ---------------------------------------------------------------------------

interface MetricAccumulator {
  id: string;
  label: string;
  shortLabel: string;
  family: string;
  unit: string;
  direction: string;
  outcome: boolean;
  /** One entry per task that produced a correlation. */
  rhos: number[];
  ns: number[];
  noiseFloors: number[];
  verdicts: Record<string, number>;
  /** Tasks where the metric ran but produced no correlation at all. */
  noCorrelationTasks: number;
  /** Tasks where the metric threw. */
  errorTasks: number;
  /** Per-task coverage: non-null per-pilot values ÷ pilots in the field. */
  coverage: number[];
  /** Every finite per-pilot value across every task (for the value histogram). */
  values: number[];
  nullValues: number;
}

const accumulators = new Map<string, MetricAccumulator>();
for (const m of ALL_METRICS) {
  accumulators.set(m.id, {
    id: m.id,
    label: m.label,
    shortLabel: m.shortLabel ?? m.id,
    family: m.family,
    unit: m.unit,
    direction: m.direction,
    outcome: m.outcome === true,
    rhos: [],
    ns: [],
    noiseFloors: [],
    verdicts: {},
    noCorrelationTasks: 0,
    errorTasks: 0,
    coverage: [],
    values: [],
    nullValues: 0,
  });
}

function record(acc: MetricAccumulator, m: MetricReport, pilotCount: number): void {
  if (m.error !== undefined) acc.errorTasks++;

  let nonNull = 0;
  for (const p of m.perPilot) {
    if (p.value === null || !isFinite(p.value)) acc.nullValues++;
    else {
      nonNull++;
      acc.values.push(p.value);
    }
  }
  if (pilotCount > 0) acc.coverage.push(nonNull / pilotCount);

  if (m.correlation) {
    acc.rhos.push(m.correlation.rho);
    acc.ns.push(m.correlation.n);
    acc.noiseFloors.push(m.correlation.noiseFloor ?? spearmanNoiseFloor(m.correlation.n));
    acc.verdicts[m.correlation.verdict] = (acc.verdicts[m.correlation.verdict] ?? 0) + 1;
  } else {
    acc.noCorrelationTasks++;
  }
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const specs = collectTasks();
if (specs.length === 0) {
  console.error(`No tasks with a route under ${COMPS_DIR}`);
  process.exit(1);
}

interface TaskOutcome {
  comp: string;
  pilotClass: string;
  task: string;
  date: string;
  pilots: number;
  category: 'hg' | 'pg';
  /** Metrics whose ρ cleared the task's noise floor. */
  informativeMetrics: number;
  ms: number;
}

const taskOutcomes: TaskOutcome[] = [];
const skipped: string[] = [];
const comps = new Set<string>();
let done = 0;

for (const spec of specs) {
  if (done >= limit) break;
  const dir = join(COMPS_DIR, spec.dir);
  let loaded: { task: any; pilots: PilotFlight[] };
  try {
    loaded = readTaskDir(dir);
  } catch (err) {
    skipped.push(`${spec.dir}: ${err}`);
    continue;
  }
  if (loaded.pilots.length === 0) {
    skipped.push(`${spec.dir}: no parseable tracks`);
    continue;
  }

  const started = Date.now();
  try {
    let result;
    if (spec.openDistance) {
      result = scoreOpenDistance(loaded.task, loaded.pilots);
    } else {
      const gap = resolveCompGapParams(spec.category, spec.gapParams);
      // The UI's own rule: an unpinned nominal distance is 70% of the
      // optimised task distance. Without it a comp that never stored one
      // scores against a nominal of zero.
      if (spec.gapParams?.nominalDistance === undefined) {
        gap.nominalDistance = calculateOptimizedTaskDistance(loaded.task) * 0.7;
      }
      result = scoreTask(loaded.task, loaded.pilots, gap);
    }
    const field = buildFieldContext(loaded.task, loaded.pilots, result, spec.category);
    const report = evaluateField(field);

    let informative = 0;
    for (const m of report.metrics) {
      const acc = accumulators.get(m.id);
      if (!acc) continue; // a metric in a stored report the registry no longer has
      record(acc, m, report.pilots.length);
      if (m.correlation && m.correlation.absRho >= (m.correlation.noiseFloor ?? 1)) informative++;
    }

    comps.add(spec.compSlug);
    taskOutcomes.push({
      comp: spec.compName,
      pilotClass: spec.pilotClass,
      task: spec.taskName,
      date: spec.date,
      pilots: report.pilots.length,
      category: spec.category,
      informativeMetrics: informative,
      ms: Date.now() - started,
    });
    done++;
    process.stderr.write(
      `[${done}/${Math.min(specs.length, limit)}] ${spec.compSlug} ${spec.pilotClass} ` +
        `${spec.taskName} — ${report.pilots.length} pilots, ${Date.now() - started} ms\n`,
    );
  } catch (err) {
    skipped.push(`${spec.dir}: ${err}`);
    process.stderr.write(`Warning: ${spec.dir} failed: ${err}\n`);
  }
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

interface Histogram {
  binEdges: number[];
  counts: number[];
}

/** Fixed −1..1 in 0.1-wide bins — ρ has a fixed domain, so every metric's
 * ρ histogram is directly comparable to every other's. */
function rhoHistogram(rhos: number[]): Histogram {
  const binEdges: number[] = [];
  for (let i = 0; i <= 20; i++) binEdges.push(-1 + i * 0.1);
  const counts = new Array<number>(20).fill(0);
  for (const r of rhos) {
    const idx = Math.min(19, Math.max(0, Math.floor((r + 1) / 0.1)));
    counts[idx]++;
  }
  return { binEdges, counts };
}

/** Adaptive bins over p1..p99 — a metric's value domain is its own, and a
 * handful of extreme outliers must not collapse the visible range. */
function valueHistogram(values: number[], bins = 24): Histogram | null {
  if (values.length < 2) return null;
  const sorted = [...values].sort((a, b) => a - b);
  let lo = percentile(sorted, 1);
  let hi = percentile(sorted, 99);
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) {
    lo = sorted[0];
    hi = sorted[sorted.length - 1];
  }
  if (hi <= lo) return null;
  const width = (hi - lo) / bins;
  const binEdges: number[] = [];
  for (let i = 0; i <= bins; i++) binEdges.push(lo + i * width);
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / width)));
    counts[idx]++;
  }
  return { binEdges, counts };
}

function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p5: percentile(sorted, 5),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    n: sorted.length,
  };
}

const metricSummaries = ALL_METRICS.map((m) => {
  const acc = accumulators.get(m.id)!;
  const absRhos = acc.rhos.map(Math.abs);

  // A task votes on the sign only when its |ρ| clears that task's own noise
  // floor — the same rule aggregate.ts uses, so this sweep and the shipped
  // comp analysis agree about what "informative" means.
  let positive = 0;
  let negative = 0;
  let quiet = 0;
  for (let i = 0; i < acc.rhos.length; i++) {
    if (Math.abs(acc.rhos[i]) >= acc.noiseFloors[i] && acc.rhos[i] !== 0) {
      if (acc.rhos[i] > 0) positive++;
      else negative++;
    } else quiet++;
  }
  const informative = positive + negative;

  return {
    id: m.id,
    label: m.label,
    shortLabel: m.shortLabel ?? m.id,
    family: m.family,
    familyLabel: FAMILY_LABELS[m.family],
    unit: m.unit,
    direction: m.direction,
    outcome: acc.outcome,
    tasksWithCorrelation: acc.rhos.length,
    noCorrelationTasks: acc.noCorrelationTasks,
    errorTasks: acc.errorTasks,
    medianAbsRho: absRhos.length > 0 ? median(absRhos) : null,
    meanAbsRho:
      absRhos.length > 0 ? absRhos.reduce((a, b) => a + b, 0) / absRhos.length : null,
    medianSignedRho: acc.rhos.length > 0 ? median(acc.rhos) : null,
    verdicts: acc.verdicts,
    informativeTasks: informative,
    informativeShare: acc.rhos.length > 0 ? informative / acc.rhos.length : null,
    positiveTasks: positive,
    negativeTasks: negative,
    quietTasks: quiet,
    /** Share of informative tasks taking the majority sign. */
    signMajorityShare: informative > 0 ? Math.max(positive, negative) / informative : null,
    meanCoverage:
      acc.coverage.length > 0
        ? acc.coverage.reduce((a, b) => a + b, 0) / acc.coverage.length
        : null,
    valueStats: stats(acc.values),
    nullValues: acc.nullValues,
    rhoHistogram: rhoHistogram(acc.rhos),
    valueHistogram: valueHistogram(acc.values),
    rhos: acc.rhos,
  };
});

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const meta = {
  compsDir: resolve(COMPS_DIR),
  comps: comps.size,
  tasksAttempted: specs.length,
  tasksAnalysed: taskOutcomes.length,
  tasksSkipped: skipped.length,
  syntheticCompsExcluded: syntheticSkipped,
  pilotTaskRows: taskOutcomes.reduce((a, t) => a + t.pilots, 0),
  generatedAt: new Date().toISOString(),
};

console.log('');
console.log(`Metric distributions over ${meta.comps} comps / ${meta.tasksAnalysed} tasks`);
console.log(`(${meta.pilotTaskRows} pilot-task rows; ${meta.tasksSkipped} tasks skipped)`);
if (syntheticSkipped.length > 0) {
  console.log(`Excluded ${syntheticSkipped.length} synthetic comp(s): ${syntheticSkipped.join(', ')}`);
}
console.log('');

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
const num = (v: number | null, digits = 2) => (v === null ? '   —' : v.toFixed(digits));

console.log(
  pad('metric', 30) +
    pad('fam', 10) +
    ' med|ρ|  medρ   inform  sign%  cover%  strong  n',
);
console.log('-'.repeat(94));
for (const s of [...metricSummaries].sort(
  (a, b) => (b.medianAbsRho ?? -1) - (a.medianAbsRho ?? -1),
)) {
  console.log(
    pad(s.id + (s.outcome ? ' *' : ''), 30) +
      pad(s.family, 10) +
      '  ' + num(s.medianAbsRho) +
      '   ' + num(s.medianSignedRho).padStart(5) +
      '   ' + `${s.informativeTasks}/${s.tasksWithCorrelation}`.padStart(7) +
      '  ' + (s.signMajorityShare === null ? '  — ' : `${Math.round(100 * s.signMajorityShare)}%`).padStart(5) +
      '  ' + (s.meanCoverage === null ? '  — ' : `${Math.round(100 * s.meanCoverage)}%`).padStart(6) +
      '  ' + String(s.verdicts.strong ?? 0).padStart(6) +
      '  ' + String(s.valueStats?.n ?? 0).padStart(6),
  );
}
console.log('');
console.log('* = outcome-derived (ρ is a sanity check, not a finding)');
console.log('inform = tasks whose |ρ| cleared that task\'s noise floor');
console.log('sign%  = share of informative tasks taking the majority sign');
console.log('cover% = mean share of the field the metric returned a value for');

if (skipped.length > 0) {
  console.log('');
  console.log(`Skipped ${skipped.length} task(s):`);
  for (const s of skipped.slice(0, 20)) console.log(`  ${s}`);
  if (skipped.length > 20) console.log(`  … and ${skipped.length - 20} more`);
}

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify({ meta, metrics: metricSummaries, tasks: taskOutcomes }, null, 2),
  );
  console.log('');
  console.log(`Wrote ${jsonPath}`);
}
