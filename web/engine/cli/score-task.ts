#!/usr/bin/env bun
/**
 * score-task CLI — Score multiple tracks against a single task using CIVL GAP.
 *
 * Usage:
 *   bun run score-task -- <task.xctsk> <igc-file-or-folder>...
 *
 * Examples:
 *   bun run score-task -- task.xctsk pilot1.igc pilot2.igc pilot3.igc
 *   bun run score-task -- task.xctsk ./tracks/
 *   bun run score-task -- task.xctsk ./tracks/ extra-pilot.igc
 *   bun run score-task -- task.xctsk ./tracks/ --wing HG --field-analysis
 *   bun run score-task -- --comp corryong-cup-2026
 *
 * Field analysis (--field-analysis, implied by --comp): after the scores, a
 * behavioural report over the whole field — per-pilot metrics (climbing,
 * gliding, decision-making, gaggle, race craft, day profile/wind) led by the
 * metric-separation ranking (Spearman ρ vs GAP rank), which tells the reader
 * which strategies mattered on that task. --comp scores every task of a
 * bundled comp per class and adds a per-class cross-task aggregate. See
 * docs/2026-07-18-field-analysis-plan.md.
 *
 * Behaves identically to the web app. --wing (HG or PG) is REQUIRED for GAP
 * scoring — the CLI has no comp record to read the wing from, and won't guess.
 * Given it, the run starts from the official per-category FAI/S7F GAP settings
 * (engine `defaultsFor`) and every flag below overrides one parameter, exactly as
 * the settings dialog does. Flag names are the kebab-case of the `gap_params`
 * keys the UI saves, so a comp's stored settings map 1:1. Units are the engine's
 * (metres / seconds / 0-1 ratios), not the form's (km / min / %).
 *
 * Options (grouped by function; see --help for the full text):
 *   Wing (required for GAP):
 *     --wing <HG|PG>                         `scoring`
 *   Task mode:
 *     --open-distance                        Score as open distance (GAP options ignored)
 *     --comp <slug-or-dir>                   Score a whole bundled comp (comp.json manifest):
 *                                            every task per class, plus a per-class comp
 *                                            aggregate. Implies --field-analysis; wing comes
 *                                            from the manifest category (--wing overrides).
 *   Field analysis:
 *     --field-analysis                       After the scores, print the behavioural field
 *                                            analysis (see docs/2026-07-18-field-analysis-plan.md)
 *   Nominal parameters:
 *     --nominal-distance <m>                 `nominalDistance` (default: 70% of task)
 *     --nominal-distance-pct <%>             …as % of task distance (default: 70)
 *     --nominal-time <s>                     `nominalTime` (default: 5400)
 *     --nominal-goal <ratio>                 `nominalGoal` 0-1 (default: 0.3)
 *     --nominal-launch <ratio>               `nominalLaunch` 0-1 (default: 0.96)
 *     --minimum-distance <m>                 `minimumDistance` (default: 5000)
 *   Scoring terms (per-wing defaults; pass to override):
 *     --use-leading / --no-use-leading                       `useLeading`
 *     --use-arrival / --no-use-arrival                       `useArrival`
 *     --use-distance-difficulty / --no-use-distance-difficulty  `useDistanceDifficulty`
 *   Formula & advanced:
 *     --leading-formula <weighted|classic>   `leadingFormula` (default: classic HG / weighted PG)
 *     --leading-weight-formula <gap2020|s7f2024>  `leadingWeightFormula`, PG (default: gap2020)
 *     --leading-time-ratio <ratio>           `leadingTimeRatio` 0-0.5, PG S7F-2024 (default: 0.26)
 *     --time-points-exponent <5/6|2/3>       `timePointsExponent` (default: 5/6)
 *     --distance-origin <takeoff|start>      `distanceOrigin` (default: takeoff)
 *     --jump-the-gun-factor <n>              `jumpTheGunFactor`, HG (default: 2)
 *     --jump-the-gun-max-seconds <s>         `jumpTheGunMaxSeconds`, HG (default: 300)
 *     --ess-not-goal-factor <ratio>          `essNotGoalFactor` 0-1, HG (default: 0.8)
 *     --score-back-time <s>                  `scoreBackTime`, PG stopped tasks (default: 300)
 *   Stopped task (S7F §12.3):
 *     --stop-time <iso-datetime>             Task stop announcement time; scores the
 *                                            task as stopped
 *   Output:
 *     --json                                 Output results as JSON
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, resolveCompGapParams, resolveTimePointsExponent, type GAPParameters, type PilotFlight, type TaskScoreResult } from '../src/gap-scoring';
import { scoreOpenDistance } from '../src/open-distance-scoring';
import type { XCTask } from '../src/xctsk-parser';
import {
  buildFieldContext,
  evaluateField,
  renderFieldReport,
  aggregateComp,
  renderCompReport,
  type CompTaskResult,
  type FieldAnalysisReport,
} from '../src/field-analysis';
import { timezoneForXctsk } from '../src/timezone';
import { loadCompManifest, readTaskDir, pilotKeyFor } from './comp-manifest';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function usage(): never {
  process.stderr.write(
    'Usage: score-task --wing <HG|PG> <task.xctsk> <igc-file-or-folder>...\n\n' +
    'Scores identically to the web app. --wing (the competition wing) is REQUIRED\n' +
    'for GAP scoring — the CLI has no comp record and will not guess. Given it, the\n' +
    'run starts from the official per-category FAI/S7F GAP defaults and each flag\n' +
    'below overrides one parameter, exactly as the settings dialog does. Flag names\n' +
    'are the kebab-case of the gap_params keys the UI saves; units are the engine\'s\n' +
    '(metres / seconds / 0-1 ratios), not the form\'s (km / min / %).\n\n' +
    'Wing (required for GAP):\n' +
    '  --wing <HG|PG>             Competition wing (gap_params `scoring`)\n\n' +
    'Task mode:\n' +
    '  --open-distance            Score as open distance: a single TAKEOFF turnpoint,\n' +
    '                             no goal; each pilot scores metres from the take-off\n' +
    '                             exit to their furthest fix. All GAP options below are\n' +
    '                             ignored, and --wing is not required.\n\n' +
    'Nominal parameters:\n' +
    '  --nominal-distance <m>     `nominalDistance` in metres (default: 70% of task)\n' +
    '  --nominal-distance-pct <%> Nominal distance as % of task distance (default: 70)\n' +
    '  --nominal-time <s>         `nominalTime` in seconds (default: 5400)\n' +
    '  --nominal-goal <ratio>     `nominalGoal` 0-1 (default: 0.3)\n' +
    '  --nominal-launch <ratio>   `nominalLaunch` 0-1 (default: 0.96)\n' +
    '  --minimum-distance <m>     `minimumDistance` in metres (default: 5000)\n\n' +
    'Scoring terms (per-wing defaults; pass to override):\n' +
    '  --use-leading / --no-use-leading\n' +
    '                             `useLeading` (default: on)\n' +
    '  --use-arrival / --no-use-arrival\n' +
    '                             `useArrival` (default: on for HG, off for PG)\n' +
    '  --use-distance-difficulty / --no-use-distance-difficulty\n' +
    '                             `useDistanceDifficulty`, HG (default: on)\n\n' +
    'Formula & advanced:\n' +
    '  --leading-formula <weighted|classic>\n' +
    '                             `leadingFormula` leading-coefficient variant\n' +
    '                             (default: classic for HG, weighted for PG — 2024 spec)\n' +
    '  --leading-weight-formula <gap2020|s7f2024>\n' +
    '                             `leadingWeightFormula`, PG only (default: gap2020;\n' +
    '                             "s7f2024" uses the FAI S7F §10 LeadingTimeRatio split)\n' +
    '  --leading-time-ratio <ratio>\n' +
    '                             `leadingTimeRatio` 0-0.5, PG S7F-2024 only (default: 0.26)\n' +
    '  --time-points-exponent <5/6|2/3>\n' +
    '                             `timePointsExponent` speed-fraction exponent (default: 5/6;\n' +
    '                             set independently of --leading-formula)\n' +
    '  --distance-origin <takeoff|start>\n' +
    '                             `distanceOrigin` (default: takeoff; "start" excludes\n' +
    '                             the take-off→SSS leg)\n' +
    '  --jump-the-gun-factor <n>  `jumpTheGunFactor`, HG early-start (default: 2)\n' +
    '  --jump-the-gun-max-seconds <s>\n' +
    '                             `jumpTheGunMaxSeconds`, HG (default: 300)\n' +
    '  --ess-not-goal-factor <ratio>\n' +
    '                             `essNotGoalFactor` 0-1: share of time+arrival points\n' +
    '                             kept on ESS without goal (S7F §12.1). HG default 0.8;\n' +
    '                             PG is fixed at 0 by the spec and ignores it.\n' +
    '  --score-back-time <s>      `scoreBackTime`, PG stopped tasks (default: 300)\n' +
    '  --stop-time <iso-datetime> Task stop announcement time (S7F §12.3) — scores\n' +
    '                             the task as stopped (e.g. 2026-01-15T03:45:00Z)\n\n' +
    'Whole comp:\n' +
    '  --comp <slug-or-dir>       Score a bundled comp (web/samples/comps/<slug>/comp.json,\n' +
    '                             or a directory/path holding comp.json): every task per\n' +
    '                             class plus a per-class comp aggregate. Implies\n' +
    '                             --field-analysis; wing comes from the manifest category\n' +
    '                             (--wing overrides).\n\n' +
    'Field analysis:\n' +
    '  --field-analysis           After the scores, print the behavioural field analysis\n' +
    '                             (per-pilot metrics vs the field, ranked by Spearman\n' +
    '                             correlation against GAP rank)\n\n' +
    'Output:\n' +
    '  --json                     Output results as JSON\n'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

// Parse options
const params: Partial<GAPParameters> = {};
let jsonOutput = false;
let openDistance = false;
let fieldAnalysis = false;
// Whole-comp mode: the --comp slug or directory (implies --field-analysis).
let compArg: string | null = null;
// Stopped task (S7F §12.3): the stop announcement time, when given.
let stopAnnouncementMs: number | null = null;
let nominalDistancePct: number | undefined;
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  switch (arg) {
    case '--nominal-distance-pct':
      nominalDistancePct = Number(args[++i]);
      break;
    case '--nominal-distance':
      params.nominalDistance = Number(args[++i]);
      break;
    case '--nominal-time':
      params.nominalTime = Number(args[++i]);
      break;
    case '--nominal-goal':
      params.nominalGoal = Number(args[++i]);
      break;
    case '--nominal-launch':
      params.nominalLaunch = Number(args[++i]);
      break;
    case '--minimum-distance':
      params.minimumDistance = Number(args[++i]);
      break;
    case '--wing': {
      const v = args[++i];
      if (v !== 'HG' && v !== 'PG') {
        process.stderr.write(`Error: --wing must be HG or PG (got "${v ?? ''}")\n`);
        process.exit(1);
      }
      params.scoring = v;
      break;
    }
    case '--distance-origin':
      params.distanceOrigin = args[++i] as 'takeoff' | 'start';
      break;
    case '--leading-formula':
      params.leadingFormula = args[++i] as 'weighted' | 'classic';
      break;
    case '--leading-weight-formula':
      params.leadingWeightFormula = args[++i] as 'gap2020' | 's7f2024';
      break;
    case '--leading-time-ratio':
      params.leadingTimeRatio = Number(args[++i]);
      break;
    case '--time-points-exponent':
      params.timePointsExponent = args[++i] as '5/6' | '2/3';
      break;
    case '--jump-the-gun-factor':
      params.jumpTheGunFactor = Number(args[++i]);
      break;
    case '--jump-the-gun-max-seconds':
      params.jumpTheGunMaxSeconds = Number(args[++i]);
      break;
    case '--ess-not-goal-factor':
      params.essNotGoalFactor = Number(args[++i]);
      break;
    case '--score-back-time':
      params.scoreBackTime = Number(args[++i]);
      break;
    case '--stop-time': {
      // Stopped task (S7F §12.3): the stop announcement as an ISO datetime.
      const parsed = Date.parse(args[++i]);
      if (Number.isNaN(parsed)) {
        process.stderr.write('Error: --stop-time must be an ISO 8601 datetime (e.g. 2026-01-15T03:45:00Z)\n');
        process.exit(1);
      }
      stopAnnouncementMs = parsed;
      break;
    }
    case '--use-distance-difficulty':
      params.useDistanceDifficulty = true;
      break;
    case '--no-use-distance-difficulty':
      params.useDistanceDifficulty = false;
      break;
    case '--use-leading':
      params.useLeading = true;
      break;
    case '--no-use-leading':
      params.useLeading = false;
      break;
    case '--use-arrival':
      params.useArrival = true;
      break;
    case '--no-use-arrival':
      params.useArrival = false;
      break;
    case '--open-distance':
      openDistance = true;
      break;
    case '--field-analysis':
      fieldAnalysis = true;
      break;
    case '--comp': {
      const v = args[++i];
      if (!v || v.startsWith('--')) {
        process.stderr.write('Error: --comp needs a bundled comp slug or a directory holding comp.json\n');
        process.exit(1);
      }
      compArg = v;
      fieldAnalysis = true;
      break;
    }
    case '--json':
      jsonOutput = true;
      break;
    case '--help':
    case '-h':
      usage();
      break;
    default:
      // Unknown --flags are an error, not a stray positional path (which would
      // fail later with a confusing statSync ENOENT). Point renamed flags at
      // their new gap_params-key names.
      if (arg.startsWith('--')) {
        const renamed: Record<string, string> = {
          '--scoring': '--wing',
          '--min-distance': '--minimum-distance',
          '--leading': '--use-leading',
          '--no-leading': '--no-use-leading',
          '--arrival': '--use-arrival',
          '--no-arrival': '--no-use-arrival',
          '--difficulty': '--use-distance-difficulty',
          '--no-difficulty': '--no-use-distance-difficulty',
        };
        const hint = renamed[arg] ? ` (renamed to ${renamed[arg]})` : '';
        process.stderr.write(`Error: unknown option ${arg}${hint}\n\n`);
        usage();
      }
      positional.push(arg);
  }
}

if (compArg === null && positional.length < 2) usage();

// Refuse to guess the wing: GAP scoring needs a category to pick the official
// per-category defaults (arrival/difficulty/leading-weight differ HG vs PG), and
// the CLI has no comp record to read it from. Open distance ignores GAP params.
// In --comp mode the manifest's `category` IS the comp record, so no flag needed.
if (compArg === null && !openDistance && params.scoring === undefined) {
  process.stderr.write(
    'Error: --wing <HG|PG> is required for GAP scoring.\n' +
    'The CLI has no competition record to read the wing from and will not guess.\n' +
    '(Use --open-distance for open-distance tasks, where GAP parameters are ignored.)\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Find IGC files
// ---------------------------------------------------------------------------

function findIGCFiles(paths: string[]): string[] {
  const files: string[] = [];

  for (const p of paths) {
    const resolved = resolve(p);
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      walkDir(resolved, files);
    } else if (stat.isFile() && extname(resolved).toLowerCase() === '.igc') {
      files.push(resolved);
    }
  }

  return files.sort();
}

function walkDir(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, files);
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.igc') {
      files.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number | null): string {
  if (seconds === null) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDist(meters: number): string {
  if (meters >= 1000) return (meters / 1000).toFixed(1) + ' km';
  return meters.toFixed(0) + ' m';
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

// ---------------------------------------------------------------------------
// Scoring + output building blocks (shared by single-task and --comp modes)
// ---------------------------------------------------------------------------

/**
 * Score one task exactly like the web app. Mirrors computeTaskScore in
 * web/workers/competition-api/src/scoring.ts: start from the official
 * per-category FAI defaults (defaultsFor — leading/arrival/difficulty/nominal
 * goal as the S7F formula actually uses them), then overlay only the flags the
 * user explicitly passed. resolveCompGapParams also keeps the pre-#258
 * exponent when only a leading formula is given (classic → 2/3, weighted →
 * 5/6), so passing a stored comp's gap_params reproduces its exact scores.
 */
