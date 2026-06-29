#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Seed (or re-seed) the public sample competition into D1 + R2, so every user
 * can view it and the /samples/3dvis page can pull packed track data from the
 * competition-api Worker (GET /api/comp/sample-3dvis).
 *
 * Idempotent: the comp is identified by name (SAMPLE_COMP_NAME). On a rerun the
 * existing comp's tasks / pilots / tracks (D1) and IGC objects (R2) are wiped
 * and rebuilt under the SAME comp_id, so if users have messed with the loaded
 * sample it gets fixed back up.
 *
 * Usage:
 *   bun run seed:sample            # local dev state (web/.wrangler/state)
 *   bun run seed:sample --remote   # production D1 + R2 (needs wrangler auth)
 *
 * Source files: web/samples/comps/corryong-cup-2026-t1 (33 IGC + task.xctsk).
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseIGC } from '@glidecomp/engine';
import { SAMPLE_COMP_NAME } from '../workers/competition-api/src/sample';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const COMP_DIR = join(REPO_ROOT, 'web/samples/comps/corryong-cup-2026-t1');
const DB_NAME = 'taskscore-auth';
const R2_BUCKET = 'glidecomp';
const PERSIST = 'web/.wrangler/state';
// Resolve all bindings (D1 + R2) from the competition-api worker config.
const CONFIG = ['--config', 'web/workers/competition-api/wrangler.toml'];

const REMOTE = process.argv.includes('--remote');
// Local commands target the same persisted state the dev workers use; remote
// targets the real Cloudflare D1 + R2.
const TARGET = REMOTE ? ['--remote'] : ['--local', '--persist-to', PERSIST];

// --- wrangler helpers ------------------------------------------------------

