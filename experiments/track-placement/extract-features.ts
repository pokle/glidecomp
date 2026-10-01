#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Step 1 of the track-placement experiment (issue #692): turn every flown
 * competition track in the corpus into one feature row plus its placement
 * label, and write the result into the archive's `features/` store.
 *
 * The model this feeds sees ONE track at a time. So every feature here comes
 * from a single IGC file, the task, and the forecast `fetch-weather.ts` put
 * in the archive — never from the other pilots. The field appears in the
 * label and nowhere else, because placement is the thing being predicted.
 *
 * Two windows are extracted per track and namespaced apart:
 *   retro.*  the whole flight — the reference number.
 *   pro.*    takeoff → the start-cylinder crossing, and not one fix later —
 *            the experiment. Truncation happens BEFORE the detectors run.
 *
 * Nothing here is imported by the app, the engine's scoring closure, or CI.
 *
 * Usage:
 *   bun experiments/track-placement/extract-features.ts
 *   bun experiments/track-placement/extract-features.ts --comp bright-open-2024
 *   bun experiments/track-placement/extract-features.ts --force --out /tmp/store
 *
 * Run it AFTER fetch-weather.ts: the `wx.*` block is read from the archive's
 * weather store at extraction time, and a task with no stored answer gets a
 * block that says so rather than one full of zeroes.
 *
 * Env: GLIDECOMP_COMPS_DIR (this repo's comps), GLIDECOMP_ARCHIVE_DIR (the
 * pokle/glidecomp-archive checkout, read for comps and written for features).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assessTrackQuality,
  parseIGC,
  parseXCTask,
  rankWithTies,
  resolveCompGapParams,
  scoreTask,
  spearman,
  weatherQueryForTask,
  weatherQueryKey,
  zoneOffsetMs,
  type IGCFix,
  type IGCHeader,
  type PilotFlight,
  type PilotScore,
  type TrackQualityReport,
  type XCTask,
} from '@glidecomp/engine';
import { ARCHIVE_ROOT, COMPS_ROOT, loadCorpus, surnameFromFilename, type TaskEntry } from './lib/corpus';
import { buildTaskGeometry } from './lib/geometry';
import { taskFeatures } from './lib/task-features';
import { weatherFeatures } from './lib/weather-features';
import {
  buildWindow,
  climbFeatures,
  dayFeatures,
  glideFeatures,
  prefixed,
  qualityFeatures,
  routeFeatures,
  startFeatures,
  type FeatureBlock,
} from './lib/track-features';

/**
 * Bumped whenever a feature's definition changes. Every row carries it, so a
 * feature-set change is visible in the store rather than mixed in with the
 * rows that came before it.
 */
const EXTRACTOR_VERSION = 1;
const ROW_SCHEMA = 1;

interface Row {
  schema: number;
  extractor_version: number;
  comp: string;
  task_dir: string;
  pilot_class: string;
  task_date: string | null;
  wing: 'hg' | 'pg';
  /** The join back to the track. No name, no federation id, no ranking. */
  track_file: string;
  /** True when the pilot crossed the start, so `pro.*` is populated. */
  pro_available: boolean;
  label: Label;
  features: FeatureBlock;
}

interface Label {
  total_score: number;
  /** 1-based, ties sharing their average rank. */
  rank: number;
  /** 1 = task winner, 0 = last. The primary regression target. */
  percentile: number;
  top_decile: 0 | 1;
  top_quartile: 0 | 1;
  made_goal: 0 | 1;
  /** Field-derived, and therefore label-side only — never a feature. */
  field_size: number;
  /** Published AirScore total where the surname matches uniquely. */
  airscore_total: number | null;
}

interface TaskStats {
  dir: string;
  comp: string;
  pilot_class: string;
  date: string | null;
  wing: 'hg' | 'pg';
  rows: number;
  /** Tracks a HARD assessTrackQuality check withheld — a broken logger is
   * not a bad flight, so they are dropped rather than seated at 0. */
  dropped_hard: number;
  /** IGC files with no fixes at all — a registered pilot who never flew. */
  dropped_empty: number;
  /** Tracks the detectors found no takeoff in, so there is no flight to read. */
  dropped_no_flight: number;
  /** Rows where the pilot never crossed the start: no prospective sample. */
  no_start: number;
  airscore_matched: number;
  /** False when the task carries no date, so no weather query exists for it. */
  weather_query?: boolean;
  /**
   * How far the engine's totals sit from the published AirScore ones over the
   * uniquely-matched pilots, and — the number that actually matters for a
   * placement label — how well the two ORDER the field. A comp on an
   * unreproducible formula (GGap, Lkm departure) can be far apart in points
   * and still agree almost perfectly on who beat whom.
   */
  airscore_mean_abs_diff: number | null;
  airscore_max_abs_diff: number | null;
  airscore_rank_spearman: number | null;
  skipped_reason?: string;
}