function runScoring(
  task: XCTask,
  pilots: PilotFlight[],
  openDist: boolean,
  category: 'hg' | 'pg',
): { result: TaskScoreResult; taskDistance: number } {
  // Open distance has no goal/route, so there is no optimized task distance and
  // no nominal-distance resolution — the take-off is the only turnpoint.
  const taskDistance = openDist ? 0 : calculateOptimizedTaskDistance(task);
  const gapParams: Partial<GAPParameters> = resolveCompGapParams(category, params);

  // Auto-fill nominalDistance from a percentage of the optimized task distance
  // (UI uses 70%) unless the user pinned an explicit --nominal-distance. Key off
  // the *explicit* flag, exactly as the UI keys off the comp's stored value.
  if (!openDist && params.nominalDistance === undefined) {
    const pct = nominalDistancePct ?? 70;
    gapParams.nominalDistance = taskDistance * (pct / 100);
  }

  const result = openDist
    ? scoreOpenDistance(task, pilots)
    : scoreTask(
        task, pilots, gapParams, undefined,
        stopAnnouncementMs !== null ? { stopAnnouncementMs } : {},
      );
  return { result, taskDistance };
}

/** Build the field-analysis report; a failure warns rather than killing the scores. */
function tryFieldAnalysis(
  task: XCTask,
  pilots: PilotFlight[],
  result: TaskScoreResult,
  category: 'hg' | 'pg',
): FieldAnalysisReport | null {
  try {
    return evaluateField(buildFieldContext(task, pilots, result, category));
  } catch (err) {
    process.stderr.write(`Warning: field analysis failed: ${err}\n`);
    return null;
  }
}

