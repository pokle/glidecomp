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
 *     --leading-formula <weighted|classic>   `leadingFormula` (default: weighted)
 *     --leading-weight-formula <gap2020|s7f2024>  `leadingWeightFormula`, PG (default: gap2020)
 *     --leading-time-ratio <ratio>           `leadingTimeRatio` 0-0.5, PG S7F-2024 (default: 0.26)
 *     --distance-origin <takeoff|start>      `distanceOrigin` (default: takeoff)
 *     --jump-the-gun-factor <n>              `jumpTheGunFactor`, HG (default: 2)
 *     --jump-the-gun-max-seconds <s>         `jumpTheGunMaxSeconds`, HG (default: 300)
 *   Output:
 *     --json                                 Output results as JSON
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, defaultsFor, type GAPParameters, type PilotFlight } from '../src/gap-scoring';
import { scoreOpenDistance } from '../src/open-distance-scoring';

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
    '                             `leadingFormula` (default: weighted)\n' +
    '  --leading-weight-formula <gap2020|s7f2024>\n' +
    '                             `leadingWeightFormula`, PG only (default: gap2020;\n' +
    '                             "s7f2024" uses the FAI S7F §10 LeadingTimeRatio split)\n' +
    '  --leading-time-ratio <ratio>\n' +
    '                             `leadingTimeRatio` 0-0.5, PG S7F-2024 only (default: 0.26)\n' +
    '  --distance-origin <takeoff|start>\n' +
    '                             `distanceOrigin` (default: takeoff; "start" excludes\n' +
    '                             the take-off→SSS leg)\n' +
    '  --jump-the-gun-factor <n>  `jumpTheGunFactor`, HG early-start (default: 2)\n' +
    '  --jump-the-gun-max-seconds <s>\n' +
    '                             `jumpTheGunMaxSeconds`, HG (default: 300)\n\n' +
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
    case '--jump-the-gun-factor':
      params.jumpTheGunFactor = Number(args[++i]);
      break;
    case '--jump-the-gun-max-seconds':
      params.jumpTheGunMaxSeconds = Number(args[++i]);
      break;
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

if (positional.length < 2) usage();

// Refuse to guess the wing: GAP scoring needs a category to pick the official
// per-category defaults (arrival/difficulty/leading-weight differ HG vs PG), and
// the CLI has no comp record to read it from. Open distance ignores GAP params.
if (!openDistance && params.scoring === undefined) {
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
// Main
// ---------------------------------------------------------------------------

const taskPath = resolve(positional[0]);
const igcPaths = findIGCFiles(positional.slice(1));

if (igcPaths.length === 0) {
  process.stderr.write('Error: No IGC files found\n');
  process.exit(1);
}

// Parse task
const taskContent = readFileSync(taskPath, 'utf-8');
const task = parseXCTask(taskContent);
// Open distance has no goal/route, so there is no optimized task distance and
// no nominal-distance resolution — the take-off is the only turnpoint.
const taskDistance = openDistance ? 0 : calculateOptimizedTaskDistance(task);

// Mirror the UI / competition-api scoring path exactly (see computeTaskScore in
// web/workers/competition-api/src/scoring.ts): start from the official
// per-category FAI defaults (defaultsFor — leading/arrival/difficulty/nominal
// goal as the S7F formula actually uses them), then overlay only the flags the
// user explicitly passed. The CLI has no comp record, so the category comes from
// the required --wing flag (open distance ignores GAP params, so it falls
// back to 'hg' harmlessly). This keeps a run numerically identical to the web
// app for the same task and wing.
const category = params.scoring === 'PG' ? 'pg' : 'hg';
const gapParams: Partial<GAPParameters> = { ...defaultsFor(category), ...params };

// Auto-fill nominalDistance from a percentage of the optimized task distance
// (UI uses 70%) unless the user pinned an explicit --nominal-distance. Key off
// the *explicit* flag, exactly as the UI keys off the comp's stored value.
if (!openDistance && params.nominalDistance === undefined) {
  const pct = nominalDistancePct ?? 70;
  gapParams.nominalDistance = taskDistance * (pct / 100);
}

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

if (openDistance) {
  process.stderr.write(`Scoring ${pilots.length} pilots as open distance\n`);
} else {
  process.stderr.write(`Scoring ${pilots.length} pilots against task (${formatDist(taskDistance)})\n`);
}

// Score
const result = openDistance ? scoreOpenDistance(task, pilots) : scoreTask(task, pilots, gapParams);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonOutput) {
  // JSON output — keep the turnpoint sequence/leg breakdown for transparency,
  // but drop the bulky raw cylinder-crossing array.
  const output = {
    ...result,
    pilotScores: result.pilotScores.map(ps => {
      const { turnpointResult, ...rest } = ps;
      const { crossings: _crossings, ...sequenceResult } = turnpointResult;
      return { ...rest, turnpointResult: sequenceResult };
    }),
  };
  console.log(JSON.stringify(output, null, 2));
} else if (openDistance) {
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
  if (p.scoring === 'HG') {
    console.log(`  Arrival:        ${p.useArrival ? 'on' : 'off'}`);
    console.log(`  Difficulty:     ${p.useDistanceDifficulty ? 'on' : 'off'}`);
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
  console.log(`Task Validity:    ${(tv.task * 100).toFixed(1)}%`);
  console.log(`  Launch:         ${(tv.launch * 100).toFixed(1)}%`);
  console.log(`  Distance:       ${(tv.distance * 100).toFixed(1)}%`);
  console.log(`  Time:           ${(tv.time * 100).toFixed(1)}%`);
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
