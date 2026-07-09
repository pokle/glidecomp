#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Seed (or re-seed) the public sample competition into D1 + R2, so every user
 * can view it and the /replay page can pull packed track data from the
 * competition-api Worker (GET /api/comp/sample-3dvis).
 *
 * Loads the full Corryong Cup 2026 competition — all three tasks and every
 * pilot track — as a single comp. Each task lives in its own source directory
 * (web/samples/comps/corryong-cup-2026-t{1,2,3}); a pilot who flew several
 * tasks gets one comp_pilot row (keyed by their federation id, see
 * `filename_id_field` below) with a task_track per task.
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
 * Source: the comp folders written by download-airscore-comp.ts, described by
 * web/samples/comps/<slug>/comp.json. That manifest lists every task with its
 * pilot class (AirScore runs "open" and "floater" as separate comps flying
 * different tasks per day; here they become one comp with two classes). A pilot
 * who flew in both classes gets one comp_pilot row per class.
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIGC } from '@glidecomp/engine';
import { timezoneForXctsk } from '@glidecomp/engine/timezone';
import { SAMPLE_COMP_NAME } from '../workers/competition-api/src/sample';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const COMPS_ROOT = join(REPO_ROOT, 'web/samples/comps');
// Which downloaded comp to seed (matches a folder under COMPS_ROOT). The
// `--remote` flag and the slug can appear in any arg order.
const SLUG = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'corryong-cup-2026';
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

/** Pull the pilot's federation id out of `lamb_18239_050126.igc` → `18239`, else null. */
function idFromFilename(file: string): string | null {
  // Drop the trailing _DDMMYY date stamp first so it can't be mistaken for an
  // id when the real one is too short to match (e.g. `rigg_0_050125.igc`,
  // whose id "0" means none — without this the pilot got a different
  // fake id per task date and split into one comp_pilot row per task).
  const parts = basename(file, '.igc').replace(/_\d{6}$/, '').split('_');
  return parts.find((p) => /^\d{3,}$/.test(p)) ?? null;
}

interface SamplePilot {
  name: string;
  id: string | null;
  gz: Buffer;
  fileSize: number;
}

interface TaskSpec {
  dir: string;
  name: string;
  date: string;
  pilotClass: string;
}

interface SampleTask extends TaskSpec {
  xctsk: string;
  pilots: SamplePilot[];
}

interface CompManifest {
  name: string;
  slug: string;
  classes: string[];
  tasks: Array<{ pilot_class: string; name: string; date: string; dir: string }>;
  /**
   * Optional overrides. The Corryong sample omits these and inherits the
   * historical defaults (the fixed SAMPLE_COMP_NAME, 'hg', GAP scoring). The
   * synthetic Big Chip comp sets them to seed a second, open-distance comp.
   */
  comp_name?: string;
  category?: string;
  scoring_format?: 'gap' | 'open_distance';
  /**
   * Which comp_pilot column the numeric id embedded in the IGC filenames
   * (`lamb_18239_050126.igc`) belongs to. AirScore's exports for the bundled
   * Australian comps stamp the pilot's SAFA member number there, so 'safa_id'
   * is the default; the synthetic Big Chip comp names its files by its
   * fabricated CIVL ids and sets 'civl_id'.
   */
  filename_id_field?: 'safa_id' | 'civl_id';
}

/**
 * Read one task directory: its .xctsk and every non-empty IGC track. `tzOut`
 * is populated with the first timezone derived from a task's location (via
 * the engine's tz-lookup helper — the same derivation the competition-api
 * runs on route save) so the caller can stamp it on the comp row.
 */
function readTask(spec: TaskSpec, tzOut: { value?: string }): SampleTask {
  const compDir = join(COMPS_ROOT, spec.dir);
  const entries = readdirSync(compDir);
  const igcFiles = entries.filter((f) => f.toLowerCase().endsWith('.igc')).sort();
  if (igcFiles.length === 0) throw new Error(`No IGC files in ${compDir}`);

  const taskFile = entries.find((f) => f.toLowerCase().endsWith('.xctsk'));
  if (!taskFile) throw new Error(`No .xctsk task file in ${compDir}`);
  const xctsk = readFileSync(join(compDir, taskFile), 'utf-8');
  if (tzOut.value === undefined) {
    tzOut.value = timezoneForXctsk(xctsk);
  }

  const pilots: SamplePilot[] = [];
  for (const file of igcFiles) {
    const text = readFileSync(join(compDir, file), 'utf-8');
    const igc = parseIGC(text);
    if (igc.fixes.length === 0) continue;
    const name = (igc.header.pilot || basename(file, '.igc')).replace(/\s+/g, ' ').trim();
    const gz = gzipSync(Buffer.from(text, 'utf-8'), { level: 9 });
    pilots.push({ name, id: idFromFilename(file), gz, fileSize: gz.byteLength });
  }

  return { ...spec, xctsk, pilots };
}

