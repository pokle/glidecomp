#!/usr/bin/env bun
/**
 * Does the DAY decide what a behaviour is worth?
 *
 * audit-metric-distributions.ts pools every task together, which answers "does
 * this metric separate the field in general". That question cannot tell a
 * metric that never matters apart from one that matters enormously on some
 * days and is reversed or absent on others: both produce a median ρ near zero
 * and a ~50/50 sign split. This script separates them.
 *
 * For every task it records each metric's signed ρ against GAP rank ALONGSIDE
 * the day's own conditions, then asks whether ρ is itself predicted by any of
 * those conditions.
 *
 *   bun web/scripts/audit-metric-conditions.ts
 *   GLIDECOMP_COMPS_DIR=../glidecomp-archive/comps \
 *     bun web/scripts/audit-metric-conditions.ts --json out.json
 *
 * Options:
 *   --json <path>          Write per-task rows (conditions + every ρ) as JSON.
 *   --min-pilots <n>       Field-size floor for the condition tests (default 10).
 *   --include-synthetic    Also sweep comps whose manifest sets `synthetic`.
 *
 * TWO STATISTICAL TRAPS THIS SCRIPT EXISTS TO AVOID, both of which produced a
 * confident wrong answer before they were handled:
 *
 * 1. THE NOISE FLOOR IS NOT 5% AT SMALL n. spearmanNoiseFloor is the α = 0.05
 *    critical value, but Spearman is DISCRETE at tiny n: with 3 pilots ρ can
 *    only be 0, ±0.5 or ±1, so P(|ρ| ≥ floor) is 1/3, not 1/20. Counting a
 *    3-pilot task as a 5% event overstates the evidence by nearly 7×. The
 *    expected count is therefore summed from the EXACT per-n rate
 *    (enumerated over permutations up to MAX_EXACT_N), and the condition tests
 *    additionally drop fields under --min-pilots.
 *
 * 2. MULTIPLE COMPARISONS. ~25 metrics × ~17 conditions is ~400 tests, so at
 *    α = 0.05 roughly 20 "findings" are guaranteed by chance. Every p is
 *    reported with a Benjamini-Hochberg q over the whole family of tests
 *    actually run, and only q < FDR_Q is called a hit.
 *
 * Read a hit as a hypothesis, not a conclusion: the conditions here are the
 * ones derivable from the tracks, and the variable that really decides a
 * behaviour's worth (airmass stability, how broken the lift is) may not be
 * among them. Confirm one by reading the tasks it separates.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scoreTask, type GAPParameters, type PilotFlight } from '../engine/src/gap-scoring';
import { resolveCompGapParams } from '../engine/src/gap-params';
import { calculateOptimizedTaskDistance } from '../engine/src/task-optimizer';
import { buildFieldContext, evaluateField, ALL_METRICS } from '../engine/src/analysis';
import { spearman, spearmanNoiseFloor, median } from '../engine/src/analysis/stats';
import { readTaskDir } from '../engine/cli/comp-manifest';

const COMPS_DIR =
  process.env.GLIDECOMP_COMPS_DIR ?? join(import.meta.dir, '..', 'samples', 'comps');

const argv = process.argv.slice(2);
const jsonAt = argv.indexOf('--json');
const jsonPath = jsonAt >= 0 ? argv[jsonAt + 1] : null;
const minAt = argv.indexOf('--min-pilots');
const MIN_PILOTS = minAt >= 0 ? Number(argv[minAt + 1]) : 10;
const includeSynthetic = argv.includes('--include-synthetic');

/** Above this, the asymptotic 5% is accurate and enumeration is too slow. */
const MAX_EXACT_N = 9;
/** Benjamini-Hochberg threshold for calling a condition a hit. */
const FDR_Q = 0.1;
/** A condition test needs at least this many tasks to be worth running. */
const MIN_TASKS_FOR_TEST = 20;

/** The day's own conditions, in the order they are reported. */
const CONDITIONS = [
  'windKmh', 'climbMedian', 'climbP90', 'climbSpread', 'bandSpanM', 'bandCeilingM',
  'sharedThermals', 'multiPilotThermals', 'gaggleDensity', 'climbShare', 'glideShare',
  'searchShare', 'taskDistanceKm', 'goalRate', 'essRate', 'durationH', 'fieldSize', 'month',
] as const;
type Condition = (typeof CONDITIONS)[number];

