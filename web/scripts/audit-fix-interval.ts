#!/usr/bin/env bun
/**
 * Does a pilot's LOGGER move their task-analysis metrics?
 *
 * Every metric is ranked across one field, so anything that changes a value
 * for reasons other than flying — here, how often the instrument records a
 * position — changes the pilot's place in the field. This sweep measures it
 * the only way that separates the logger from the pilot: take the 1 Hz
 * pilots, thin a fixed ~25% of them to a coarser logger by dropping B records
 * BEFORE parsing (so altitude cleaning runs on the coarse log, as it would for
 * real), leave everyone else as logged, and see how far the thinned pilots'
 * percentiles in the field move. A metric that reads behaviour should not
 * care; one that reads the logger shifts its thinned pilots one way.
 *
 * It is the evidence behind detectThermals' seconds-based windows and the
 * per-metric limits in analysis/metrics/util.ts (CIRCLE_DETAIL_MAX_INTERVAL_S,
 * THERMAL_EDGE_MAX_INTERVAL_S); see docs/2026-10-20-logger-interval-evidence.md.
 * Re-run it before moving either.
 *
 *   bun web/scripts/audit-fix-interval.ts
 *   GLIDECOMP_COMPS_DIR=<bundled+archive merged> bun web/scripts/audit-fix-interval.ts
 *
 * Options:
 *   --steps 2,5,10   coarse intervals to test (seconds)
 *   --limit <n>      stop after n tasks
 *   --shard i/n      only every n-th task, from the i-th (run n of them at once)
 *   --partial <path> write the shard's tallies as JSON instead of the report
 *   --merge <paths…> print the report from shards' --partial files
 *
 * The full archive is about three CPU-hours, so shard it:
 *   for i in 0 1 2 3; do bun web/scripts/audit-fix-interval.ts \
 *     --shard $i/4 --partial /tmp/fix.$i.json & done; wait
 *   bun web/scripts/audit-fix-interval.ts --merge /tmp/fix.*.json
 *
 * Synthetic comps are excluded, as in audit-metric-distributions.ts: their
 * forged tracks carry no behaviour to disturb. Roughly 4× that sweep's time.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { scoreTask, type GAPParameters, type PilotFlight } from '../engine/src/gap-scoring';
import { resolveCompGapParams } from '../engine/src/gap-params';
import { scoreOpenDistance } from '../engine/src/open-distance-scoring';
import { calculateOptimizedTaskDistance } from '../engine/src/task-optimizer';
import { buildFieldContext, evaluateField } from '../engine/src/analysis';
import { parseIGC } from '../engine/src/igc-parser';
import { parseXCTask, type XCTask } from '../engine/src/xctsk-parser';
import { percentile } from '../engine/src/analysis/stats';

const COMPS_DIR =
  process.env.GLIDECOMP_COMPS_DIR ?? join(import.meta.dir, '..', 'samples', 'comps');
const argv = process.argv.slice(2);
const stepsAt = argv.indexOf('--steps');
const STEPS = stepsAt >= 0 ? argv[stepsAt + 1].split(',').map(Number) : [2, 5, 10];
const limitAt = argv.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(argv[limitAt + 1]) : Infinity;
const shardAt = argv.indexOf('--shard');
const [SHARD, SHARDS] = shardAt >= 0 ? argv[shardAt + 1].split('/').map(Number) : [0, 1];
const partialAt = argv.indexOf('--partial');
const PARTIAL = partialAt >= 0 ? argv[partialAt + 1] : null;
const mergeAt = argv.indexOf('--merge');
const MERGE = mergeAt >= 0 ? argv.slice(mergeAt + 1) : null;
/** Field-level metrics publish no per-pilot value to shift. */
const SKIP = new Set(['day.wind', 'day.climb_by_hour']);

interface Spec {
  dir: string;
  category: 'hg' | 'pg';
  openDistance: boolean;
  gapParams: Partial<GAPParameters>;
}

function collect(): Spec[] {
  const out: Spec[] = [];
  for (const name of readdirSync(COMPS_DIR).sort()) {
    const manifest = join(COMPS_DIR, name, 'comp.json');
    if (!existsSync(manifest)) continue;
    const comp = JSON.parse(readFileSync(manifest, 'utf8'));
    if (comp.synthetic === true) continue;
    for (const task of comp.tasks ?? []) {
      if (!task.dir || !existsSync(join(COMPS_DIR, task.dir, 'task.xctsk'))) continue;
      out.push({
        dir: join(COMPS_DIR, task.dir),
        category: comp.category === 'pg' ? 'pg' : 'hg',
        openDistance: comp.scoring_format === 'open_distance',
        gapParams: { ...(comp.gap_params ?? {}), ...(task.gap_params ?? {}) },
      });
    }
  }
  return out;
}

const bSeconds = (line: string) =>
  Number(line.slice(1, 3)) * 3600 + Number(line.slice(3, 5)) * 60 + Number(line.slice(5, 7));
const isFix = (line: string) => line[0] === 'B' && line.length >= 35;

