#!/usr/bin/env bun
/**
 * A targeted probe for one defect in `race.leg_time_lost`, kept separate from
 * audit-metric-distributions.ts because it asks a question that sweep cannot:
 * not "how strong is this metric's ρ" but "what makes it collapse".
 *
 * The metric sums `max(0, legTime − reference)` over the legs the pilot
 * COMPLETED. A pilot who lands after one leg accumulates one loss term; one who
 * flies the whole speed section slightly slowly accumulates six. Under
 * `direction: 'lower'`, landing early therefore scores better — and the metric
 * carries `outcome: true` on the grounds that it "follows the result by
 * construction", which holds only when the field completes the speed section.
 *
 * So for every task this reports, beside the metric's own ρ against GAP rank:
 *   - the share of the field that completed only part of the speed section,
 *   - ρ between the loss sum and the number of legs completed,
 *   - the counterfactual ρ over the full finishers alone.
 *
 * If the diagnosis is right, ρ against rank falls away as the partial-finisher
 * share rises, and restricting to full finishers restores it.
 *
 *   bun web/scripts/audit-leg-time-lost.ts
 *   GLIDECOMP_COMPS_DIR=../glidecomp-archive/comps \
 *     bun web/scripts/audit-leg-time-lost.ts --json out.json
 *
 * Options:
 *   --json <path>          Write the per-task rows as JSON.
 *   --include-synthetic    Also probe comps whose manifest sets `synthetic`.
 *
 * Deliberately cheap: it needs only scoreTask and the retained
 * `turnpointResult`, never buildFieldContext, so it sweeps the whole archive in
 * a couple of minutes. It re-implements the metric's leg-time walk rather than
 * importing it (the helper is private to the racecraft family); the two must be
 * read together if either changes.
 *
 * Scoring mirrors audit-metric-distributions.ts: the manifest's comp-level
 * `gap_params` with the task's own merged over them (migration 0021), and an
 * unpinned nominal distance resolved to 70% of the optimised task distance.
 * The params decide the RANK, and the rank is what every ρ here is measured
 * against.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scoreTask, type GAPParameters, type PilotFlight } from '../engine/src/gap-scoring';
import { resolveCompGapParams } from '../engine/src/gap-params';
import { calculateOptimizedTaskDistance } from '../engine/src/task-optimizer';
import { getEffectiveSSSIndex, getEffectiveESSIndex } from '../engine/src/xctsk-parser';
import { spearman, spearmanNoiseFloor, mean, median } from '../engine/src/analysis/stats';
import { readTaskDir } from '../engine/cli/comp-manifest';

const COMPS_DIR =
  process.env.GLIDECOMP_COMPS_DIR ?? join(import.meta.dir, '..', 'samples', 'comps');

const argv = process.argv.slice(2);
const jsonAt = argv.indexOf('--json');
const jsonPath = jsonAt >= 0 ? argv[jsonAt + 1] : null;
const includeSynthetic = argv.includes('--include-synthetic');

/**
 * The metric's own leg-time walk (racecraft.ts `speedSectionLegTimes`): a leg
 * is a consecutive pair of reachings within [sssIdx, essIdx] whose task indices
 * are adjacent. A pair spanning a gap is not a completed leg.
 */
function speedSectionLegTimes(
  sequence: { taskIndex: number; time: Date }[],
  sssIdx: number,
  essIdx: number,
): Map<string, number> {
  const seq = sequence.filter((r) => r.taskIndex >= sssIdx && r.taskIndex <= essIdx);
  const times = new Map<string, number>();
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i];
    const b = seq[i + 1];
    if (b.taskIndex !== a.taskIndex + 1) continue;
    times.set(`${a.taskIndex}-${b.taskIndex}`, (b.time.getTime() - a.time.getTime()) / 1000);
  }
  return times;
}

interface TaskRow {
  comp: string;
  task: string;
  /** Legs in the speed section. */
  totalLegs: number;
  /** Pilots with at least one completed leg (the metric's own population). */
  n: number;
  fieldSize: number;
  partialFinishers: number;
  partialShare: number;
  /** The metric as shipped: ρ against GAP rank over every pilot with a value. */
  rhoVsRank: number | null;
  /** ρ between the loss sum and the number of legs completed. */
  rhoVsLegsDone: number | null;
  /** The counterfactual: ρ against rank over the full finishers alone. */
  rhoVsRankFullOnly: number | null;
  fullFinishers: number;
  noiseFloor: number;
}

