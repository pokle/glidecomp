#!/usr/bin/env npx tsx
/**
 * Calculate total track distance from IGC file(s) using three methods:
 *   Haversine (Turf.js), Vincenty (WGS84), Andoyer (ellipsoidal approx)
 *
 * Usage:
 *   bun run web/engine/cli/track-distance.ts <igc-file-or-folder>...
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { parseIGC, type IGCFix } from '../src/igc-parser';
import { distance } from '@turf/distance';
import { point } from '@turf/helpers';

// ── Distance functions ──────────────────────────────────────────────────────

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return distance(point([lon1, lat1]), point([lon2, lat2]), { units: 'meters' });
}

function vincentyDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad, phi2 = lat2 * toRad;
  const L = (lon2 - lon1) * toRad;
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(phi1));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(phi2));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, lambdaP: number, iterLimit = 100;
  let sinSigma: number, cosSigma: number, sigma: number;
  let sinAlpha: number, cosSqAlpha: number, cos2SigmaM: number;
  do {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = cosU1 * cosU2 * sinL / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha : 0;
    const C = WGS84_F / 16 * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * WGS84_F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  } while (Math.abs(lambda - lambdaP!) > 1e-12 && --iterLimit > 0);
  const uSq = cosSqAlpha! * (WGS84_A ** 2 - WGS84_B ** 2) / (WGS84_B ** 2);
  const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const ds = B * sinSigma! * (cos2SigmaM! + B / 4 * (cosSigma! * (-1 + 2 * cos2SigmaM! ** 2) -
    B / 6 * cos2SigmaM! * (-3 + 4 * sinSigma! ** 2) * (-3 + 4 * cos2SigmaM! ** 2)));
  return WGS84_B * A * (sigma! - ds);
}

function andoyerDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad, phi2 = lat2 * toRad;
  const dLambda = (lon2 - lon1) * toRad;
  const F = (phi1 + phi2) / 2, G = (phi1 - phi2) / 2;
  const sinG = Math.sin(G), cosG = Math.cos(G);
  const sinF = Math.sin(F), cosF = Math.cos(F);
  const sinHL = Math.sin(dLambda / 2), cosHL = Math.cos(dLambda / 2);
  const S = sinG * sinG * cosHL * cosHL + cosF * cosF * sinHL * sinHL;
  const C = cosG * cosG * cosHL * cosHL + sinF * sinF * sinHL * sinHL;
  if (S === 0 || C === 0) return 0;
  const omega = Math.atan(Math.sqrt(S / C));
  const R = Math.sqrt(S * C) / omega;
  const D = 2 * omega * WGS84_A;
  const H1 = (3 * R - 1) / (2 * C);
  const H2 = (3 * R + 1) / (2 * S);
  return D * (1 + WGS84_F * (H1 * sinF * sinF * cosG * cosG - H2 * cosF * cosF * sinG * sinG));
}

// ── Track distance calculation ──────────────────────────────────────────────

type DistFn = (lat1: number, lon1: number, lat2: number, lon2: number) => number;

function trackDistance(fixes: IGCFix[], fn: DistFn): number {
  let total = 0;
  for (let i = 0; i < fixes.length - 1; i++) {
    total += fn(
      fixes[i].latitude, fixes[i].longitude,
      fixes[i + 1].latitude, fixes[i + 1].longitude
    );
  }
  return total;
}

// ── Main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: bun run web/engine/cli/track-distance.ts <igc-file-or-folder>...');
  process.exit(1);
}

// Collect IGC files
const igcFiles: string[] = [];
for (const arg of args) {
  const path = resolve(arg);
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const f of readdirSync(path)) {
      if (extname(f).toLowerCase() === '.igc') {
        igcFiles.push(resolve(path, f));
      }
    }
  } else if (extname(path).toLowerCase() === '.igc') {
    igcFiles.push(path);
  }
}

igcFiles.sort();

if (igcFiles.length === 0) {
  console.error('No IGC files found.');
  process.exit(1);
}

// Header
const singleFile = igcFiles.length === 1;
const nameWidth = singleFile ? 0 : 28;

console.log('=== Track Distance: Haversine vs Vincenty vs Andoyer ===\n');

if (!singleFile) {
  console.log(
    `${'File'.padEnd(nameWidth)}  ${'Fixes'.padStart(6)}  ` +
    `${'Haversine'.padStart(12)}  ${'Vincenty'.padStart(12)}  ${'Andoyer'.padStart(12)}  ` +
    `${'H−V err'.padStart(9)}  ${'A−V err'.padStart(9)}  ${'H−V ppm'.padStart(8)}`
  );
  console.log('-'.repeat(nameWidth + 80));
}

let grandH = 0, grandV = 0, grandA = 0;
let grandFixes = 0;
let grandSegments = 0;

for (const file of igcFiles) {
  const content = readFileSync(file, 'utf-8');
  const igc = parseIGC(content);
  const fixes = igc.fixes.filter(f => f.valid);

  if (fixes.length < 2) {
    if (!singleFile) console.log(`${basename(file).padEnd(nameWidth)}  (no valid fixes, skipped)`);
    continue;
  }

  const h = trackDistance(fixes, haversineDistance);
  const v = trackDistance(fixes, vincentyDistance);
  const a = trackDistance(fixes, andoyerDistance);

  grandH += h;
  grandV += v;
  grandA += a;
  grandFixes += fixes.length;
  grandSegments += fixes.length - 1;

  const hErr = h - v;
  const aErr = a - v;
  const hPpm = (hErr / v) * 1e6;

  if (singleFile) {
    const pilot = igc.header.pilot || basename(file, '.igc');
    console.log(`File:    ${basename(file)}`);
    console.log(`Pilot:   ${pilot}`);
    console.log(`Fixes:   ${fixes.length} (${fixes.length - 1} segments)\n`);
    console.log(`Method          Total distance     vs Vincenty`);
    console.log('-'.repeat(55));
    console.log(`Haversine       ${(h / 1000).toFixed(3).padStart(10)} km    ${hErr >= 0 ? '+' : ''}${hErr.toFixed(2)} m  (${hPpm.toFixed(1)} ppm)`);
    console.log(`Vincenty        ${(v / 1000).toFixed(3).padStart(10)} km    (reference)`);
    console.log(`Andoyer         ${(a / 1000).toFixed(3).padStart(10)} km    ${aErr >= 0 ? '+' : ''}${aErr.toFixed(2)} m  (${((aErr / v) * 1e6).toFixed(1)} ppm)`);
    const verb = hErr >= 0 ? 'overestimates' : 'underestimates';
    console.log(`\nHaversine ${verb} by ${Math.abs(hErr).toFixed(1)} m over ${(v / 1000).toFixed(1)} km track`);
  } else {
    const name = basename(file, '.igc').substring(0, nameWidth - 1);
    console.log(
      `${name.padEnd(nameWidth)}  ${fixes.length.toString().padStart(6)}  ` +
      `${(h / 1000).toFixed(2).padStart(11)}k  ${(v / 1000).toFixed(2).padStart(11)}k  ${(a / 1000).toFixed(2).padStart(11)}k  ` +
      `${hErr.toFixed(1).padStart(8)}m  ${aErr.toFixed(2).padStart(8)}m  ${hPpm.toFixed(0).padStart(8)}`
    );
  }
}

if (!singleFile) {
  const hErr = grandH - grandV;
  const aErr = grandA - grandV;
  const hPpm = (hErr / grandV) * 1e6;

  console.log('-'.repeat(nameWidth + 80));
  console.log(
    `${'TOTAL'.padEnd(nameWidth)}  ${grandFixes.toString().padStart(6)}  ` +
    `${(grandH / 1000).toFixed(2).padStart(11)}k  ${(grandV / 1000).toFixed(2).padStart(11)}k  ${(grandA / 1000).toFixed(2).padStart(11)}k  ` +
    `${hErr.toFixed(1).padStart(8)}m  ${aErr.toFixed(2).padStart(8)}m  ${hPpm.toFixed(0).padStart(8)}`
  );

  console.log(`\nTotal segments: ${grandSegments.toLocaleString()}`);
  const verb = hErr >= 0 ? 'overestimates' : 'underestimates';
  console.log(`Haversine ${verb} by ${Math.abs(hErr).toFixed(1)} m over ${(grandV / 1000).toFixed(1)} km of total track`);
  console.log(`Andoyer error vs Vincenty: ${aErr >= 0 ? '+' : ''}${aErr.toFixed(2)} m (${((aErr / grandV) * 1e6).toFixed(1)} ppm)`);
}