interface TaskRow {
  comp: string;
  task: string;
  date: string;
  category: 'hg' | 'pg';
  conditions: Record<Condition, number | null>;
  metrics: { id: string; rho: number; n: number; floor: number }[];
}

// ---------------------------------------------------------------------------
// Statistics the engine does not already provide
// ---------------------------------------------------------------------------

/** Regularised incomplete beta, by continued fraction — for the Spearman p. */
function betaIncReg(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i < 300; i++) {
    const m = Math.floor(i / 2);
    let num: number;
    if (i === 0) num = 1;
    else if (i % 2 === 0) num = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else num = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= c * d;
    if (Math.abs(1 - c * d) < 1e-10) break;
  }
  return front * (f - 1);
}

function lgamma(z: number): number {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Two-sided p for a Spearman ρ, via the t approximation. */
function spearmanP(rho: number, n: number): number {
  if (n < 5) return 1;
  const r = Math.max(-0.999999, Math.min(0.999999, rho));
  const df = n - 2;
  const t = r * Math.sqrt(df / (1 - r * r));
  return betaIncReg(df / 2, 0.5, df / (df + t * t));
}

/** Benjamini-Hochberg q-values, parallel to the input p-values. */
function benjaminiHochberg(ps: number[]): number[] {
  const m = ps.length;
  const order = [...ps.keys()].sort((a, b) => ps[a] - ps[b]);
  const q = new Array<number>(m).fill(0);
  let prev = 1;
  for (let rank = m - 1; rank >= 0; rank--) {
    const i = order[rank];
    prev = Math.min(prev, (ps[i] * m) / (rank + 1));
    q[i] = prev;
  }
  return q;
}

/**
 * P(|ρ| ≥ noise floor) under the null, EXACTLY, by enumerating permutations.
 * At n = 3 this is 1/3, not 1/20 — see trap 1 in the header.
 */
const exactNullCache = new Map<number, number>();
function exactNullRate(n: number): number {
  if (n > MAX_EXACT_N) return 0.05;
  const hit = exactNullCache.get(n);
  if (hit !== undefined) return hit;
  const floor = spearmanNoiseFloor(n);
  const base = [...Array(n).keys()];
  const mean = (n - 1) / 2;
  const den = base.reduce((a, x) => a + (x - mean) ** 2, 0);
  let hits = 0, total = 0;
  const perm = [...base];
  const walk = (k: number): void => {
    if (k === n) {
      let num = 0;
      for (let i = 0; i < n; i++) num += (base[i] - mean) * (perm[i] - mean);
      if (Math.abs(num / den) >= floor - 1e-12) hits++;
      total++;
      return;
    }
    for (let i = k; i < n; i++) {
      [perm[k], perm[i]] = [perm[i], perm[k]];
      walk(k + 1);
      [perm[k], perm[i]] = [perm[i], perm[k]];
    }
  };
  walk(0);
  const rate = hits / total;
  exactNullCache.set(n, rate);
  return rate;
}

/** P(X ≥ k) for X ~ Binomial(n, p). */
function binomTailGE(k: number, n: number, p: number): number {
  let tot = 0;
  for (let i = k; i <= n; i++) {
    tot += Math.exp(
      lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1) +
      i * Math.log(p) + (n - i) * Math.log(1 - p),
    );
  }
  return Math.min(1, tot);
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const rows: TaskRow[] = [];
const skipped: string[] = [];
const syntheticSkipped: string[] = [];

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
  // Open distance has no speed section, so most of the racecraft family is n/a.
  if (comp.scoring_format === 'open_distance') continue;
  const category: 'hg' | 'pg' = comp.category === 'pg' ? 'pg' : 'hg';

  for (const task of comp.tasks ?? []) {
    if (!task.dir || !task.date) continue;
    if (!existsSync(join(COMPS_DIR, task.dir, 'task.xctsk'))) continue;
    let loaded: { task: any; pilots: PilotFlight[] };
    try {
      loaded = readTaskDir(join(COMPS_DIR, task.dir));
    } catch (err) {
      skipped.push(`${task.dir}: ${err}`);
      continue;
    }
    if (loaded.pilots.length === 0) {
      skipped.push(`${task.dir}: no parseable tracks`);
      continue;
    }
    try {
      const gp: Partial<GAPParameters> = { ...(comp.gap_params ?? {}), ...(task.gap_params ?? {}) };
      const gap = resolveCompGapParams(category, gp);
      const distanceM = calculateOptimizedTaskDistance(loaded.task);
      if (gp.nominalDistance === undefined) gap.nominalDistance = distanceM * 0.7;
      const result = scoreTask(loaded.task, loaded.pilots, gap);
      const field = buildFieldContext(loaded.task, loaded.pilots, result, category);
      const report = evaluateField(field);

      const byId = new Map(report.metrics.map((m) => [m.id, m]));
      const windSeries: any = (byId.get('day.wind')?.extraSeries ?? [])
        .find((s: any) => s.kind === 'wind-hourly');
      const climbSeries: any = (byId.get('day.climb_by_hour')?.extraSeries ?? [])
        .find((s: any) => s.kind === 'climb-hourly');
      const whole = climbSeries?.wholeTask ?? null;
      const basis = report.basis;
      const split: any = basis.airtimeSplit ?? null;
      const scores = result.pilotScores;
      const goal = scores.filter((p) => p.madeGoal).length;
      const ess = scores.filter((p) => p.reachedESS).length;
      const window = basis.analysisWindow;

      rows.push({
        comp: comp.slug ?? name,
        task: task.dir,
        date: task.date,
        category,
        conditions: {
          windKmh: windSeries?.wholeTask?.speedKmh ?? null,
          climbMedian: whole?.median ?? null,
          climbP90: whole?.p90 ?? null,
          climbSpread: whole ? whole.p90 - whole.p10 : null,
          bandSpanM: basis.workingBandCeiling - basis.workingBandFloor,
          bandCeilingM: basis.workingBandCeiling,
          sharedThermals: basis.sharedThermalCount,
          multiPilotThermals: basis.multiPilotThermalCount,
          gaggleDensity: basis.sharedThermalCount > 0
            ? basis.multiPilotThermalCount / basis.sharedThermalCount : null,
          climbShare: split?.climbPct ?? null,
          glideShare: split?.glidePct ?? null,
          searchShare: split?.searchPct ?? null,
          taskDistanceKm: distanceM / 1000,
          goalRate: scores.length > 0 ? goal / scores.length : null,
          essRate: scores.length > 0 ? ess / scores.length : null,
          durationH: window
            ? (Date.parse(window.to) - Date.parse(window.from)) / 3.6e6 : null,
          fieldSize: report.pilots.length,
          month: Number(String(task.date).slice(5, 7)),
        },
        metrics: report.metrics
          .filter((m) => m.correlation)
          .map((m) => ({
            id: m.id,
            rho: m.correlation!.rho,
            n: m.correlation!.n,
            floor: m.correlation!.noiseFloor ?? spearmanNoiseFloor(m.correlation!.n),
          })),
      });
      process.stderr.write(
        `[${rows.length}] ${task.dir} — ${report.pilots.length} pilots\n`,
      );
    } catch (err) {
      skipped.push(`${task.dir}: ${err}`);
      process.stderr.write(`Warning: ${task.dir} failed: ${err}\n`);
    }
  }
}