const rows: TaskRow[] = [];
const skipped: string[] = [];
const syntheticSkipped: string[] = [];
const comps = new Set<string>();

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
  // An open-distance comp has no speed section, so the metric never runs.
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
      const gapParams: Partial<GAPParameters> = {
        ...(comp.gap_params ?? {}),
        ...(task.gap_params ?? {}),
      };
      const gap = resolveCompGapParams(category, gapParams);
      if (gapParams.nominalDistance === undefined) {
        gap.nominalDistance = calculateOptimizedTaskDistance(loaded.task) * 0.7;
      }
      const result = scoreTask(loaded.task, loaded.pilots, gap);

      const sssIdx = getEffectiveSSSIndex(loaded.task);
      const essIdx = getEffectiveESSIndex(loaded.task);
      if (sssIdx < 0 || essIdx <= sssIdx) continue;
      const totalLegs = essIdx - sssIdx;

      const scores = [...result.pilotScores].sort((a, b) => a.rank - b.rank);
      const timesByPilot = new Map<string, Map<string, number>>();
      for (const p of scores) {
        timesByPilot.set(
          p.trackFile,
          speedSectionLegTimes(p.turnpointResult.sequence, sssIdx, essIdx),
        );
      }

      // The metric's reference: mean leg time of the top-10-by-rank pilots who
      // completed the leg.
      const top = scores.slice(0, Math.min(10, scores.length));
      const topMeanByLeg = new Map<string, number>();
      for (let i = sssIdx; i < essIdx; i++) {
        const key = `${i}-${i + 1}`;
        const vals: number[] = [];
        for (const p of top) {
          const t = timesByPilot.get(p.trackFile)?.get(key);
          if (t !== undefined) vals.push(t);
        }
        if (vals.length > 0) topMeanByLeg.set(key, mean(vals));
      }

      const values: number[] = [];
      const ranks: number[] = [];
      const legsDone: number[] = [];
      for (const p of scores) {
        const own = timesByPilot.get(p.trackFile)!;
        if (own.size === 0) continue; // the metric returns n/a here
        let lost = 0;
        for (const [key, t] of own) {
          const ref = topMeanByLeg.get(key);
          if (ref !== undefined) lost += Math.max(0, t - ref);
        }
        values.push(lost);
        ranks.push(p.rank);
        legsDone.push(own.size);
      }
      if (values.length < 3) continue;

      const fullValues: number[] = [];
      const fullRanks: number[] = [];
      for (let i = 0; i < values.length; i++) {
        if (legsDone[i] === totalLegs) {
          fullValues.push(values[i]);
          fullRanks.push(ranks[i]);
        }
      }
      const partial = legsDone.filter((l) => l < totalLegs).length;

      comps.add(comp.slug ?? name);
      rows.push({
        comp: comp.slug ?? name,
        task: task.dir,
        totalLegs,
        n: values.length,
        fieldSize: scores.length,
        partialFinishers: partial,
        partialShare: partial / values.length,
        rhoVsRank: spearman(values, ranks),
        rhoVsLegsDone: spearman(values, legsDone),
        rhoVsRankFullOnly:
          fullValues.length >= 3 ? spearman(fullValues, fullRanks) : null,
        fullFinishers: fullValues.length,
        noiseFloor: spearmanNoiseFloor(values.length),
      });
      process.stderr.write(
        `${task.dir}: n=${values.length}, ${partial} partial, ` +
          `ρ=${rows[rows.length - 1].rhoVsRank?.toFixed(2) ?? '—'}\n`,
      );
    } catch (err) {
      skipped.push(`${task.dir}: ${err}`);
      process.stderr.write(`Warning: ${task.dir} failed: ${err}\n`);
    }
  }
}