// --- seed ------------------------------------------------------------------

/**
 * Registry key for a pilot within a class: CIVL id when known (the primary
 * match key), else the display name, scoped by pilot class. A pilot who flew in
 * two classes (e.g. floater one day, open the next) gets one comp_pilot row per
 * class; within a class, all their tasks share a single row.
 */
function pilotKey(pilotClass: string, id: string | null, name: string): string {
  return `${pilotClass} ${id ? `id:${id}` : `name:${name}`}`;
}

/** "open" → "Open", so task names read "Task 1 (Open)". */
function classLabel(pilotClass: string): string {
  return pilotClass.charAt(0).toUpperCase() + pilotClass.slice(1);
}

function loadManifest(): CompManifest {
  const path = join(COMPS_ROOT, SLUG, 'comp.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as CompManifest;
}

function main(): void {
  const where = REMOTE ? 'REMOTE (production)' : `local (${PERSIST})`;
  const manifest = loadManifest();
  // The comp's D1 name, category and scoring format come from the manifest when
  // present (Big Chip), else fall back to the historical Corryong defaults.
  const compName = manifest.comp_name ?? SAMPLE_COMP_NAME;
  const category = manifest.category ?? 'hg';
  const scoringFormat = manifest.scoring_format ?? 'gap';
  // The numeric id in each IGC filename is a SAFA member number for the bundled
  // Australian AirScore comps; Big Chip overrides this to 'civl_id'. Map it to
  // the matching comp_pilot column.
  const idField = manifest.filename_id_field ?? 'safa_id';
  const idColumn = `registered_pilot_${idField}`;
  console.log(`Seeding "${compName}" (${SLUG}) into ${where}…`);
  console.log(`  classes: ${manifest.classes.join(', ')}`);
  console.log(`  category: ${category}, scoring: ${scoringFormat}, filename id: ${idField}`);

  // Read every task, sharing one resolved timezone across the comp.
  const tzOut: { value?: string } = {};
  const tasks = manifest.tasks.map((t) =>
    readTask({ dir: t.dir, name: t.name, date: t.date, pilotClass: t.pilot_class }, tzOut),
  );
  for (const t of tasks) {
    console.log(`  ${t.pilotClass}/${t.name} (${t.date}): ${t.pilots.length} pilots`);
  }
  console.log(`  timezone ${tzOut.value ?? 'unresolved'}`);

  // One comp_pilot row per (class, pilot). First-seen name/id wins within a key.
  interface RegPilot { name: string; id: string | null; pilotClass: string }
  const registry = new Map<string, RegPilot>();
  for (const t of tasks) {
    for (const p of t.pilots) {
      const key = pilotKey(t.pilotClass, p.id, p.name);
      if (!registry.has(key)) {
        registry.set(key, { name: p.name, id: p.id, pilotClass: t.pilotClass });
      }
    }
  }
  const perClass = manifest.classes
    .map((c) => `${c}: ${[...registry.values()].filter((p) => p.pilotClass === c).length}`)
    .join(', ');
  console.log(`  ${registry.size} pilot registrations (${perClass})`);

  const today = new Date().toISOString().slice(0, 10);
  const classesJson = JSON.stringify(manifest.classes);
  const defaultClass = manifest.classes[0];

  // 1) Find or create the comp (stable comp_id across reruns).
  const existing = rows(`SELECT comp_id FROM comp WHERE name = ${q(compName)};`);
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
        `UPDATE comp SET category=${q(category)}, test=0, scoring_format=${q(scoringFormat)},
           pilot_classes=${q(classesJson)},
           default_pilot_class=${q(defaultClass)},
           timezone=${q(tzOut.value ?? null)} WHERE comp_id = ${compId};`,
      ].join('\n'),
    );
  } else {
    exec(
      `INSERT INTO comp (name, creation_date, category, test, scoring_format, pilot_classes, default_pilot_class, timezone)
       VALUES (${q(compName)}, ${q(today)}, ${q(category)}, 0, ${q(scoringFormat)}, ${q(classesJson)}, ${q(defaultClass)}, ${q(tzOut.value ?? null)});`,
    );
    compId = Number(rows(`SELECT comp_id FROM comp WHERE name = ${q(compName)};`)[0].comp_id);
    console.log(`  created comp_id ${compId}`);
  }

  // 2) comp_pilot rows (one per registration), then read back ids by our key.
  const registrations = [...registry.values()];
  exec(
    registrations
      .map(
        (p) =>
          `INSERT INTO comp_pilot (comp_id, registered_pilot_name, ${idColumn}, pilot_class)
           VALUES (${compId}, ${q(p.name)}, ${q(p.id)}, ${q(p.pilotClass)});`,
      )
      .join('\n'),
  );
  const cpRows = rows(
    `SELECT comp_pilot_id, registered_pilot_name, ${idColumn} AS id, pilot_class
       FROM comp_pilot WHERE comp_id = ${compId};`,
  );
  // Re-derive the same (class, id-or-name) key from the read-back rows.
  const cpByKey = new Map(
    cpRows.map((r) => {
      const id = r.id ? String(r.id) : null;
      const key = pilotKey(String(r.pilot_class), id, String(r.registered_pilot_name));
      return [key, Number(r.comp_pilot_id)];
    }),
  );

  // 3) Per task: insert the task + its single scored class, then upload each IGC
  //    to R2 and insert its task_track row (linked to the class's comp_pilot).
  //    Open and floater "Task 1" share a date but are distinct rows, named by
  //    class so the app's task list disambiguates them.
  const tmpDir = mkdtempSync(join(tmpdir(), 'seed-igc-'));
  const now = new Date().toISOString();
  let totalTracks = 0;
  const taskSummaries: string[] = [];
  for (const t of tasks) {
    const taskName = `${t.name} (${classLabel(t.pilotClass)})`;
    exec(
      `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
       VALUES (${compId}, ${q(taskName)}, ${q(t.date)}, ${q(today)}, ${q(t.xctsk)});`,
    );
    const taskId = Number(
      rows(`SELECT task_id FROM task WHERE comp_id = ${compId} AND name = ${q(taskName)};`)[0].task_id,
    );
    exec(`INSERT INTO task_class (task_id, pilot_class) VALUES (${taskId}, ${q(t.pilotClass)});`);

    const trackInserts: string[] = [];
    let n = 0;
    for (const p of t.pilots) {
      const compPilotId = cpByKey.get(pilotKey(t.pilotClass, p.id, p.name));
      if (compPilotId === undefined) continue;
      const key = `c/${compId}/t/${taskId}/${compPilotId}.igc`;
      const gzFile = join(tmpDir, `${taskId}-${compPilotId}.igc.gz`);
      writeFileSync(gzFile, p.gz);
      r2Put(key, gzFile);
      trackInserts.push(
        `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size, igc_pilot_name)
         VALUES (${taskId}, ${compPilotId}, ${q(key)}, ${q(now)}, ${p.fileSize}, ${q(p.name)});`,
      );
      // A pilot with a track took off and landed, so mark them "Landed" — the
      // same status a real upload sets (applyStatusOnTrackUpload). The direct
      // insert bypasses that hook, so without this the roll call would show
      // every seeded pilot as "Present" (as if nobody took off). Registered
      // pilots with no track for this task keep the Present default (no row).
      trackInserts.push(
        `INSERT INTO task_pilot_status (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
         VALUES (${compId}, ${taskId}, ${compPilotId}, 'landed', NULL, NULL, 'Sample data', ${q(now)});`,
      );
      n++;
    }
    exec(trackInserts.join('\n'));
    totalTracks += n;
    taskSummaries.push(`${taskName} (task_id=${taskId}, ${n} tracks)`);
    console.log(`  seeded ${taskName}: task_id=${taskId}, ${n} tracks`);
  }

  console.log(`\nDone. comp_id=${compId} — ${tasks.length} tasks, ${totalTracks} tracks total`);
  for (const s of taskSummaries) console.log(`    ${s}`);
  console.log(`  Sample 3dvis: GET /api/comp/sample-3dvis`);
  console.log(`  View at:      /replay`);
  if (!REMOTE) console.log('  (local state — start dev servers with `bun run dev`)');
}

main();