/**
 * JSON shape — keep the turnpoint sequence/leg breakdown for transparency,
 * but drop the bulky raw cylinder-crossing array.
 */
function stripCrossings(result: TaskScoreResult): unknown {
  return {
    ...result,
    pilotScores: result.pilotScores.map(ps => {
      const { turnpointResult, ...rest } = ps;
      const { crossings: _crossings, ...sequenceResult } = turnpointResult;
      return { ...rest, turnpointResult: sequenceResult };
    }),
  };
}

if (compArg !== null) {
  runComp(compArg);
} else {
  runSingleTask();
}

// ---------------------------------------------------------------------------
// Single-task mode (the original CLI behaviour)
// ---------------------------------------------------------------------------

function runSingleTask(): void {
  const taskPath = resolve(positional[0]);
  const igcPaths = findIGCFiles(positional.slice(1));

  if (igcPaths.length === 0) {
    process.stderr.write('Error: No IGC files found\n');
    process.exit(1);
  }

  const task = parseXCTask(readFileSync(taskPath, 'utf-8'));
  // The category comes from the required --wing flag (open distance ignores
  // GAP params, so it falls back to 'hg' harmlessly).
  const category = params.scoring === 'PG' ? 'pg' : 'hg';

  // Parse all IGC files
  const pilots: PilotFlight[] = [];
  for (const igcPath of igcPaths) {
    try {
      const igcContent = readFileSync(igcPath, 'utf-8');
      const igc = parseIGC(igcContent);
      if (igc.fixes.length === 0) {
        process.stderr.write(`Warning: No fixes in ${basename(igcPath)}, skipping\n`);
        continue;
      }
      const pilotName = igc.header.pilot || igc.header.competitionId || basename(igcPath, '.igc');
      pilots.push({ pilotName, trackFile: igcPath, fixes: igc.fixes });
    } catch (err) {
      process.stderr.write(`Warning: Failed to parse ${basename(igcPath)}: ${err}\n`);
    }
  }

  if (pilots.length === 0) {
    process.stderr.write('Error: No valid IGC files could be parsed\n');
    process.exit(1);
  }

  const { result, taskDistance } = runScoring(task, pilots, openDistance, category);
  if (openDistance) {
    process.stderr.write(`Scoring ${pilots.length} pilots as open distance\n`);
  } else {
    process.stderr.write(`Scoring ${pilots.length} pilots against task (${formatDist(taskDistance)})\n`);
  }

  const report = fieldAnalysis ? tryFieldAnalysis(task, pilots, result, category) : null;

  if (jsonOutput) {
    const output = stripCrossings(result) as Record<string, unknown>;
    if (report) output.fieldAnalysis = report;
    console.log(JSON.stringify(output, null, 2));
  } else {
    printResultTables(task, result, openDistance);
    // Render report times in the task's local zone (derived from its first
    // turnpoint); the engine emitted them as UTC instants.
    if (report) console.log(renderFieldReport(report, { timeZone: timezoneForXctsk(task) }));
  }
}

