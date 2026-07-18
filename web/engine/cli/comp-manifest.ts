// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Bundled-comp manifest reading for the score-task CLI's --comp mode.
 *
 * Deliberately mirrors (rather than reuses) the read path of
 * web/scripts/seed-sample-comp.ts, which is coupled to D1/Miniflare seeding —
 * keep the two in sync when the comp.json shape changes. A comp lives in
 * web/samples/comps/<slug>/comp.json with its per-task folders as SIBLINGS of
 * the meta folder (`<slug>-<class>-t<N>/`).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask, type XCTask } from '../src/xctsk-parser';
import type { PilotFlight } from '../src/gap-scoring';

export interface CompManifest {
  name: string;
  slug: string;
  classes: string[];
  tasks: Array<{ pilot_class: string; name: string; date: string; dir: string }>;
  comp_name?: string;
  category?: string;
  scoring_format?: 'gap' | 'open_distance';
  filename_id_field?: 'safa_id' | 'civl_id';
  hidden?: boolean;
}

const DEFAULT_COMPS_ROOT = resolve(fileURLToPath(new URL('../../samples/comps', import.meta.url)));

/**
 * Resolve `--comp <arg>`: a bundled slug (corryong-cup-2026), a directory
 * holding comp.json, or a path to comp.json itself. `compsRoot` is the folder
 * the manifest's task `dir`s are relative to (the meta folder's parent).
 */
export function loadCompManifest(slugOrDir: string): { manifest: CompManifest; compsRoot: string } {
  const asPath = resolve(slugOrDir);
  let manifestPath: string;
  if (existsSync(asPath) && statSync(asPath).isFile()) {
    manifestPath = asPath;
  } else if (existsSync(join(asPath, 'comp.json'))) {
    manifestPath = join(asPath, 'comp.json');
  } else {
    manifestPath = join(DEFAULT_COMPS_ROOT, slugOrDir, 'comp.json');
  }
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No comp manifest found for "${slugOrDir}" — expected a bundled slug under ` +
        `${DEFAULT_COMPS_ROOT}, a directory holding comp.json, or a comp.json path.`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as CompManifest;
  return { manifest, compsRoot: resolve(manifestPath, '../..') };
}

/**
 * Read one task folder: the single .xctsk plus every parseable IGC, in the
 * same shape score-task feeds to the scorer. Pilot names resolve like the
 * single-task CLI: IGC header pilot, else competition id, else filename.
 */
export function readTaskDir(dir: string): { task: XCTask; pilots: PilotFlight[] } {
  const entries = readdirSync(dir);
  const taskFile = entries.find((f) => f.toLowerCase().endsWith('.xctsk'));
  if (!taskFile) throw new Error(`No .xctsk task file in ${dir}`);
  const task = parseXCTask(readFileSync(join(dir, taskFile), 'utf-8'));

  const pilots: PilotFlight[] = [];
  for (const f of entries.filter((e) => e.toLowerCase().endsWith('.igc')).sort()) {
    const igcPath = join(dir, f);
    try {
      const igc = parseIGC(readFileSync(igcPath, 'utf-8'));
      if (igc.fixes.length === 0) {
        process.stderr.write(`Warning: No fixes in ${f}, skipping\n`);
        continue;
      }
      const pilotName = igc.header.pilot || igc.header.competitionId || basename(f, '.igc');
      pilots.push({ pilotName, trackFile: igcPath, fixes: igc.fixes });
    } catch (err) {
      process.stderr.write(`Warning: Failed to parse ${f}: ${err}\n`);
    }
  }
  return { task, pilots };
}

/**
 * Cross-task pilot key. Track filenames embed the task date
 * (`lamb_18239_050126.igc`), so trackFile can't pair a pilot between tasks —
 * the embedded federation id can (same digit-extraction as the seed script's
 * `idFromFilename`), with the normalized pilot name as the fallback.
 */
export function pilotKeyFor(trackFile: string, pilotName: string): string {
  const parts = basename(trackFile, '.igc').replace(/_\d{6}$/, '').split('_');
  const id = parts.find((p) => /^\d{3,}$/.test(p));
  return id ? `id:${id}` : `name:${pilotName.replace(/\s+/g, ' ').trim().toLowerCase()}`;
}