/** The modal gap between B records, ignoring gaps over 2 minutes. */
function modalInterval(text: string): number | null {
  const counts = new Map<number, number>();
  let prev: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!isFix(line)) continue;
    const t = bSeconds(line);
    if (prev !== null) {
      const d = (t - prev + 86400) % 86400;
      if (d > 0 && d < 120) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    prev = t;
  }
  let best: number | null = null;
  for (const [d, n] of counts) if (best === null || n > counts.get(best)!) best = d;
  return best;
}

/** Keep a B record only once `step` seconds have passed since the last kept. */
function thin(text: string, step: number): string {
  const out: string[] = [];
  let last: number | null = null;
  let prevRaw: number | null = null;
  let dayOffset = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!isFix(line)) {
      out.push(line);
      continue;
    }
    const raw = bSeconds(line);
    if (prevRaw !== null && raw < prevRaw - 43200) dayOffset += 86400;
    prevRaw = raw;
    const t = raw + dayOffset;
    if (last === null || t - last >= step) {
      out.push(line);
      last = t;
    }
  }
  return out.join('\n');
}

function flights(files: { path: string; text: string }[]): PilotFlight[] {
  const out: PilotFlight[] = [];
  for (const f of files) {
    try {
      const igc = parseIGC(f.text);
      if (igc.fixes.length === 0) continue;
      const pilotName = igc.header.pilot || igc.header.competitionId || basename(f.path, '.igc');
      out.push({ pilotName, trackFile: f.path, fixes: igc.fixes });
    } catch {
      // unparseable: the shipped loader skips it too
    }
  }
  return out;
}

/** metric id → trackFile → value, for one analysis of the field. */
function analyse(spec: Spec, task: XCTask, pilots: PilotFlight[]): Map<string, Map<string, number | null>> {
  let result;
  if (spec.openDistance) {
    result = scoreOpenDistance(task, pilots);
  } else {
    const gap = resolveCompGapParams(spec.category, spec.gapParams);
    if (spec.gapParams.nominalDistance === undefined) {
      gap.nominalDistance = calculateOptimizedTaskDistance(task) * 0.7;
    }
    result = scoreTask(task, pilots, gap);
  }
  const report = evaluateField(buildFieldContext(task, pilots, result, spec.category));
  const out = new Map<string, Map<string, number | null>>();
  for (const m of report.metrics) {
    if (SKIP.has(m.id)) continue;
    out.set(
      m.id,
      new Map(m.perPilot.map((p) => [p.trackFile, p.value !== null && Number.isFinite(p.value) ? p.value : null])),
    );
  }
  return out;
}

/** Percentile (0–100) of each pilot's value within the field; ties averaged. */
function percentiles(values: Map<string, number | null>): Map<string, number> {
  const known = [...values].filter((e): e is [string, number] => e[1] !== null).sort((a, b) => a[1] - b[1]);
  const out = new Map<string, number>();
  if (known.length < 2) return out;
  for (let i = 0; i < known.length; ) {
    let j = i;
    while (j + 1 < known.length && known[j + 1][1] === known[i][1]) j++;
    for (let k = i; k <= j; k++) out.set(known[k][0], (100 * (i + j)) / 2 / (known.length - 1));
    i = j + 1;
  }
  return out;
}

/** Deterministic per-task subset, so a re-run thins the same pilots. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * What a sweep (or a shard of one) accumulates. Plain objects, so a shard can
 * write it as JSON for --merge.
 *  shifts: metric → step → the per-task mean shift of its thinned pilots
 *  lost:   metric → step → [thinned pilots left without a value, thinned pilots that had one]
 */
interface Tallies {
  tasks: number;
  intervals: Record<string, number>;
  shifts: Record<string, Record<number, number[]>>;
  lost: Record<string, Record<number, [number, number]>>;
}

function sweep(): Tallies {
  const acc: Tallies = { tasks: 0, intervals: {}, shifts: {}, lost: {} };
  for (const [k, spec] of collect().entries()) {
    if (acc.tasks >= LIMIT) break;
    if (k % SHARDS !== SHARD) continue;
    sweepTask(spec, acc);
  }
  return acc;
}