// ---------------------------------------------------------------------------
// Whole-comp mode (--comp)
// ---------------------------------------------------------------------------

function runComp(arg: string): void {
  const { manifest, compsRoot } = loadCompManifest(arg);
  const openDist = openDistance || manifest.scoring_format === 'open_distance';
  // The manifest's category is the comp record the single-task mode lacks;
  // an explicit --wing still wins.
  const category: 'hg' | 'pg' =
    params.scoring !== undefined
      ? (params.scoring === 'PG' ? 'pg' : 'hg')
      : (manifest.category === 'pg' ? 'pg' : 'hg');

  const jsonTasks: unknown[] = [];
  const jsonComps: unknown[] = [];

  for (const pilotClass of manifest.classes) {
    const specs = manifest.tasks
      .filter((t) => t.pilot_class === pilotClass)
      .sort((a, b) => a.date.localeCompare(b.date));
    const compTasks: CompTaskResult[] = [];

    for (const spec of specs) {
      const fullLabel = `${spec.name} (${spec.date})`;
      let taskDir;
      try {
        taskDir = readTaskDir(join(compsRoot, spec.dir));
      } catch (err) {
        process.stderr.write(`Warning: skipping ${spec.dir}: ${err}\n`);
        continue;
      }
      const { task, pilots } = taskDir;
      if (pilots.length === 0) {
        process.stderr.write(`Warning: no parseable tracks in ${spec.dir}, skipping\n`);
        continue;
      }
      process.stderr.write(
        `Scoring ${manifest.name} [${pilotClass}] ${fullLabel}: ${pilots.length} pilots\n`,
      );

      const { result } = runScoring(task, pilots, openDist, category);
      const report = tryFieldAnalysis(task, pilots, result, category);

      if (jsonOutput) {
        jsonTasks.push({
          pilotClass,
          label: fullLabel,
          result: stripCrossings(result),
          fieldAnalysis: report,
        });
      } else {
        console.log('');
        console.log(`${'='.repeat(20)} ${manifest.name} — ${pilotClass} — ${fullLabel} ${'='.repeat(20)}`);
        printResultTables(task, result, openDist);
        if (report) console.log(renderFieldReport(report, { timeZone: timezoneForXctsk(task) }));
      }

      if (report) {
        compTasks.push({
          // Short label ("T1") — it becomes a column header in the comp table.
          label: spec.name.replace(/^Task\s*/i, 'T'),
          report,
          pilotKeyByTrackFile: Object.fromEntries(
            pilots.map((p) => [p.trackFile, pilotKeyFor(p.trackFile, p.pilotName)]),
          ),
          totals: result.pilotScores.map((ps) => ({
            trackFile: ps.trackFile,
            pilotName: ps.pilotName,
            totalScore: ps.totalScore,
          })),
        });
      }
    }

    if (compTasks.length > 0) {
      const aggregate = aggregateComp(compTasks);
      if (jsonOutput) {
        jsonComps.push({ pilotClass, aggregate });
      } else {
        console.log('');
        console.log(`${'='.repeat(20)} ${manifest.name} — ${pilotClass} — whole comp ${'='.repeat(20)}`);
        console.log(renderCompReport(aggregate));
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ tasks: jsonTasks, comp: jsonComps }, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Score-table printing
// ---------------------------------------------------------------------------

function printResultTables(task: XCTask, result: TaskScoreResult, openDist: boolean): void {
if (openDist) {
  // Open-distance table — the score IS the metres flown from the take-off exit,
  // so the GAP validity/weight/points columns don't apply.
  const s = result.stats;
  console.log('');
  console.log('=== Open Distance Results ===');
  console.log('');
  console.log(`Take-off:         ${task.turnpoints[0]?.waypoint.name ?? '(unnamed)'}`);
  console.log(`Pilots:           ${s.numFlying} flying / ${s.numPresent} present`);
  console.log(`Best distance:    ${formatDist(s.bestDistance)}`);
  console.log('');
  const header = [padLeft('#', 4), padRight('Pilot', 25), padLeft('Distance', 12), padLeft('Score', 8)];
  console.log(header.join('  '));
  console.log('-'.repeat(header.join('  ').length));
  for (const ps of result.pilotScores) {
    console.log(
      [
        padLeft(String(ps.rank), 4),
        padRight(ps.pilotName.slice(0, 25), 25),
        padLeft(formatDist(ps.flownDistance), 12),
        padLeft(String(ps.totalScore), 8),
      ].join('  '),
    );
  }
  console.log('');
  console.log('Score = open distance in metres (take-off exit → furthest fix).');
  console.log('');
} else {
  // Table output
  const tv = result.taskValidity;
  const ap = result.availablePoints;
  const w = result.weights;
  const s = result.stats;

  const p = result.parameters;

  console.log('');
  console.log('=== Task Scoring Results (CIVL GAP) ===');
  console.log('');
  console.log('Scoring config:');
  console.log(`  Sport:          ${p.scoring}`);
  console.log(`  Distance origin:${p.distanceOrigin === 'takeoff' ? ' take-off' : ' start cylinder'}`);
  console.log(`  Leading:        ${p.useLeading ? `on (${p.leadingFormula})` : 'off'}`);
  if (p.useLeading && p.scoring === 'PG') {
    console.log(
      `  Leading weight: ${p.leadingWeightFormula === 's7f2024'
        ? `S7F 2024 (ratio ${(p.leadingTimeRatio * 100).toFixed(0)}%)`
        : 'GAP2020 (AirScore parity)'}`
    );
  }
  console.log(`  Time exponent:  ${resolveTimePointsExponent(p)}`);
  if (p.scoring === 'HG') {
    console.log(`  Arrival:        ${p.useArrival ? 'on' : 'off'}`);
    console.log(`  Difficulty:     ${p.useDistanceDifficulty ? 'on' : 'off'}`);
    console.log(`  ESS w/o goal:   keeps ${(p.essNotGoalFactor * 100).toFixed(0)}% of time+arrival (§12.1)`);
  }
  console.log(`  Nominal:        dist ${formatDist(p.nominalDistance)} / time ${Math.round(p.nominalTime / 60)} min / goal ${(p.nominalGoal * 100).toFixed(0)}% / launch ${(p.nominalLaunch * 100).toFixed(0)}%`);
  console.log(`  Min distance:   ${formatDist(p.minimumDistance)}`);
  console.log('');
  console.log(`Task distance:    ${formatDist(s.taskDistance)}`);
  console.log(`Pilots:           ${s.numFlying} flying / ${s.numPresent} present`);
  console.log(`In goal:          ${s.numInGoal} (${(s.goalRatio * 100).toFixed(1)}%)`);
  console.log(`Reached ESS:      ${s.numReachedESS}`);
  console.log(`Best distance:    ${formatDist(s.bestDistance)}`);
  console.log(`Best time:        ${s.bestTime !== null ? formatTime(s.bestTime) : 'none'}`);
  console.log('');
  // Stopped task (S7F §12.3): the transparency block the UI also shows.
  if (result.stopped) {
    const st = result.stopped;
    console.log(`STOPPED TASK (S7F §12.3):`);
    console.log(`  Stop time:      ${new Date(st.stopTimeMs).toISOString()} (announcement scored back per §12.3.1)`);
    console.log(
      `  Scored window:  ${st.scoredWindowSeconds !== null ? formatTime(st.scoredWindowSeconds) : 'none (nobody started)'} (minimum to score: ${formatTime(st.minimumRunSeconds)})`
    );
    if (!st.requirementMet) {
      console.log('  NOT SCORED — the task was stopped before the §12.3.2 minimum run; every pilot scores 0.');
    } else {
      console.log(`  Stopped validity: ${(st.stoppedValidity * 100).toFixed(1)}% (§12.3.3)`);
      if (st.timePointsReduction > 0) {
        console.log(`  Goal pilots' time points reduced by ${st.timePointsReduction.toFixed(1)} (§12.3.5)`);
      }
      console.log(`  Landed before the stop: ${st.numLandedBeforeStop} of ${s.numFlying}`);
    }
    console.log('');
  }

  console.log(`Task Validity:    ${(tv.task * 100).toFixed(1)}%`);
  console.log(`  Launch:         ${(tv.launch * 100).toFixed(1)}%`);
  console.log(`  Distance:       ${(tv.distance * 100).toFixed(1)}%`);
  console.log(`  Time:           ${(tv.time * 100).toFixed(1)}%`);
  if (tv.stopped !== undefined) {
    console.log(`  Stopped:        ${(tv.stopped * 100).toFixed(1)}%`);
  }
  console.log('');
  console.log(`Available Points: ${ap.total.toFixed(0)} (dist: ${ap.distance.toFixed(0)}, time: ${ap.time.toFixed(0)}, lead: ${ap.leading.toFixed(0)}, arr: ${ap.arrival.toFixed(0)})`);
  console.log(`Weights:          dist: ${(w.distance * 100).toFixed(1)}%, time: ${(w.time * 100).toFixed(1)}%, lead: ${(w.leading * 100).toFixed(1)}%, arr: ${(w.arrival * 100).toFixed(1)}%`);
  console.log('');

  // Header. "Diff Pts" is the difficulty half of distance points (HG only,
  // when enabled); "LC" is the leading coefficient (shown when leading is on).
  const showDiff = p.scoring === 'HG' && p.useDistanceDifficulty;
  const showLC = p.useLeading;

  const header = [
    padLeft('#', 4),
    padRight('Pilot', 25),
    padLeft('Dist', 10),
    padLeft('SS Time', 10),
    padLeft('Dist Pts', 9),
  ];
  if (showDiff) header.push(padLeft('Diff Pts', 9));
  header.push(padLeft('Time Pts', 9), padLeft('Lead Pts', 9));
  if (showLC) header.push(padLeft('LC', 9));
  if (p.scoring === 'HG') header.push(padLeft('Arr Pts', 9));
  header.push(padLeft('Total', 7));
  console.log(header.join('  '));
  console.log('-'.repeat(header.join('  ').length));

  for (const ps of result.pilotScores) {
    const row = [
      padLeft(String(ps.rank), 4),
      padRight(ps.pilotName.slice(0, 25), 25),
      padLeft(formatDist(ps.flownDistance), 10),
      padLeft(ps.madeGoal ? formatTime(ps.speedSectionTime) : (ps.reachedESS ? 'ESS' : 'LO'), 10),
      padLeft(ps.distancePoints.toFixed(1), 9),
    ];
    if (showDiff) row.push(padLeft(ps.distanceDifficultyPoints.toFixed(1), 9));
    row.push(padLeft(ps.timePoints.toFixed(1), 9), padLeft(ps.leadingPoints.toFixed(1), 9));
    if (showLC) row.push(padLeft(isFinite(ps.leadingCoefficient) ? ps.leadingCoefficient.toFixed(3) : '—', 9));
    if (p.scoring === 'HG') row.push(padLeft(ps.arrivalPoints.toFixed(1), 9));
    row.push(padLeft(String(ps.totalScore), 7));
    console.log(row.join('  '));
  }
  console.log('');
  if (showDiff) console.log('Diff Pts = difficulty half of distance points (linear half = Dist Pts − Diff Pts).');
  if (showLC) console.log('LC = leading coefficient (lower means more time spent out front).');
  console.log('');
}
}
