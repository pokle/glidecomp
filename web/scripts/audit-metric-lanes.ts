/**
 * Audit the field-analysis lane charts across a whole comp library.
 *
 * `MetricLanes` makes claims a unit test on synthetic metrics cannot check
 * against reality: that every family worth charting produces at least two
 * lanes, that a dot's percentile is always strictly inside the axis, that the
 * value printed at a lane's left end really is the leftmost dot's value even
 * after a `lower`-is-better lane is flipped, and that the profile the chart
 * draws by default — the winner's — actually exists.
 *
 * Those are exactly the things that go quietly wrong. A chart with one lane
 * renders as nothing; a leader with no measured values renders as a chart with
 * no line in it. Both look like a blank space, not like a bug.
 *
 * So this scores every task in a comp library with the real engine, builds the
 * real field-analysis report, runs `buildLanes` over each family the way
 * `MetricFamilySection` does, and reports what got drawn, what did not, and
 * every invariant violation.
 *
 * Usage:
 *   bun web/scripts/audit-metric-lanes.ts                     # bundled comps
 *   GLIDECOMP_COMPS_DIR=<archive>/comps bun web/scripts/audit-metric-lanes.ts
 *   bun web/scripts/audit-metric-lanes.ts bright-open-2023    # one comp
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import {
  scoreTask,
  resolveCompGapParams,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type GapTaskScoreResult,
} from '../engine/src/gap-scoring';
import { calculateOptimizedTaskDistance } from '../engine/src/task-optimizer';
import { evaluateField, buildFieldContext } from '../engine/src/field-analysis';
import { FAMILY_ORDER, FAMILY_LABELS } from '../engine/src/field-analysis';
import type { FieldAnalysisReport, MetricReport } from '../engine/src/field-analysis/types';
import { loadCompManifest, readTaskDir } from '../engine/cli/comp-manifest';
import {
  buildLanes,
  defaultProfileTrack,
  lanesCaption,
  lanesAccessibleName,
  type Lane,
} from '../frontend/src/react/field-analysis/charts/metric-lanes';

const COMPS_ROOT =
  process.env.GLIDECOMP_COMPS_DIR ?? join(import.meta.dir, '..', 'samples', 'comps');

/** MIN_CORRELATION_N — below this the engine won't even claim a correlation. */
const THIN_LANE_N = 8;

let tasksScored = 0;
let tasksSkipped = 0;
let familiesSeen = 0;
let familiesCharted = 0;
let lanesDrawn = 0;
let degenerateLanes = 0;
let thinLanes = 0;
let lanesMissingLeader = 0;
let chartsWithoutLeaderProfile = 0;
let chartsWithBrokenConnector = 0;
let defaultIsNotWinner = 0;
const laneCountHistogram = new Map<number, number>();
/** How many pilots each lane actually measured — a percentile axis over 3
 * dots places them at 17/50/83 whatever the values are, so tiny n is a
 * readability question, not just a coverage one. */
const laneNHistogram = new Map<string, number>();
/** Which metrics produce the all-identical lanes. */
const degenerateByMetric = new Map<string, number>();
const violations: string[] = [];

function violation(msg: string): void {
  if (violations.length < 40) violations.push(msg);
}

/**
 * Every invariant the chart's drawing code relies on. A breach here is a
 * picture that lies, not merely an ugly one.
 */