function sweepTask(spec: Spec, acc: Tallies): void {
  const entries = readdirSync(spec.dir);
  const task = parseXCTask(readFileSync(join(spec.dir, entries.find((f) => f.endsWith('.xctsk'))!), 'utf-8'));
  const files = entries
    .filter((f) => f.toLowerCase().endsWith('.igc'))
    .sort()
    .map((f) => ({ path: join(spec.dir, f), text: readFileSync(join(spec.dir, f), 'utf-8') }));
  const intervals = new Map(files.map((f) => [f.path, modalInterval(f.text)]));
  try {
    const base = analyse(spec, task, flights(files));
    const ones = files.filter((f) => intervals.get(f.path) === 1).map((f) => f.path);
    if (base.size === 0 || ones.length === 0) return;
    for (const iv of intervals.values()) {
      const k = iv === null ? 'unknown' : iv >= 10 ? '>=10 s' : `${iv} s`;
      acc.intervals[k] = (acc.intervals[k] ?? 0) + 1;
    }
    const subset = new Set(ones.filter((p) => hash(`${p}`) < 0.25));
    if (subset.size === 0) subset.add(ones[0]);
    for (const step of STEPS) {
      const thinned = analyse(
        spec,
        task,
        flights(files.map((f) => (subset.has(f.path) ? { path: f.path, text: thin(f.text, step) } : f))),
      );
      for (const [id, before] of base) {
        const after = thinned.get(id);
        if (!after) continue;
        const pb = percentiles(before);
        const pa = percentiles(after);
        const moved: number[] = [];
        acc.lost[id] ??= {};
        const counts = (acc.lost[id][step] ??= [0, 0]);
        for (const p of subset) {
          if (before.get(p) === null || before.get(p) === undefined) continue;
          counts[1]++;
          if (after.get(p) === null || after.get(p) === undefined) {
            counts[0]++;
            continue;
          }
          if (pb.has(p) && pa.has(p)) moved.push(pa.get(p)! - pb.get(p)!);
        }
        if (moved.length === 0) continue;
        acc.shifts[id] ??= {};
        (acc.shifts[id][step] ??= []).push(moved.reduce((a, b) => a + b, 0) / moved.length);
      }
    }
    acc.tasks++;
    process.stderr.write(`[${acc.tasks}] ${basename(spec.dir)}: ${files.length} tracks, ${subset.size} thinned\n`);
  } catch (err) {
    process.stderr.write(`Warning: ${spec.dir} failed: ${err}\n`);
  }
}

function merge(parts: Tallies[]): Tallies {
  const acc: Tallies = { tasks: 0, intervals: {}, shifts: {}, lost: {} };
  for (const part of parts) {
    acc.tasks += part.tasks;
    for (const [k, n] of Object.entries(part.intervals)) acc.intervals[k] = (acc.intervals[k] ?? 0) + n;
    for (const [id, perStep] of Object.entries(part.shifts)) {
      acc.shifts[id] ??= {};
      for (const [step, xs] of Object.entries(perStep)) (acc.shifts[id][Number(step)] ??= []).push(...xs);
    }
    for (const [id, perStep] of Object.entries(part.lost)) {
      acc.lost[id] ??= {};
      for (const [step, [gone, of]] of Object.entries(perStep)) {
        const c = (acc.lost[id][Number(step)] ??= [0, 0]);
        c[0] += gone;
        c[1] += of;
      }
    }
  }
  return acc;
}

/** Mean of per-task means, with a 95% bootstrap interval over tasks. */
function meanCI(xs: number[]): [number, number, number] {
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const boots: number[] = [];
  for (let b = 0; b < 1000; b++) boots.push(mean(xs.map(() => xs[Math.floor(rand() * xs.length)])));
  boots.sort((a, b) => a - b);
  return [mean(xs), percentile(boots, 2.5), percentile(boots, 97.5)];
}

function report(acc: Tallies): void {
  const order = (k: string) => (k === 'unknown' ? 1e9 : k.startsWith('>=') ? 1e8 : Number.parseFloat(k));
  const total = Object.values(acc.intervals).reduce((a, b) => a + b, 0);
  console.log(`Logger fix interval over ${acc.tasks} tasks (${total} tracks, modal gap between B records):`);
  for (const [k, n] of Object.entries(acc.intervals).sort((a, b) => order(a[0]) - order(b[0]))) {
    console.log(`  ${k.padEnd(8)} ${String(n).padStart(5)}  ${((100 * n) / total).toFixed(1)}%`);
  }

  const steps = [...new Set(Object.values(acc.lost).flatMap((m) => Object.keys(m).map(Number)))].sort((a, b) => a - b);
  console.log(`\nMean percentile shift of the thinned pilots within their field [95% CI over tasks], and the share`);
  console.log(`of them the metric left out. A behaviour metric should read ~0 at every step.\n`);
  console.log(`  ${'metric'.padEnd(28)}` + steps.map((s) => `${`${s} s`.padStart(22)}`).join(''));
  for (const id of Object.keys(acc.lost)) {
    const cells = steps.map((s) => {
      const xs = acc.shifts[id]?.[s];
      const [gone, of] = acc.lost[id]?.[s] ?? [0, 0];
      if (!xs || xs.length === 0) return (of > 0 && gone === of ? 'all left out' : '—').padStart(22);
      const [m, lo, hi] = meanCI(xs);
      const out = of > 0 ? ` ${Math.round((100 * gone) / of)}%` : '';
      return `${m >= 0 ? '+' : ''}${m.toFixed(1)} [${lo.toFixed(0)},${hi.toFixed(0)}]${out}`.padStart(22);
    });
    console.log(`  ${id.padEnd(28)}${cells.join('')}`);
  }
}

if (MERGE) {
  report(merge(MERGE.map((f) => JSON.parse(readFileSync(f, 'utf8')) as Tallies)));
} else {
  const acc = sweep();
  if (PARTIAL) writeFileSync(PARTIAL, JSON.stringify(acc));
  else report(acc);
}
