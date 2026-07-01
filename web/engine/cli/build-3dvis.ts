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
 *   comp-dir = web/samples/comps/corryong-cup-2026-open-t1
 *   out-dir  = web/frontend/public/samples/3dvis
 *
 * Writes <out-dir>/tracks.bin.gz and <out-dir>/manifest.json.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { find as findTimezone } from 'geo-tz';
import { parseIGC } from '../src/igc-parser';
import { packTracksFromIgc, type PilotIgc } from '../src/track-pack-pipeline';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const args = process.argv.slice(2);
const compDir = resolve(args[0] ?? join(REPO_ROOT, 'web/samples/comps/corryong-cup-2026-open-t1'));
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

  const taskFile = entries.find((f) => f.toLowerCase().endsWith('.xctsk'));
  const taskXctsk = taskFile ? readFileSync(join(compDir, taskFile), 'utf-8') : undefined;

  // Resolve the comp's IANA timezone from the first fix (offline, via geo-tz) so
  // the viewer can show the comp's local time regardless of who's watching.
  let timezone: string | undefined;
  const pilots: PilotIgc[] = igcFiles.map((file) => {
    const text = readFileSync(join(compDir, file), 'utf-8');
    const igc = parseIGC(text);
    if (timezone === undefined && igc.fixes.length > 0) {
      try {
        timezone = findTimezone(igc.fixes[0].latitude, igc.fixes[0].longitude)[0];
      } catch {
        /* leave unresolved */
      }
    }
    const name = (igc.header.pilot || basename(file, '.igc')).replace(/\s+/g, ' ').trim();
    return { id: pilotIdFromFilename(file), name, igc: text };
  });

  // The shared pipeline parses, scores (GAP), and packs — identical to the Worker.
  const { manifest, data } = packTracksFromIgc({ pilots, taskXctsk, timezone });
  const ranked = manifest.pilots.filter((p) => p.rank != null).length;
  const skipped = pilots.length - manifest.pilots.length;

  mkdirSync(outDir, { recursive: true });
  const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(join(outDir, 'tracks.bin.gz'), gz);
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest));

  const durationMin = ((manifest.t1 - manifest.t0) / 60).toFixed(1);
  console.log(`\n3D replay asset written to ${outDir}`);
  console.log(`  pilots:    ${manifest.pilots.length} (${skipped} skipped, no fixes; ${ranked} ranked)`);
  console.log(`  vertices:  ${manifest.vertexCount.toLocaleString()}`);
  console.log(`  task span: ${durationMin} min  (alt ${manifest.altMin.toFixed(0)}–${manifest.altMax.toFixed(0)} m AGL-rel)`);
  console.log(`  turnpoints:${manifest.task ? ' ' + manifest.task.turnpoints.length : ' none'}`);
  console.log(`  timezone:  ${manifest.timezone ?? 'unresolved'}`);
  console.log(`  tracks.bin: ${(raw.length / 1e6).toFixed(2)} MB raw → ${(gz.length / 1e6).toFixed(2)} MB gzipped`);
}

main();