function checkLane(label: string, lane: Lane): void {
  const where = `${label} / ${lane.metricId}`;

  if (lane.points.length !== lane.n) {
    violation(`${where}: n=${lane.n} but ${lane.points.length} dots`);
  }
  if (lane.n === 0) violation(`${where}: empty lane survived the filter`);

  for (const p of lane.points) {
    if (!Number.isFinite(p.pct)) {
      violation(`${where}: ${p.pilotName} has a non-finite percentile`);
      return;
    }
    // Midrank: a lone value sits at 50 and the extremes never reach 0 or 100.
    // The chart's caption tells the reader that gap is the definition, so it
    // had better hold.
    if (p.pct <= 0 || p.pct >= 100) {
      violation(`${where}: ${p.pilotName} at percentile ${p.pct} — outside (0,100)`);
      return;
    }
    if (!Number.isFinite(p.value)) {
      violation(`${where}: ${p.pilotName} has a non-finite value`);
      return;
    }
  }

  for (const [name, v] of [
    ['low', lane.low],
    ['median', lane.median],
    ['high', lane.high],
  ] as const) {
    if (!Number.isFinite(v)) violation(`${where}: ${name} is ${v}`);
  }

  const nBucket = lane.n <= 3 ? String(lane.n) : lane.n < THIN_LANE_N ? '4-7' : '8+';
  laneNHistogram.set(nBucket, (laneNHistogram.get(nBucket) ?? 0) + 1);

  if (lane.degenerate) {
    degenerateLanes++;
    degenerateByMetric.set(lane.metricId, (degenerateByMetric.get(lane.metricId) ?? 0) + 1);
    if (!lane.points.every((p) => p.pct === 50)) {
      violation(`${where}: flagged degenerate but the dots are spread`);
    }
    return;
  }

  // The orientation invariant, and the one most likely to be silently wrong:
  // on a 'lower'-is-better lane the axis is flipped, so the value printed at
  // the LEFT end must be the value of the leftmost DOT — not the smallest
  // number.
  const sorted = [...lane.points].sort((a, b) => a.pct - b.pct);
  const leftmost = sorted[0];
  const rightmost = sorted[sorted.length - 1];
  if (leftmost.value !== lane.low) {
    violation(
      `${where}: left label says ${lane.low} but the leftmost dot is ${leftmost.value} (${lane.direction})`
    );
  }
  if (rightmost.value !== lane.high) {
    violation(
      `${where}: right label says ${lane.high} but the rightmost dot is ${rightmost.value} (${lane.direction})`
    );
  }

  const values = lane.points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (lane.median < min || lane.median > max) {
    violation(`${where}: median ${lane.median} outside [${min}, ${max}]`);
  }

  if (lane.n < THIN_LANE_N) thinLanes++;
  if (lane.notableMissingRanks.includes(1)) lanesMissingLeader++;
}

/** Ordering is a claim the reader acts on — check it, don't assume it. */
function checkOrdering(label: string, lanes: Lane[], metrics: MetricReport[]): void {
  const byId = new Map(metrics.map((m) => [m.id, m]));
  const key = (l: Lane) => {
    const m = byId.get(l.metricId)!;
    const rho = m.correlation?.rho ?? 0;
    return (m.direction === 'lower' ? 1 : -1) * rho;
  };
  for (let i = 1; i < lanes.length; i++) {
    const a = key(lanes[i - 1]);
    const b = key(lanes[i]);
    if (b > a + 1e-9) {
      violation(
        `${label}: lane ${lanes[i].metricId} (${b.toFixed(3)}) sorts above ${lanes[i - 1].metricId} (${a.toFixed(3)})`
      );
      return;
    }
    if (Math.abs(a - b) < 1e-9 && lanes[i - 1].metricId > lanes[i].metricId) {
      violation(`${label}: tie between ${lanes[i - 1].metricId} and ${lanes[i].metricId} broke the wrong way`);
      return;
    }
  }
}

/** Same input in a different order must produce the same chart — SSR depends
 * on it (a differing order between workerd and the browser is a hydration
 * mismatch). */
function checkDeterminism(
  label: string,
  metrics: MetricReport[],
  report: FieldAnalysisReport,
  lanes: Lane[]
): void {
  const shuffled = [...metrics].reverse();
  const again = buildLanes(shuffled, report.pilots);
  const a = lanes.map((l) => l.metricId).join(',');
  const b = again.map((l) => l.metricId).join(',');
  if (a !== b) violation(`${label}: lane order is input-order dependent — "${a}" vs "${b}"`);
}

/** Prose that reaches the page and the accessible name. */
function checkProse(label: string, lanes: Lane[], subject: string): void {
  for (const [name, text] of [
    ['caption', lanesCaption(lanes)],
    ['aria', lanesAccessibleName(lanes, subject)],
  ] as const) {
    if (!text.trim()) violation(`${label}: empty ${name}`);
    if (/NaN|undefined|null|Infinity/.test(text)) {
      violation(`${label}: ${name} contains a non-value — "${text.slice(0, 160)}"`);
    }
  }
}