if (rows.length === 0) {
  console.error(`No scorable speed-section tasks under ${COMPS_DIR}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const BANDS: { label: string; lo: number; hi: number }[] = [
  { label: 'none partial (0%)', lo: 0, hi: 0 },
  { label: 'few partial (<25%)', lo: 0, hi: 0.25 },
  { label: 'some partial (25–50%)', lo: 0.25, hi: 0.5 },
  { label: 'many partial (50–90%)', lo: 0.5, hi: 0.9 },
  { label: 'mostly partial (≥90%)', lo: 0.9, hi: Infinity },
];

function bandOf(share: number): string {
  if (share === 0) return BANDS[0].label;
  for (const b of BANDS.slice(1)) if (share >= b.lo && share < b.hi) return b.label;
  return BANDS[BANDS.length - 1].label;
}

const num = (v: number | null, digits = 2) =>
  v === null || !isFinite(v) ? '    —' : (v >= 0 ? '+' : '') + v.toFixed(digits);

/** `spearman` yields NaN when a side has no variance — every pilot completed
 * the same number of legs. That is "no correlation", exactly like null. */
const finite = (v: number | null): v is number => v !== null && isFinite(v);

console.log('');
console.log(`race.leg_time_lost — ${rows.length} speed-section tasks over ${comps.size} comps`);
console.log(`(${resolve(COMPS_DIR)})`);
if (syntheticSkipped.length > 0) {
  console.log(`Excluded ${syntheticSkipped.length} synthetic comp(s): ${syntheticSkipped.join(', ')}`);
}
console.log('');
console.log('If the metric followed the result by construction, ρ vs rank would sit near +1');
console.log('on every row. It does that only where the field completed the speed section.');
console.log('');
console.log(
  'partial-finisher band'.padEnd(24) +
    'tasks'.padStart(6) +
    '  med ρ vs rank'.padStart(16) +
    '  med ρ vs legs'.padStart(16) +
    '  ρ≤0'.padStart(6),
);
console.log('-'.repeat(70));
for (const b of BANDS) {
  const inBand = rows.filter((r) => bandOf(r.partialShare) === b.label);
  if (inBand.length === 0) continue;
  const rr = inBand.map((r) => r.rhoVsRank).filter(finite);
  const rl = inBand.map((r) => r.rhoVsLegsDone).filter(finite);
  console.log(
    b.label.padEnd(24) +
      String(inBand.length).padStart(6) +
      num(rr.length > 0 ? median(rr) : null).padStart(16) +
      num(rl.length > 0 ? median(rl) : null).padStart(16) +
      String(rr.filter((v) => v <= 0).length).padStart(6),
  );
}

// The counterfactual, over the tasks where both populations exist.
const both = rows.filter(
  (r) => r.partialShare > 0 && finite(r.rhoVsRank) && finite(r.rhoVsRankFullOnly),
);
if (both.length > 0) {
  const all = median(both.map((r) => r.rhoVsRank!));
  const full = median(both.map((r) => r.rhoVsRankFullOnly!));
  const raised = both.filter((r) => r.rhoVsRankFullOnly! > r.rhoVsRank!).length;
  console.log('');
  console.log(`Counterfactual over the ${both.length} task(s) with both partial and full finishers:`);
  console.log(`  median ρ vs rank, every pilot with a value : ${num(all)}`);
  console.log(`  median ρ vs rank, full finishers only      : ${num(full)}`);
  console.log(
    `  dropping the partial finishers RAISES ρ on ${raised}/${both.length} ` +
      `(${Math.round((100 * raised) / both.length)}%)`,
  );
}

const inverted = rows.filter((r) => finite(r.rhoVsRank) && r.rhoVsRank < -r.noiseFloor);
console.log('');
console.log(
  `Sign inverted (ρ vs rank significantly negative — a LOWER loss sum went with a ` +
    `WORSE result): ${inverted.length}/${rows.length} task(s)`,
);
for (const r of inverted.sort((a, b) => a.rhoVsRank! - b.rhoVsRank!)) {
  console.log(
    `  ${r.task.padEnd(38)} n=${String(r.n).padStart(3)} ` +
      `partial=${r.partialFinishers}/${r.n} ρ=${num(r.rhoVsRank)} floor=${r.noiseFloor.toFixed(2)}`,
  );
}

if (skipped.length > 0) {
  console.log('');
  console.log(`Skipped ${skipped.length} task(s):`);
  for (const s of skipped.slice(0, 20)) console.log(`  ${s}`);
  if (skipped.length > 20) console.log(`  … and ${skipped.length - 20} more`);
}

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        meta: {
          compsDir: resolve(COMPS_DIR),
          comps: comps.size,
          tasks: rows.length,
          syntheticCompsExcluded: syntheticSkipped,
          generatedAt: new Date().toISOString(),
        },
        tasks: rows,
      },
      null,
      2,
    ),
  );
  console.log('');
  console.log(`Wrote ${jsonPath}`);
}