function wrangler(args: string[]): string {
  const res = spawnSync('bunx', ['wrangler', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/**
 * Extract wrangler's JSON payload from stdout. On `--remote`, wrangler decorates
 * stdout with progress lines ("├ Checking if file needs uploading", spinner
 * frames, "🌀 Uploading …") before the JSON array, so the whole string isn't
 * valid JSON — slice from the first `[`. (Warnings/banners go to stderr, which
 * `wrangler()` discards, so they never reach here.)
 */
function parseWranglerJson(out: string): Array<{ results: Record<string, unknown>[] }> {
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON found):\n${out}`);
  return JSON.parse(out.slice(start));
}

/**
 * Run write SQL (one or more statements) via --file, so large/batched bodies
 * (the xctsk blob, 32-row pilot/track inserts) aren't capped by the shell
 * argument length. The result is intentionally not read back: on `--remote` the
 * --file path returns only an execution summary (not result rows), which is
 * exactly why reads must use --command instead.
 */
function exec(sql: string): void {
  const tmp = join(mkdtempSync(join(tmpdir(), 'seed-')), 'q.sql');
  writeFileSync(tmp, sql);
  wrangler(['d1', 'execute', DB_NAME, ...CONFIG, ...TARGET, '--json', '--file', tmp]);
}

/**
 * Run a single read query and return its rows. Uses --command (not --file)
 * because `--remote --file` returns an execution summary rather than the result
 * set; --command returns the actual rows in both local and remote modes.
 */
function rows(sql: string): Record<string, unknown>[] {
  const out = wrangler(['d1', 'execute', DB_NAME, ...CONFIG, ...TARGET, '--json', '--command', sql]);
  return parseWranglerJson(out)[0]?.results ?? [];
}

function r2Put(key: string, file: string): void {
  wrangler([
    'r2', 'object', 'put', `${R2_BUCKET}/${key}`,
    '--file', file, '--content-type', 'application/octet-stream',
    '--content-encoding', 'gzip', ...CONFIG, ...TARGET,
  ]);
}

function r2Delete(key: string): void {
  try {
    wrangler(['r2', 'object', 'delete', `${R2_BUCKET}/${key}`, ...CONFIG, ...TARGET]);
  } catch {
    /* object may not exist — fine */
  }
}

/** Single-quote a value for SQL, escaping embedded quotes. NULL passes through. */
function q(v: string | number | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

// --- read the sample source ------------------------------------------------

/** Pull a CIVL-ish id out of `lamb_18239_050126.igc` → `18239`, else null. */
function civlFromFilename(file: string): string | null {
  const parts = basename(file, '.igc').split('_');
  return parts.find((p) => /^\d{3,}$/.test(p)) ?? null;
}

interface SamplePilot {
  name: string;
  civl: string | null;
  gz: Buffer;
  fileSize: number;
}

function readSample(): { pilots: SamplePilot[]; xctsk: string; timezone?: string } {
  const entries = readdirSync(COMP_DIR);
  const igcFiles = entries.filter((f) => f.toLowerCase().endsWith('.igc')).sort();
  if (igcFiles.length === 0) throw new Error(`No IGC files in ${COMP_DIR}`);

  const taskFile = entries.find((f) => f.toLowerCase().endsWith('.xctsk'));
  if (!taskFile) throw new Error(`No .xctsk task file in ${COMP_DIR}`);
  const xctskRaw = readFileSync(join(COMP_DIR, taskFile), 'utf-8');

  let timezone: string | undefined;
  const pilots: SamplePilot[] = [];
  for (const file of igcFiles) {
    const text = readFileSync(join(COMP_DIR, file), 'utf-8');
    const igc = parseIGC(text);
    if (igc.fixes.length === 0) continue;
    if (timezone === undefined) {
      try {
        // geo-tz is a node lib living in the engine workspace; resolve it from
        // there (best-effort — the viewer falls back to the browser zone).
        const engineRequire = createRequire(join(REPO_ROOT, 'web/engine/package.json'));
        const { find } = engineRequire('geo-tz') as {
          find: (lat: number, lon: number) => string[];
        };
        timezone = find(igc.fixes[0].latitude, igc.fixes[0].longitude)[0];
      } catch {
        /* leave unresolved → viewer falls back to browser zone */
      }
    }
    const name = (igc.header.pilot || basename(file, '.igc')).replace(/\s+/g, ' ').trim();
    const gz = gzipSync(Buffer.from(text, 'utf-8'), { level: 9 });
    pilots.push({ name, civl: civlFromFilename(file), gz, fileSize: gz.byteLength });
  }

  // Stash the timezone in the stored task JSON so the Worker (which can't run
  // geo-tz) can put it on the manifest. `_timezone` is ignored by parseXCTask.
  let xctsk = xctskRaw;
  if (timezone) {
    const obj = JSON.parse(xctskRaw);
    obj._timezone = timezone;
    xctsk = JSON.stringify(obj);
  }
  return { pilots, xctsk, timezone };
}

// --- seed ------------------------------------------------------------------

function main(): void {
  const where = REMOTE ? 'REMOTE (production)' : `local (${PERSIST})`;
  console.log(`Seeding "${SAMPLE_COMP_NAME}" into ${where}…`);

  const { pilots, xctsk, timezone } = readSample();
  console.log(`  ${pilots.length} pilots, timezone ${timezone ?? 'unresolved'}`);

  const today = new Date().toISOString().slice(0, 10);
  const taskDate = '2026-01-05'; // the sample flight date

  // 1) Find or create the comp (stable comp_id across reruns).
  const existing = rows(`SELECT comp_id FROM comp WHERE name = ${q(SAMPLE_COMP_NAME)};`);
  let compId: number;
  if (existing.length > 0) {
    compId = Number(existing[0].comp_id);
    console.log(`  reusing comp_id ${compId} — wiping its tasks/pilots/tracks`);
    // Delete R2 objects for the comp's tracks first (need the keys from D1).
    const oldKeys = rows(
      `SELECT tt.igc_filename AS k FROM task_track tt
       JOIN task t ON tt.task_id = t.task_id WHERE t.comp_id = ${compId};`,
    );
    for (const r of oldKeys) r2Delete(String(r.k));
    exec(
      [
        `DELETE FROM task_track WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
        `DELETE FROM task_pilot_status WHERE comp_id = ${compId};`,
        `DELETE FROM task_class WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
        `DELETE FROM task WHERE comp_id = ${compId};`,
        `DELETE FROM comp_pilot WHERE comp_id = ${compId};`,
        `DELETE FROM audit_log WHERE comp_id = ${compId};`,
        `UPDATE comp SET category='hg', test=0, pilot_classes='["open"]',
           default_pilot_class='open' WHERE comp_id = ${compId};`,
      ].join('\n'),
    );
  } else {
    exec(
      `INSERT INTO comp (name, creation_date, category, test, pilot_classes, default_pilot_class)
       VALUES (${q(SAMPLE_COMP_NAME)}, ${q(today)}, 'hg', 0, '["open"]', 'open');`,
    );
    compId = Number(rows(`SELECT comp_id FROM comp WHERE name = ${q(SAMPLE_COMP_NAME)};`)[0].comp_id);
    console.log(`  created comp_id ${compId}`);
  }

  // 2) Task + its scored class.
  exec(
    `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
     VALUES (${compId}, 'Task 1', ${q(taskDate)}, ${q(today)}, ${q(xctsk)});`,
  );
  const taskId = Number(
    rows(`SELECT task_id FROM task WHERE comp_id = ${compId} ORDER BY task_id LIMIT 1;`)[0].task_id,
  );
  exec(`INSERT INTO task_class (task_id, pilot_class) VALUES (${taskId}, 'open');`);

  // 3) comp_pilot rows (one per pilot), then read back their ids by name.
  exec(
    pilots
      .map(
        (p) =>
          `INSERT INTO comp_pilot (comp_id, registered_pilot_name, registered_pilot_civl_id, pilot_class)
           VALUES (${compId}, ${q(p.name)}, ${q(p.civl)}, 'open');`,
      )
      .join('\n'),
  );
  const cpRows = rows(
    `SELECT comp_pilot_id, registered_pilot_name FROM comp_pilot WHERE comp_id = ${compId};`,
  );
  const cpByName = new Map(
    cpRows.map((r) => [String(r.registered_pilot_name), Number(r.comp_pilot_id)]),
  );

  // 4) Upload each IGC to R2 and insert its task_track row.
  const tmpDir = mkdtempSync(join(tmpdir(), 'seed-igc-'));
  const now = new Date().toISOString();
  const trackInserts: string[] = [];
  let n = 0;
  for (const p of pilots) {
    const compPilotId = cpByName.get(p.name);
    if (compPilotId === undefined) continue;
    const key = `c/${compId}/t/${taskId}/${compPilotId}.igc`;
    const gzFile = join(tmpDir, `${compPilotId}.igc.gz`);
    writeFileSync(gzFile, p.gz);
    r2Put(key, gzFile);
    trackInserts.push(
      `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size, igc_pilot_name)
       VALUES (${taskId}, ${compPilotId}, ${q(key)}, ${q(now)}, ${p.fileSize}, ${q(p.name)});`,
    );
    if (++n % 10 === 0) console.log(`  uploaded ${n}/${pilots.length} tracks…`);
  }
  exec(trackInserts.join('\n'));

  console.log(`\nDone. comp_id=${compId} task_id=${taskId} (${n} tracks)`);
  console.log(`  Sample 3dvis: GET /api/comp/sample-3dvis`);
  console.log(`  View at:      /samples/3dvis`);
  if (!REMOTE) console.log('  (local state — start dev servers with `bun run dev`)');
}

main();