if (rows.length === 0) {
  console.error(`No scorable tasks under ${COMPS_DIR}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Part 1 — is there any signal at all, once small fields are counted honestly?
// ---------------------------------------------------------------------------

interface PerMetric { rho: number; n: number; floor: number; row: TaskRow }
const byMetric = new Map<string, PerMetric[]>();
for (const row of rows) {
  for (const m of row.metrics) {
    if (!byMetric.has(m.id)) byMetric.set(m.id, []);
    byMetric.get(m.id)!.push({ rho: m.rho, n: m.n, floor: m.floor, row });
  }
}

console.log('');
console.log(`Metric conditions over ${new Set(rows.map((r) => r.comp)).size} comps / ${rows.length} tasks`);
if (syntheticSkipped.length > 0) {
  console.log(`Excluded ${syntheticSkipped.length} synthetic comp(s): ${syntheticSkipped.join(', ')}`);
}
console.log('');
console.log('1. IS THERE ANY SIGNAL?  cleared vs EXACT expected (the floor is ~5% only at large n;');
console.log('   at n = 3 it is 33%, so a 3-pilot task is not evidence)');
console.log('');
console.log(
  'metric'.padEnd(28) + 'cleared'.padStart(9) + 'expected'.padStart(10) +
  'ratio'.padStart(7) + 'p'.padStart(11) + `    >=${MIN_PILOTS} pilots`.padEnd(18),
);
console.log('-'.repeat(96));

const signalRank = [...byMetric.entries()].map(([id, rs]) => {
  const cleared = rs.filter((r) => Math.abs(r.rho) >= r.floor).length;
  const expected = rs.reduce((a, r) => a + exactNullRate(r.n), 0);
  const p = binomTailGE(cleared, rs.length, expected / rs.length);
  const big = rs.filter((r) => r.n >= MIN_PILOTS);
  const clearedBig = big.filter((r) => Math.abs(r.rho) >= r.floor).length;
  const pBig = big.length > 0 ? binomTailGE(clearedBig, big.length, 0.05) : 1;
  return { id, cleared, expected, ratio: cleared / Math.max(expected, 1e-9), p, clearedBig, nBig: big.length, pBig };
}).sort((a, b) => b.ratio - a.ratio);

for (const s of signalRank) {
  console.log(
    s.id.padEnd(28) +
    String(s.cleared).padStart(9) +
    s.expected.toFixed(1).padStart(10) +
    s.ratio.toFixed(2).padStart(7) +
    s.p.toExponential(1).padStart(11) +
    `    ${s.clearedBig}/${s.nBig}`.padEnd(11) +
    `p=${s.pBig.toExponential(1)}`,
  );
}

// ---------------------------------------------------------------------------
// Part 2 — does the day predict the sign?
// ---------------------------------------------------------------------------

interface CondTest {
  metric: string; condition: Condition; rho: number; n: number; p: number; q: number;
}
const tests: CondTest[] = [];
for (const m of ALL_METRICS) {
  const rs = (byMetric.get(m.id) ?? []).filter((r) => r.n >= MIN_PILOTS);
  for (const condition of CONDITIONS) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of rs) {
      const v = r.row.conditions[condition];
      if (v === null || !isFinite(v)) continue;
      xs.push(v);
      ys.push(r.rho);
    }
    if (xs.length < MIN_TASKS_FOR_TEST) continue;
    const rho = spearman(xs, ys);
    if (rho === null || !isFinite(rho)) continue;
    tests.push({ metric: m.id, condition, rho, n: xs.length, p: spearmanP(rho, xs.length), q: 0 });
  }
}
const qs = benjaminiHochberg(tests.map((t) => t.p));
tests.forEach((t, i) => { t.q = qs[i]; });

console.log('');
console.log(`2. DOES THE DAY PREDICT THE SIGN?  Spearman(per-task ρ, condition), fields >= ${MIN_PILOTS} pilots`);
console.log(`   ${tests.length} (metric, condition) pairs tested; q = Benjamini-Hochberg over all of them.`);
console.log('');

const hits = tests.filter((t) => t.q < FDR_Q).sort((a, b) => a.p - b.p);
if (hits.length === 0) {
  console.log('   No condition survives the FDR threshold for any metric.');
} else {
  console.log(
    'metric'.padEnd(28) + 'condition'.padEnd(20) + 'ρ'.padStart(7) +
    'n'.padStart(6) + 'p'.padStart(11) + 'q'.padStart(9),
  );
  console.log('-'.repeat(82));
  for (const t of hits) {
    console.log(
      t.metric.padEnd(28) + t.condition.padEnd(20) +
      (t.rho >= 0 ? '+' : '') + t.rho.toFixed(2).padStart(6) +
      String(t.n).padStart(6) + t.p.toExponential(1).padStart(11) + t.q.toFixed(3).padStart(9),
    );
  }
}

// ---------------------------------------------------------------------------
// Part 3 — what each surviving split actually looks like
// ---------------------------------------------------------------------------

console.log('');
console.log('3. THE SURVIVING SPLITS, BY QUARTILE OF THE CONDITION');
console.log('   "informative" = |ρ| cleared that task\'s own noise floor.');

const seen = new Set<string>();
for (const t of hits) {
  if (seen.has(t.metric)) continue; // strongest condition per metric is enough
  seen.add(t.metric);
  const rs = (byMetric.get(t.metric) ?? [])
    .filter((r) => r.n >= MIN_PILOTS && r.row.conditions[t.condition] !== null)
    .sort((a, b) => (a.row.conditions[t.condition]! - b.row.conditions[t.condition]!));
  const q = Math.floor(rs.length / 4);
  if (q < 3) continue;
  console.log('');
  console.log(`   ${t.metric} by ${t.condition}  (ρ=${t.rho >= 0 ? '+' : ''}${t.rho.toFixed(2)}, q=${t.q.toFixed(3)})`);
  console.log(
    '     ' + 'quartile'.padEnd(10) + 'range'.padStart(20) +
    'median ρ'.padStart(11) + 'informative'.padStart(13) + 'sign'.padStart(8),
  );
  const groups = [rs.slice(0, q), rs.slice(q, 2 * q), rs.slice(2 * q, 3 * q), rs.slice(3 * q)];
  groups.forEach((g, i) => {
    if (g.length === 0) return;
    const lo = g[0].row.conditions[t.condition]!;
    const hi = g[g.length - 1].row.conditions[t.condition]!;
    const med = median(g.map((r) => r.rho));
    const inf = g.filter((r) => Math.abs(r.rho) >= r.floor);
    const neg = inf.filter((r) => r.rho < 0).length;
    const sign = inf.length > 0
      ? `${Math.round((100 * Math.max(neg, inf.length - neg)) / inf.length)}%` : '—';
    console.log(
      '     ' + `Q${i + 1}`.padEnd(10) +
      `${lo.toFixed(2)}..${hi.toFixed(2)}`.padStart(20) +
      ((med >= 0 ? '+' : '') + med.toFixed(2)).padStart(11) +
      `${inf.length}/${g.length}`.padStart(13) + sign.padStart(8),
    );
  });
}

// ---------------------------------------------------------------------------
// Part 4 — outright sign reversals
// ---------------------------------------------------------------------------

console.log('');
console.log('4. OUTRIGHT SIGN REVERSALS');
console.log('   Both extreme quartiles informative on >= 4 tasks AND >= 75% agreed, opposite ways.');
console.log('');

let reversals = 0;
for (const [id, rs0] of byMetric) {
  for (const condition of CONDITIONS) {
    const rs = rs0
      .filter((r) => r.n >= MIN_PILOTS && r.row.conditions[condition] !== null)
      .sort((a, b) => (a.row.conditions[condition]! - b.row.conditions[condition]!));
    if (rs.length < 4 * MIN_TASKS_FOR_TEST / 2) continue;
    const q = Math.floor(rs.length / 4);
    const camp = (g: PerMetric[]): 'pos' | 'neg' | null => {
      const inf = g.filter((r) => Math.abs(r.rho) >= r.floor);
      if (inf.length < 4) return null;
      const neg = inf.filter((r) => r.rho < 0).length;
      const frac = Math.max(neg, inf.length - neg) / inf.length;
      if (frac < 0.75) return null;
      return neg > inf.length - neg ? 'neg' : 'pos';
    };
    const lo = camp(rs.slice(0, q));
    const hi = camp(rs.slice(-q));
    if (lo && hi && lo !== hi) {
      console.log(`   ${id.padEnd(28)} ${condition.padEnd(18)} low=${lo}  high=${hi}`);
      reversals++;
    }
  }
}
if (reversals === 0) console.log('   None.');

if (skipped.length > 0) {
  console.log('');
  console.log(`Skipped ${skipped.length} task(s):`);
  for (const s of skipped.slice(0, 20)) console.log(`  ${s}`);
  if (skipped.length > 20) console.log(`  … and ${skipped.length - 20} more`);
}

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({
    meta: {
      compsDir: resolve(COMPS_DIR),
      comps: new Set(rows.map((r) => r.comp)).size,
      tasks: rows.length,
      minPilots: MIN_PILOTS,
      fdrQ: FDR_Q,
      syntheticCompsExcluded: syntheticSkipped,
      generatedAt: new Date().toISOString(),
    },
    signal: signalRank,
    conditionTests: tests,
    tasks: rows,
  }, null, 2));
  console.log('');
  console.log(`Wrote ${jsonPath}`);
}