// ---------------------------------------------------------------------------

function extractTask(entry: TaskEntry, weatherRoot: string): { rows: Row[]; stats: TaskStats } {
  const stats: TaskStats = {
    dir: entry.dir,
    comp: entry.compSlug,
    pilot_class: entry.pilotClass,
    date: entry.date ?? null,
    wing: entry.wing,
    rows: 0,
    dropped_hard: 0,
    dropped_empty: 0,
    dropped_no_flight: 0,
    no_start: 0,
    airscore_matched: 0,
    airscore_mean_abs_diff: null,
    airscore_max_abs_diff: null,
    airscore_rank_spearman: null,
  };

  // A stopped task scored WITHOUT its stop context gets the wrong totals, and
  // a wrong label trains a wrong model. verify-airscore-parity.ts declines to
  // verify these for the same reason; here they are skipped and counted.
  if (entry.airscore?.stopped) {
    stats.skipped_reason = 'stopped task — the engine stop context is not driven by this script';
    return { rows: [], stats };
  }

  const dir = join(entry.root, entry.dir);
  const task: XCTask = parseXCTask(readFileSync(join(dir, 'task.xctsk'), 'utf-8'));
  const geom = buildTaskGeometry(task);

  const qualityContext = {
    task,
    taskDate: entry.date,
    timeZone: entry.timezone,
    category: entry.category,
  };

  const parsed = new Map<
    string,
    { fixes: IGCFix[]; header: IGCHeader; quality: TrackQualityReport; dropped: number }
  >();
  const pilots: PilotFlight[] = [];
  for (const file of entry.igcFiles) {
    const igc = parseIGC(readFileSync(join(dir, file), 'utf-8'));
    if (igc.fixes.length === 0) {
      stats.dropped_empty++;
      continue;
    }
    const quality = assessTrackQuality(igc.fixes, igc.header, qualityContext);
    if (quality.hardFailed) {
      stats.dropped_hard++;
      continue;
    }
    parsed.set(file, {
      fixes: igc.fixes,
      header: igc.header,
      quality,
      dropped: igc.timeOrder.droppedFixCount,
    });
    pilots.push({ pilotName: surnameFromFilename(file), trackFile: file, fixes: igc.fixes });
  }
  if (pilots.length < 2) {
    stats.skipped_reason = stats.skipped_reason ?? `only ${pilots.length} scorable track(s)`;
    return { rows: [], stats };
  }

  // The same parameter resolution the seed → scorer path produces.
  const params = resolveCompGapParams(entry.category, entry.gapParams);
  const result = scoreTask(task, pilots, params);

  // A time inside the task day, for the clock features and the zone offset.
  const referenceMs = median(pilots.map((p) => p.fixes[0].time.getTime()));
  const offsetMs = entry.timezone ? zoneOffsetMs(referenceMs, entry.timezone) : 0;
  const taskBlock = taskFeatures({ geom, params, referenceMs, timeZoneOffsetMs: offsetMs });

  // The weather the archive stored for this task, checked against the query
  // key the engine derives for it now — a task whose route or times moved
  // asks a different question, and the stored answer is the wrong sky.
  const query = entry.date ? weatherQueryForTask(task, entry.date) : null;
  const weatherBlock = query
    ? weatherFeatures(weatherRoot, entry.dir, weatherQueryKey(query), geom)
    : weatherFeatures(weatherRoot, entry.dir, '\u0000no-query', geom);
  if (query === null) stats.weather_query = false;

  const labels = buildLabels(result.pilotScores, entry);
  applyParityStats(stats, [...labels.values()]);

  const rows: Row[] = [];
  for (const score of result.pilotScores) {
    const track = parsed.get(score.trackFile);
    const label = labels.get(score.trackFile);
    if (!track || !label) continue;

    const retro = buildWindow(track.fixes, task);
    if (!retro) {
      stats.dropped_no_flight++;
      continue;
    }

    const seq = score.turnpointResult;
    // `sssReaching` is also populated by the sequence resolver's fallbacks
    // (first turnpoint, track start) for a pilot who never crossed the start.
    // Those are not start crossings, and must not become one.
    const realStart = seq.startFallback ? null : seq.sssReaching;

    let pro: FeatureBlock = {};
    let proAvailable = false;
    if (realStart) {
      // Truncate BEFORE the detectors run, so no post-start fix can leak
      // through a detector's own window.
      const window = buildWindow(track.fixes.slice(0, realStart.fixIndex + 1), task);
      if (window) {
        proAvailable = true;
        const proFixes = track.fixes.slice(0, realStart.fixIndex + 1);
        pro = prefixed('pro.', {
          ...climbFeatures(window),
          ...glideFeatures(window),
          ...dayFeatures(window, geom),
          ...qualityFeatures(
            proFixes,
            assessTrackQuality(proFixes, track.header, qualityContext),
            track.dropped,
          ),
        });
      }
    }
    if (!proAvailable) stats.no_start++;

    rows.push({
      schema: ROW_SCHEMA,
      extractor_version: EXTRACTOR_VERSION,
      comp: entry.compSlug,
      task_dir: entry.dir,
      pilot_class: entry.pilotClass,
      task_date: entry.date ?? null,
      wing: entry.wing,
      track_file: score.trackFile,
      pro_available: proAvailable,
      label,
      features: rounded({
        ...taskBlock,
        ...weatherBlock,
        ...startFeatures(retro, { seq, geom, timeZoneOffsetMs: offsetMs }),
        ...prefixed('retro.', {
          ...climbFeatures(retro),
          ...glideFeatures(retro),
          ...dayFeatures(retro, geom),
          ...routeFeatures(retro, seq, geom),
          ...qualityFeatures(track.fixes, track.quality, track.dropped),
        }),
        ...pro,
      }),
    });
  }
  stats.rows = rows.length;
  return { rows, stats };
}

