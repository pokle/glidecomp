#!/usr/bin/env npx tsx
/**
 * CLI tool to fetch and display an XContest task by code
 *
 * Usage:
 *   npm run get-xcontest-task -- <code>          # Fetch from XContest API
 *   npm run get-xcontest-task -- --file <path>   # Parse local JSON file
 *   npm run get-xcontest-task -- --json '<json>' # Parse inline JSON
 *
 * Examples:
 *   npm run get-xcontest-task -- 12345
 *   npm run get-xcontest-task -- --file task.json
 *   npm run get-xcontest-task -- --json '{"taskType":"CLASSIC",...}'
 */

import { readFileSync } from 'fs';
import { fetchTaskByCode, parseXCTask, XCTask } from '../pages/src/analysis/xctsk-parser.js';

function printTaskSummary(task: XCTask): void {
  console.error('');
  console.error('=== Task Summary ===');
  console.error(`Type: ${task.taskType}`);
  console.error(`Version: ${task.version}`);
  console.error(`Earth Model: ${task.earthModel || 'WGS84'}`);
  console.error(`Turnpoints: ${task.turnpoints.length}`);

  for (let i = 0; i < task.turnpoints.length; i++) {
    const tp = task.turnpoints[i];
    const type = tp.type ? ` (${tp.type})` : '';
    console.error(`  ${i + 1}. ${tp.waypoint.name}${type} - ${tp.radius}m @ ${tp.waypoint.lat.toFixed(5)}, ${tp.waypoint.lon.toFixed(5)}`);
  }

  if (task.sss) {
    console.error(`SSS: ${task.sss.type}, ${task.sss.direction}`);
    if (task.sss.timeGates) {
      console.error(`  Time gates: ${task.sss.timeGates.join(', ')}`);
    }
  }

  if (task.goal) {
    console.error(`Goal: ${task.goal.type}`);
    if (task.goal.deadline) {
      console.error(`  Deadline: ${task.goal.deadline}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage:');
    console.error('  npm run get-xcontest-task -- <code>          # Fetch from XContest API');
    console.error('  npm run get-xcontest-task -- --file <path>   # Parse local JSON file');
    console.error('  npm run get-xcontest-task -- --json \'<json>\' # Parse inline JSON');
    console.error('');
    console.error('Examples:');
    console.error('  npm run get-xcontest-task -- 12345');
    console.error('  npm run get-xcontest-task -- --file task.json');
    process.exit(1);
  }

  try {
    let task: XCTask;

    if (args[0] === '--file') {
      // Parse from file
      const filePath = args[1];
      if (!filePath) {
        console.error('Error: --file requires a file path');
        process.exit(1);
      }
      console.error(`Parsing file: ${filePath}`);
      const content = readFileSync(filePath, 'utf-8');
      task = parseXCTask(content);

    } else if (args[0] === '--json') {
      // Parse inline JSON
      const json = args[1];
      if (!json) {
        console.error('Error: --json requires a JSON string');
        process.exit(1);
      }
      console.error('Parsing inline JSON...');
      task = parseXCTask(json);

    } else {
      // Fetch from API
      const code = args[0];
      console.error(`Fetching task: ${code}`);
      console.error(`URL: https://tools.xcontest.org/api/xctsk/load/${encodeURIComponent(code)}`);
      console.error('');
      task = await fetchTaskByCode(code);
    }

    // Output the task as formatted JSON to stdout
    console.log(JSON.stringify(task, null, 2));

    // Output summary to stderr
    printTaskSummary(task);

  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
      if (error.cause) {
        console.error('Cause:', error.cause);
      }
    } else {
      console.error('Error:', error);
    }
    process.exit(1);
  }
}

main();
