#!/usr/bin/env npx tsx
import { readFileSync } from 'fs';
import { parseIGC } from '../packages/analysis/src/igc-parser';
import { parseXCTask } from '../packages/analysis/src/xctsk-parser';
import { detectFlightEvents } from '../packages/analysis/src/event-detector';

function formatTime(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Main
const args = process.argv.slice(2);
if (args.length < 1) {
  process.stderr.write('Usage: detect-events <flight.igc> [task.xctask]\n');
  process.exit(1);
}

const igcPath = args[0];
const taskPath = args.length >= 2 ? args[1] : undefined;

const igcContent = readFileSync(igcPath, 'utf-8');
const igc = parseIGC(igcContent);

if (igc.fixes.length === 0) {
  process.stderr.write('Error: No fixes found in IGC file\n');
  process.exit(1);
}

const task = taskPath ? parseXCTask(readFileSync(taskPath, 'utf-8')) : undefined;

const events = detectFlightEvents(igc.fixes, task);

console.log('time,type,lat,lon,altitude,description');
for (const event of events) {
  const line = [
    formatTime(event.time),
    event.type,
    event.latitude.toFixed(6),
    event.longitude.toFixed(6),
    event.altitude.toFixed(0),
    csvEscape(event.description),
  ].join(',');
  console.log(line);
}