/**
 * Placement, per task-class, from the engine's own totals.
 *
 * Ties share their average rank so two pilots on identical points get
 * identical labels — a listwise loss handed a fabricated ordering would learn
 * to reproduce it.
 */
function buildLabels(scores: PilotScore[], entry: TaskEntry): Map<string, Label> {
  const n = scores.length;
  // rankWithTies is ascending; placement is descending in points.
  const ranks = rankWithTies(scores.map((s) => -s.totalScore));
  const decileCut = Math.max(1, Math.ceil(n * 0.1));
  const quartileCut = Math.max(1, Math.ceil(n * 0.25));

  // AirScore totals join by surname, and only where the surname is unique on
  // both sides — an ordering match could attribute the wrong published total
  // to a file, which is worse than no parity column at all.
  const published = entry.airscore?.totalsBySurname;
  const ourCounts = new Map<string, number>();
  for (const s of scores) ourCounts.set(s.pilotName, (ourCounts.get(s.pilotName) ?? 0) + 1);

  const labels = new Map<string, Label>();
  scores.forEach((s, i) => {
    const rank = ranks[i];
    const bucket = published?.get(s.pilotName);
    const airscore =
      bucket && bucket.length === 1 && ourCounts.get(s.pilotName) === 1 ? bucket[0] : null;
    labels.set(s.trackFile, {
      total_score: s.totalScore,
      rank,
      percentile: n > 1 ? (n - rank) / (n - 1) : 1,
      top_decile: rank <= decileCut ? 1 : 0,
      top_quartile: rank <= quartileCut ? 1 : 0,
      made_goal: s.madeGoal ? 1 : 0,
      field_size: n,
      airscore_total: airscore,
    });
  });
  return labels;
}

/**
 * Feature values to seven significant figures.
 *
 * This store is committed, and a full-precision double spends 17 characters
 * saying something no standardised model input can tell apart from the first
 * seven. Rounding here cuts the tree by about a third. Labels are NOT rounded:
 * `total_score` is the scorer's own spec-rounded value and must stay it.
 */
