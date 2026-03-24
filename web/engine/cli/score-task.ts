#!/usr/bin/env npx tsx
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
 * Options:
 *   --nominal-distance <m>    Nominal distance in meters (default: 70% of task distance)
 *   --nominal-time <s>        Nominal time in seconds (default: 5400)
 *   --nominal-goal <ratio>    Nominal goal ratio 0-1 (default: 0.2)
 *   --nominal-launch <ratio>  Nominal launch ratio 0-1 (default: 0.96)
 *   --min-distance <m>        Minimum distance in meters (default: 5000)
 *   --scoring <PG|HG>         Sport type (default: PG)
 *   --json                    Output results as JSON
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, DEFAULT_GAP_PARAMETERS, type GAPParameters, type PilotFlight } from '../src/gap-scoring';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function usage(): never {
  process.stderr.write(
    'Usage: score-task <task.xctsk> <igc-file-or-folder>...\n\n' +
    'Options:\n' +
    '  --nominal-distance-pct <%> Nominal distance as % of task distance (default: 70)\n' +
    '  --nominal-distance <m>     Nominal distance in meters (overrides percentage)\n' +
    '  --nominal-time <s>         Nominal time in seconds (default: 5400)\n' +
    '  --nominal-goal <ratio>     Nominal goal ratio 0-1 (default: 0.2)\n' +
    '  --nominal-launch <ratio>   Nominal launch ratio 0-1 (default: 0.96)\n' +
    '  --min-distance <m>         Minimum distance in meters (default: 5000)\n' +
    '  --scoring <PG|HG>          Sport type (default: HG)\n' +
    '  --no-leading               Disable leading (departure) points\n' +
    '  --no-arrival               Disable arrival points\n' +
    '  --json                     Output as JSON\n'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

// Parse options
const params: Partial<GAPParameters> = {};
let jsonOutput = false;
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
    case '--min-distance':
      params.minimumDistance = Number(args[++i]);
      break;
    case '--scoring':
      params.scoring = args[++i] as 'PG' | 'HG';
      break;
    case '--no-leading':
      params.useLeading = false;
      break;
    case '--no-arrival':
      params.useArrival = false;
      break;
    case '--json':
      jsonOutput = true;
      break;
    case '--help':
    case '-h':
      usage();
      break;
    default:
      positional.push(arg);
  }
}

if (positional.length < 2) usage();

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
const taskDistance = calculateOptimizedTaskDistance(task);

// Resolve nominal distance: explicit meters > percentage > default 70%
if (params.nominalDistance === undefined) {
  const pct = nominalDistancePct ?? 70;
  params.nominalDistance = taskDistance * (pct / 100);
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

process.stderr.write(`Scoring ${pilots.length} pilots against task (${formatDist(taskDistance)})\n`);

// Score
const result = scoreTask(task, pilots, params);

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonOutput) {
  // JSON output — omit the full turnpointResult and fixes for brevity
  const output = {
    ...result,
    pilotScores: result.pilotScores.map(ps => {
      const { turnpointResult: _, ...rest } = ps;
      return rest;
    }),
  };
  console.log(JSON.stringify(output, null, 2));
} else {
  // Table output
  const tv = result.taskValidity;
  const ap = result.availablePoints;
  const w = result.weights;
  const s = result.stats;

  console.log('');
  console.log('=== Task Scoring Results (CIVL GAP) ===');
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

  // Header
  const header = [
    padLeft('#', 4),
    padRight('Pilot', 25),
    padLeft('Dist', 10),
    padLeft('Time', 10),
    padLeft('Dist Pts', 9),
    padLeft('Time Pts', 9),
    padLeft('Lead Pts', 9),
    padLeft('Total', 7),
  ];
  if (result.parameters.scoring === 'HG') {
    header.splice(7, 0, padLeft('Arr Pts', 9));
  }
  console.log(header.join('  '));
  console.log('-'.repeat(header.join('  ').length));

  for (const ps of result.pilotScores) {
    const row = [
      padLeft(String(ps.rank), 4),
      padRight(ps.pilotName.slice(0, 25), 25),
      padLeft(formatDist(ps.flownDistance), 10),
      padLeft(ps.madeGoal ? formatTime(ps.speedSectionTime) : (ps.reachedESS ? 'ESS' : '-'), 10),
      padLeft(ps.distancePoints.toFixed(1), 9),
      padLeft(ps.timePoints.toFixed(1), 9),
      padLeft(ps.leadingPoints.toFixed(1), 9),
      padLeft(String(ps.totalScore), 7),
    ];
    if (result.parameters.scoring === 'HG') {
      row.splice(7, 0, padLeft(ps.arrivalPoints.toFixed(1), 9));
    }
    console.log(row.join('  '));
  }
  console.log('');
}