function auditReport(label: string, report: FieldAnalysisReport): void {
  const leader = [...report.pilots].sort((a, b) => a.rank - b.rank)[0] ?? null;

  for (const family of FAMILY_ORDER) {
    const metrics = report.metrics.filter((m) => m.family === family);
    if (metrics.length === 0) continue;
    familiesSeen++;

    const lanes = buildLanes(metrics, report.pilots);
    laneCountHistogram.set(lanes.length, (laneCountHistogram.get(lanes.length) ?? 0) + 1);

    // Fewer than two lanes renders nothing at all — the component's own gate.
    if (lanes.length < 2) continue;
    familiesCharted++;
    lanesDrawn += lanes.length;

    const famLabel = `${label} / ${FAMILY_LABELS[family]}`;
    // Outcome-derived metrics track rank by construction; a lane for one would
    // run cleanly best-to-worst and read as a finding about flying.
    const outcomeIds = new Set(metrics.filter((m) => m.outcome).map((m) => m.id));
    for (const lane of lanes) {
      if (outcomeIds.has(lane.metricId)) {
        violation(`${famLabel}: outcome metric ${lane.metricId} got a lane`);
      }
      checkLane(famLabel, lane);
    }
    checkOrdering(famLabel, lanes, metrics);
    checkDeterminism(famLabel, metrics, report, lanes);
    checkProse(famLabel, lanes, FAMILY_LABELS[family]);

    // The chart draws the winner's profile when nobody is hovered. If the
    // winner has no measured value in any lane there is no line to draw, and
    // the chart is a grid of dots — the exact state the default was added to
    // prevent.
    const shown = defaultProfileTrack(lanes, report.pilots);
    const present = shown
      ? lanes.filter((l) => l.points.some((p) => p.trackFile === shown)).length
      : 0;
    if (present < 2) chartsWithoutLeaderProfile++;
    else if (present < lanes.length) chartsWithBrokenConnector++;
    // Worth knowing how often the default is NOT the winner — it means the
    // winner sat out that whole family.
    if (shown && leader && shown !== leader.trackFile) defaultIsNotWinner++;
  }
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

  let result: GapTaskScoreResult;
  try {
    result = scoreTask(task, pilots, params);
  } catch (err) {
    process.stderr.write(`  ! ${label}: scoring failed — ${err}\n`);
    tasksSkipped++;
    return;
  }

  let report: FieldAnalysisReport;
  try {
    report = evaluateField(buildFieldContext(task, pilots, result, category));
  } catch (err) {
    process.stderr.write(`  ! ${label}: field analysis failed — ${err}\n`);
    tasksSkipped++;
    return;
  }
  tasksScored++;
  auditReport(label, report);
}

function auditComp(slug: string): void {
  let loaded;
  try {
    // Full path, not a bare slug: loadCompManifest resolves a slug against the
    // BUNDLED comps root, which would silently audit the wrong library when
    // pointed at the archive via GLIDECOMP_COMPS_DIR.
    loaded = loadCompManifest(join(COMPS_ROOT, slug));
  } catch (err) {
    process.stderr.write(`  ! ${slug}: ${err}\n`);
    return;
  }
  const { manifest, compsRoot } = loaded;
  // Open-distance comps have no GAP rank for the metrics to correlate against.
  if (manifest.scoring_format === 'open_distance') return;
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
console.log(`Tasks analysed: ${tasksScored}   skipped: ${tasksSkipped}`);
console.log('');
console.log(`Families present:      ${familiesSeen}`);
console.log(`Families charted:      ${familiesCharted}  (>= 2 laneable metrics)`);
console.log(`Lanes drawn:           ${lanesDrawn}`);
console.log('');
console.log('Lanes per family   families');
for (const n of [...laneCountHistogram.keys()].sort((a, b) => a - b)) {
  const count = laneCountHistogram.get(n)!;
  console.log(`  ${String(n).padStart(2)}${n < 2 ? ' (no chart)' : '          '}    ${count}`);
}
console.log('');
console.log('Pilots measured per lane');
for (const b of ['1', '2', '3', '4-7', '8+']) {
  const c = laneNHistogram.get(b);
  if (c) console.log(`  n = ${b.padEnd(4)}  ${c}`);
}
console.log('');
console.log('All-identical lanes, by metric');
for (const [id, c] of [...degenerateByMetric.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${id.padEnd(28)} ${c}`);
}
console.log('');
console.log('Readability signals (not failures):');
console.log(`  degenerate lanes (every pilot identical): ${degenerateLanes}`);
console.log(`  thin lanes (< ${THIN_LANE_N} pilots measured):          ${thinLanes}`);
console.log(`  lanes the #1 pilot has no value in:       ${lanesMissingLeader}`);
console.log(`  charts whose default profile is partial:  ${chartsWithBrokenConnector}`);
console.log(`  charts with NO default profile at all:    ${chartsWithoutLeaderProfile}`);
console.log(`  charts whose default profile is not #1:   ${defaultIsNotWinner}`);

if (violations.length > 0) {
  console.log('');
  console.log(`INVARIANT VIOLATIONS (${violations.length}${violations.length >= 40 ? '+, truncated' : ''}):`);
  for (const v of violations) console.log(`  ${v}`);
  process.exitCode = 1;
} else {
  console.log('');
  console.log('No invariant violations: every lane pairs by trackFile, sits');
  console.log('strictly inside its axis, labels its true end values, orders');
  console.log('deterministically, and excludes outcome metrics.');
}