function rounded(features: FeatureBlock): FeatureBlock {
  const out: FeatureBlock = {};
  for (const [k, v] of Object.entries(features)) {
    out[k] = v === null || Number.isInteger(v) ? v : Number(v.toPrecision(7));
  }
  return out;
}

/** The published-totals comparison, over the pilots the surname join reached. */
function applyParityStats(stats: TaskStats, labels: Label[]) {
  const matched = labels.filter(
    (l): l is Label & { airscore_total: number } => l.airscore_total !== null,
  );
  stats.airscore_matched = matched.length;
  if (matched.length === 0) return;
  const diffs = matched.map((l) => Math.abs(l.total_score - l.airscore_total));
  stats.airscore_mean_abs_diff = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  stats.airscore_max_abs_diff = Math.max(...diffs);
  if (matched.length >= 3) {
    // NaN where one side has no spread at all (a whole task-class on zero) —
    // that is "no ordering to agree about", not an agreement of zero.
    const rho = spearman(
      matched.map((l) => l.total_score),
      matched.map((l) => l.airscore_total),
    );
    stats.airscore_rank_spearman = Number.isFinite(rho) ? rho : null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const only: string[] = [];
  let out = ARCHIVE_ROOT;
  let force = false;
  let statsOnly = false;
  let weather: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--comp') only.push(argv[++i]);
    else if (arg === '--out') out = argv[++i];
    else if (arg === '--weather') weather = argv[++i];
    else if (arg === '--force') force = true;
    else if (arg === '--stats-only') statsOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { only, out, force, statsOnly, weather };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus({ only: args.only });
  if (corpus.comps.length === 0) {
    console.error(
      `No comps found.\n  comps:   ${COMPS_ROOT}\n  archive: ${ARCHIVE_ROOT}\n` +
        'Set GLIDECOMP_ARCHIVE_DIR to a checkout of pokle/glidecomp-archive.',
    );
    process.exit(2);
  }

  const featuresDir = join(args.out, 'features');
  // The weather store sits beside the feature store under the same root, so
  // one `--out` moves the whole thing; `--weather` splits them if needed.
  const weatherRoot = args.weather ?? join(args.out, 'weather');
  if (!args.statsOnly) mkdirSync(featuresDir, { recursive: true });

  const previous = readPreviousManifest(featuresDir);
  const allStats: TaskStats[] = [];
  let featureNames: string[] = [];
  const started = Date.now();
  let taskNumber = 0;
  const taskTotal = corpus.comps.reduce((s, c) => s + c.tasks.length, 0);

  for (const comp of corpus.comps) {
    for (const entry of comp.tasks) {
      taskNumber++;
      const target = join(featuresDir, `${entry.dir}.jsonl`);
      if (!args.statsOnly && !args.force && existsSync(target)) {
        // Resumable: the extractor reads 5 000 IGC files, so a restart must
        // not redo what the store already holds. The manifest still has to
        // come out complete, so the skipped task's stats are recovered — from
        // the previous manifest where it has them, and from the stored rows
        // otherwise (which is everything except the per-file drop counts,
        // since a dropped track leaves no row behind to count).
        const rows = readRows(target);
        if (featureNames.length === 0 && rows.length > 0) {
          featureNames = Object.keys(rows[0].features).sort();
        }
        allStats.push(resumedStats(entry, rows, previous.get(entry.dir)));
        continue;
      }

      const { rows, stats } = extractTask(entry, weatherRoot);
      allStats.push(stats);
      if (rows.length > 0 && featureNames.length === 0) {
        featureNames = Object.keys(rows[0].features).sort();
      }
      if (!args.statsOnly) {
        writeFileSync(target, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      }
      const elapsed = (Date.now() - started) / 1000;
      console.log(
        `[${taskNumber}/${taskTotal}] ${entry.dir}: ${stats.rows} rows` +
          (stats.dropped_hard ? `, ${stats.dropped_hard} withheld` : '') +
          (stats.no_start ? `, ${stats.no_start} never started` : '') +
          (stats.skipped_reason ? ` — ${stats.skipped_reason}` : '') +
          `  (${elapsed.toFixed(0)}s)`,
      );
    }
  }

  if (!args.statsOnly) {
    writeManifest(featuresDir, corpus, allStats, featureNames);
    writeStoreReadme(featuresDir);
  }
  printStats(corpus, allStats, featureNames);
}

function readRows(path: string): Row[] {
  const text = readFileSync(path, 'utf-8').trimEnd();
  if (text === '') return [];
  return text.split('\n').map((line) => JSON.parse(line) as Row);
}

/** Stats for a task-class this run skipped because the store already has it. */
function resumedStats(entry: TaskEntry, rows: Row[], prior: TaskStats | undefined): TaskStats {
  if (prior && prior.rows === rows.length) {
    // A task-class that produced no rows keeps the reason it produced none —
    // "already extracted" would hide a stopped task or a one-track field.
    return rows.length === 0
      ? prior
      : { ...prior, skipped_reason: 'already extracted (use --force to redo)' };
  }
  const stats: TaskStats = {
    dir: entry.dir,
    comp: entry.compSlug,
    pilot_class: entry.pilotClass,
    date: entry.date ?? null,
    wing: entry.wing,
    rows: rows.length,
    dropped_hard: prior?.dropped_hard ?? 0,
    dropped_empty: prior?.dropped_empty ?? 0,
    dropped_no_flight: prior?.dropped_no_flight ?? 0,
    no_start: rows.filter((r) => !r.pro_available).length,
    airscore_matched: 0,
    airscore_mean_abs_diff: null,
    airscore_max_abs_diff: null,
    airscore_rank_spearman: null,
    ...(rows.length > 0
      ? { skipped_reason: 'already extracted (use --force to redo)' }
      : { skipped_reason: prior?.skipped_reason }),
  };
  applyParityStats(stats, rows.map((r) => r.label));
  return stats;
}

/** The manifest from a previous run, so a resumed run can carry its counts. */
function readPreviousManifest(featuresDir: string): Map<string, TaskStats> {
  const path = join(featuresDir, 'manifest.json');
  if (!existsSync(path)) return new Map();
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf-8'));
    if (manifest.extractor_version !== EXTRACTOR_VERSION) return new Map();
    return new Map((manifest.tasks as TaskStats[]).map((t) => [t.dir, t]));
  } catch {
    return new Map();
  }
}

function writeManifest(
  featuresDir: string,
  corpus: ReturnType<typeof loadCorpus>,
  stats: TaskStats[],
  featureNames: string[],
) {
  const manifest = {
    extractor_version: EXTRACTOR_VERSION,
    row_schema: ROW_SCHEMA,
    generated_at: new Date().toISOString(),
    engine_commit: gitHead(),
    comps_root: COMPS_ROOT,
    archive_root: ARCHIVE_ROOT,
    synthetic_skipped: corpus.syntheticSkipped,
    duplicate_task_dirs: corpus.duplicateTaskDirs,
    feature_names: featureNames,
    totals: totals(stats),
    tasks: stats,
  };
  writeFileSync(join(featuresDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function writeStoreReadme(featuresDir: string) {
  writeFileSync(
    join(featuresDir, 'README.md'),
    `# Track features and placement labels

Written by \`experiments/track-placement/extract-features.ts\` in
[pokle/glidecomp](https://github.com/pokle/glidecomp), which is also where the
design lives (\`experiments/track-placement/PLAN.md\`, issue #692).

One \`<task-dir>.jsonl\` per task folder, keyed one-to-one with \`comps/\`, plus
\`manifest.json\` — the extractor version, the engine commit, the feature list,
and per-task-class counts.

Each row is one track: its label (placement within its own task-class) and its
features. Every feature is computable from ONE IGC file, the task, and a
weather forecast, because the model these feed sees one track at a time and
never the field. Features are grouped by prefix — \`task.\`, \`quality.\`,
\`start.\`, \`retro.*\` (the whole flight), \`pro.*\` (takeoff → the start
crossing, and not one fix later).

**No pilot identity.** A row carries the IGC filename, which is what joins it
back to a track, and nothing else: no name, no federation id, no ranking, no
historical form.

Derived data, committed because it is expensive to produce — the extractor
reads about 5 000 IGC files and scores every task-class — and cheap to store.
\`extractor_version\` on every row makes a feature-set change visible rather
than mixed in with the rows that came before it; re-run with \`--force\` after
one.
`,
  );
}

function gitHead(): string | null {
  try {
    return Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

function totals(stats: TaskStats[]) {
  return {
    task_classes: stats.length,
    task_classes_with_rows: stats.filter((s) => s.rows > 0).length,
    rows: stats.reduce((s, t) => s + t.rows, 0),
    prospective_rows: stats.reduce((s, t) => s + t.rows - t.no_start, 0),
    dropped_hard: stats.reduce((s, t) => s + t.dropped_hard, 0),
    dropped_empty: stats.reduce((s, t) => s + t.dropped_empty, 0),
    dropped_no_flight: stats.reduce((s, t) => s + t.dropped_no_flight, 0),
    airscore_matched: stats.reduce((s, t) => s + t.airscore_matched, 0),
    airscore_rank_spearman_median: medianOrNull(
      stats.map((t) => t.airscore_rank_spearman).filter((v): v is number => v !== null),
    ),
    airscore_rank_spearman_min: minOrNull(
      stats.map((t) => t.airscore_rank_spearman).filter((v): v is number => v !== null),
    ),
  };
}

function medianOrNull(values: number[]): number | null {
  return values.length === 0 ? null : median(values);
}

function minOrNull(values: number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

function printStats(
  corpus: ReturnType<typeof loadCorpus>,
  stats: TaskStats[],
  featureNames: string[],
) {
  const t = totals(stats);
  console.log('\n=== Dataset ===');
  for (const comp of corpus.comps) {
    const mine = stats.filter((s) => s.comp === comp.slug);
    const rows = mine.reduce((s, x) => s + x.rows, 0);
    const pro = mine.reduce((s, x) => s + x.rows - x.no_start, 0);
    const dropped = mine.reduce((s, x) => s + x.dropped_hard, 0);
    console.log(
      `  ${comp.slug.padEnd(24)} ${comp.source.padEnd(8)} ${comp.category}  ` +
        `${String(mine.length).padStart(3)} task-classes  ${String(rows).padStart(5)} rows  ` +
        `${String(pro).padStart(5)} with a start` +
        (dropped ? `  (${dropped} withheld)` : ''),
    );
  }
  const skipped = stats.filter((s) => s.rows === 0 && s.skipped_reason);
  if (skipped.length > 0) {
    console.log('\n  Task-classes with no rows:');
    for (const s of skipped) console.log(`    ${s.dir}: ${s.skipped_reason}`);
  }
  console.log(
    `\n  comps ${corpus.comps.length}, task-classes ${t.task_classes} ` +
      `(${t.task_classes_with_rows} with rows), rows ${t.rows}, ` +
      `prospective rows ${t.prospective_rows}`,
  );
  console.log(
    `  withheld by a HARD track-quality check: ${t.dropped_hard}; ` +
      `empty IGC files: ${t.dropped_empty}; no takeoff detected: ${t.dropped_no_flight}; ` +
      `AirScore parity column on ${t.airscore_matched} rows`,
  );
  if (t.airscore_rank_spearman_median !== null) {
    // Points can sit far apart on a formula the engine can't reproduce and the
    // ORDER still be identical — and the order is what the label is.
    console.log(
      `  engine-vs-AirScore rank agreement: median rho ` +
        `${t.airscore_rank_spearman_median.toFixed(3)}, ` +
        `worst task-class ${t.airscore_rank_spearman_min?.toFixed(3)}`,
    );
    const ragged = stats
      .filter((s) => s.airscore_rank_spearman !== null && s.airscore_rank_spearman < 0.95)
      .sort((a, b) => (a.airscore_rank_spearman ?? 0) - (b.airscore_rank_spearman ?? 0));
    for (const s of ragged.slice(0, 15)) {
      console.log(
        `    ${s.dir}: rho ${s.airscore_rank_spearman?.toFixed(3)} over ` +
          `${s.airscore_matched} pilots (mean |dpts| ${s.airscore_mean_abs_diff?.toFixed(1)})`,
      );
    }
    if (ragged.length > 15) console.log(`    … and ${ragged.length - 15} more below rho 0.95`);
  }
  console.log(`  features per row: ${featureNames.length}`);
  const groups = new Map<string, number>();
  for (const name of featureNames) {
    const group = name.split('.').slice(0, name.startsWith('retro.') || name.startsWith('pro.') ? 2 : 1).join('.');
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  console.log(`  by block: ${[...groups].map(([g, n]) => `${g} ${n}`).join(', ')}`);
}

main();
