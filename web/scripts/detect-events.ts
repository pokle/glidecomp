#!/usr/bin/env npx tsx
import { readFileSync } from 'fs';
import { parseIGC } from '../analysis/src/igc-parser';
import { parseXCTask } from '../analysis/src/xctsk-parser';
import { detectFlightEvents } from '../analysis/src/event-detector';

function formatTime(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function num(v: unknown, decimals = 1): string {
  return typeof v === 'number' ? v.toFixed(decimals) : String(v ?? '');
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

console.log('time,type,lat,lon,altitude,wind_dir,wind_speed,description');
for (const event of events) {
  const d = event.details;
  const windDir = d?.windDirection ?? d?.driftWindDirection;
  const windSpeed = d?.windSpeed ?? d?.driftWindSpeed;

  let description = event.description;
  if (event.type === 'circle_complete' && d) {
    const parts = [
      `#${d.circleNumber}`,
      d.turnDirection,
      `climb=${num(d.climbRate)}m/s`,
      `dur=${num(d.duration)}s`,
      `r=${num(d.radius, 0)}m`,
      `center=${num(d.centerLat, 6)},${num(d.centerLon, 6)}`,
      `fitErr=${num(d.fitError, 1)}m`,
      `quality=${num(d.quality, 2)}`,
      `liftBearing=${num(d.strongestLiftBearing, 0)}°`,
    ];
    if (d.windSpeed != null) parts.push(`gsWind=${num(d.windSpeed, 1)}m/s@${num(d.windDirection, 0)}°`);
    if (d.driftWindSpeed != null) parts.push(`driftWind=${num(d.driftWindSpeed, 1)}m/s@${num(d.driftWindDirection, 0)}°`);
    description = parts.join(' ');
  }

  const line = [
    formatTime(event.time),
    event.type,
    event.latitude.toFixed(6),
    event.longitude.toFixed(6),
    event.altitude.toFixed(0),
    windDir != null ? Number(windDir).toFixed(0) : '',
    windSpeed != null ? Number(windSpeed).toFixed(1) : '',
    csvEscape(description),
  ].join(',');
  console.log(line);
}
