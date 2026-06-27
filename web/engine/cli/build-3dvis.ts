#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * build-3dvis — Turn a folder of IGC tracks (+ optional task.xctsk) into the
 * compact gzipped binary asset consumed by the 3D flight-replay viewer
 * (web/frontend/src/samples/3dvis.*). See docs/flight-replay-3d-brief.md.
 *
 * The heavy lifting lives in the pure, fs-free `packTracks()` in the engine, so
 * this exact pipeline can later be lifted into a Cloudflare Worker (swap the
 * zlib gzip + writeFileSync below for CompressionStream + an R2 put).
 *
 * Usage:
 *   bun run build-3dvis [-- <comp-dir> <out-dir>]
 *
 * Defaults:
 *   comp-dir = web/samples/comps/corryong-cup-2026-t1
 *   out-dir  = web/frontend/public/samples/3dvis
 *
 * Writes <out-dir>/tracks.bin.gz and <out-dir>/manifest.json.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { packTracks, type PilotTrackInput } from '../src/track-packer';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const args = process.argv.slice(2);
const compDir = resolve(args[0] ?? join(REPO_ROOT, 'web/samples/comps/corryong-cup-2026-t1'));
const outDir = resolve(args[1] ?? join(REPO_ROOT, 'web/frontend/public/samples/3dvis'));

/** Pull a CIVL-ish id out of `lamb_18239_050126.igc` → `18239`, else the stem. */
function pilotIdFromFilename(file: string): string {
  const stem = basename(file, '.igc');
  const parts = stem.split('_');
  const numeric = parts.find((p) => /^\d{3,}$/.test(p));
  return numeric ?? stem;
}

function main(): void {
  const entries = readdirSync(compDir);
  const igcFiles = entries.filter((f) => f.toLowerCase().endsWith('.igc')).sort();
  if (igcFiles.length === 0) {
    console.error(`No .igc files found in ${compDir}`);
    process.exit(1);
  }

  // Task is optional context for the viewer.
  let task;
  const taskFile = entries.find((f) => f.toLowerCase().endsWith('.xctsk'));
  if (taskFile) {
    try {
      task = parseXCTask(readFileSync(join(compDir, taskFile), 'utf-8'));
    } catch (err) {
      console.warn(`Could not parse task ${taskFile}: ${(err as Error).message}`);
    }
  }

  const pilots: PilotTrackInput[] = [];
  let skipped = 0;
  for (const file of igcFiles) {
    const igc = parseIGC(readFileSync(join(compDir, file), 'utf-8'));
    if (igc.fixes.length === 0) {
      skipped++;
      console.warn(`  skip ${file}: no fixes`);
      continue;
    }
    const fixes = igc.fixes
      .map((f) => ({
        lat: f.latitude,
        lon: f.longitude,
        // Prefer GNSS altitude; fall back to pressure when GNSS is absent.
        alt: f.gnssAltitude || f.pressureAltitude,
        t: Math.round(f.time.getTime() / 1000),
      }))
      .sort((a, b) => a.t - b.t);

    pilots.push({
      id: pilotIdFromFilename(file),
      name: igc.header.pilot || basename(file, '.igc'),
      fixes,
    });
  }

  const { manifest, data } = packTracks({ pilots, task });

  mkdirSync(outDir, { recursive: true });
  const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(join(outDir, 'tracks.bin.gz'), gz);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest));

  const durationMin = ((manifest.t1 - manifest.t0) / 60).toFixed(1);
  console.log(`\n3D replay asset written to ${outDir}`);
  console.log(`  pilots:    ${manifest.pilots.length} (${skipped} skipped, no fixes)`);
  console.log(`  vertices:  ${manifest.vertexCount.toLocaleString()}`);
  console.log(`  task span: ${durationMin} min  (alt ${manifest.altMin.toFixed(0)}–${manifest.altMax.toFixed(0)} m AGL-rel)`);
  console.log(`  turnpoints:${manifest.task ? ' ' + manifest.task.turnpoints.length : ' none'}`);
  console.log(`  tracks.bin: ${(raw.length / 1e6).toFixed(2)} MB raw → ${(gz.length / 1e6).toFixed(2)} MB gzipped`);
}

main();
