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
if (args.length < 2) {
  process.stderr.write('Usage: detect-events <task.xctask> <flight.igc>\n');
  process.exit(1);
}

const taskPath = args[0];
const igcPath = args[1];

const taskContent = readFileSync(taskPath, 'utf-8');
const task = parseXCTask(taskContent);

const igcContent = readFileSync(igcPath, 'utf-8');
const igc = parseIGC(igcContent);

if (igc.fixes.length === 0) {
  process.stderr.write('Error: No fixes found in IGC file\n');
  process.exit(1);
}

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
