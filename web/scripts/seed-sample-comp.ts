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
 *
 * Performance: a comp has hundreds of tracks, and shelling out to `wrangler`
 * once per D1 statement / R2 object meant hundreds of ~1s CLI cold-starts (a
 * full local seed took minutes). Instead the local path drives storage through
 * a single in-process Miniflare — the exact version wrangler bundles, pointed
 * at the same `web/.wrangler/state/v3/{d1,r2}` files `bun run dev` reads — so
 * every write is an in-memory call and the whole seed is one process boot. The
 * `--remote` path still uses the wrangler CLI (it must hit real Cloudflare) but
 * fans the independent R2 uploads out concurrently instead of one at a time.
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIGC } from '@glidecomp/engine';
import { timezoneForXctsk } from '@glidecomp/engine/timezone';
import { SAMPLE_COMP_NAME } from '../workers/competition-api/src/sample';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const COMPS_ROOT = join(REPO_ROOT, 'web/samples/comps');
// Which downloaded comp to seed (matches a folder under COMPS_ROOT). The
// `--remote` flag and the slug can appear in any arg order.
const SLUG = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'corryong-cup-2026';
const PERSIST = 'web/.wrangler/state';
// Resolve all bindings (D1 + R2) from the competition-api worker config.
const WRANGLER_CONFIG_PATH = 'web/workers/competition-api/wrangler.toml';
const CONFIG = ['--config', WRANGLER_CONFIG_PATH];

const REMOTE = process.argv.includes('--remote');
// Local commands target the same persisted state the dev workers use; remote
// targets the real Cloudflare D1 + R2.
const TARGET = REMOTE ? ['--remote'] : ['--local', '--persist-to', PERSIST];

// Independent R2 uploads/deletes are fanned out this many at a time. In-process
// (local) Miniflare serialises them internally; for the remote wrangler CLI it
// caps how many uploader subprocesses run at once.
const R2_CONCURRENCY = 8;

// --- worker config (single source of truth for the storage bindings) -------

/**
 * Pull a string value out of a `[[header]]` table in the worker's wrangler.toml
 * (e.g. the D1 `database_id` or the R2 `bucket_name`). Miniflare keys the local
 * D1 sqlite file by the *database_id*, not the name, so the in-process store
 * must read the very same id wrangler/`bun run dev` use — hardcoding would
 * silently write to a different file than the app reads.
 */
const WRANGLER_TOML = readFileSync(join(REPO_ROOT, WRANGLER_CONFIG_PATH), 'utf-8');
function tomlValue(header: string, key: string): string {
  const block = WRANGLER_TOML.match(new RegExp(`\\[\\[${header}\\]\\]([\\s\\S]*?)(?=\\n\\[|$)`))?.[1] ?? '';
  const m = block.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
  if (!m) throw new Error(`wrangler.toml: [[${header}]] ${key} not found`);
  return m[1];
}
const D1_BINDING = tomlValue('d1_databases', 'binding');
const D1_DATABASE_ID = tomlValue('d1_databases', 'database_id');
const DB_NAME = tomlValue('d1_databases', 'database_name');
const R2_BINDING = tomlValue('r2_buckets', 'binding');
const R2_BUCKET = tomlValue('r2_buckets', 'bucket_name');

// --- storage store (local: in-process Miniflare; remote: wrangler CLI) ------

/**
 * The subset of storage operations the seed needs. `exec` takes either a single
 * SQL statement or a list of them run as one atomic batch (values are already
 * inlined via `q()`, so nothing is parameterised); R2 bodies are passed as
 * gzipped bytes, and each backend decides how to persist them.
 */
interface SeedStore {
  exec(statements: string | string[]): Promise<void>;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  r2Put(key: string, body: Buffer): Promise<void>;
  r2Delete(key: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Run `fn` over `items` with at most `concurrency` in flight at once. */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++]);
    }
  });
  await Promise.all(workers);
}

// -- local backend: one in-process Miniflare, no subprocess per operation -----

type MiniflareInstance = {
  getD1Database(name: string): Promise<D1Database>;
  getR2Bucket(name: string): Promise<R2Bucket>;
  dispose(): Promise<void>;
};
type MiniflareCtor = new (opts: Record<string, unknown>) => MiniflareInstance;

async function createLocalStore(): Promise<SeedStore> {
  // Import the *exact* Miniflare wrangler bundles (resolved through wrangler's
  // own dependency tree), so its persisted D1/R2 on-disk format matches byte
  // for byte what `bun run dev` reads back. A version-skewed copy writes a
  // durable-object sqlite schema wrangler then refuses to open.
  const wranglerEntry = Bun.resolveSync('wrangler', REPO_ROOT);
  const miniflareEntry = Bun.resolveSync('miniflare', wranglerEntry.replace(/\/dist\/.*$/, ''));
  const { Miniflare } = (await import(miniflareEntry)) as { Miniflare: MiniflareCtor };

  const persistRoot = join(REPO_ROOT, PERSIST);
  const mf = new Miniflare({
    modules: true,
    script: 'export default {};',
    // D1 is keyed by database_id; R2 by bucket name — both taken from the
    // worker's wrangler.toml so we hit the same files the dev workers use.
    d1Databases: { [D1_BINDING]: D1_DATABASE_ID },
    r2Buckets: { [R2_BINDING]: R2_BUCKET },
    d1Persist: join(persistRoot, 'v3/d1'),
    r2Persist: join(persistRoot, 'v3/r2'),
  });
  const db = await mf.getD1Database(D1_BINDING);
  const bucket = await mf.getR2Bucket(R2_BINDING);

  return {
    async exec(statements) {
      // D1's prepare() takes a single statement; strip a trailing `;` (safe —
      // inner `;` inside the quoted xctsk/IGC literals is untouched) and run the
      // whole set as one atomic batch.
      const list = (Array.isArray(statements) ? statements : [statements])
        .map((s) => s.trim().replace(/;\s*$/, ''))
        .filter(Boolean);
      if (list.length === 0) return;
      await db.batch(list.map((s) => db.prepare(s)));
    },
    async rows(sql) {
      const res = await db.prepare(sql).all();
      return (res.results ?? []) as Record<string, unknown>[];
    },
    async r2Put(key, body) {
      await bucket.put(key, body, {
        httpMetadata: { contentType: 'application/octet-stream', contentEncoding: 'gzip' },
      });
    },
    async r2Delete(key) {
      await bucket.delete(key);
    },
    async dispose() {
      await mf.dispose();
    },
  };
}

// -- remote backend: wrangler CLI against real Cloudflare D1 + R2 -------------

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

/** Async wrangler invocation, so independent R2 calls can run concurrently. */
function wranglerAsync(args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn('bunx', ['wrangler', ...args], { cwd: REPO_ROOT });
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) =>
      code === 0 ? res() : rej(new Error(`wrangler ${args.join(' ')} failed:\n${stderr || stdout}`)),
    );
  });
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

function createRemoteStore(): SeedStore {
  // One scratch dir for the SQL/R2 payload temp files this backend feeds to the
  // CLI (bodies via --file dodge the shell argument-length cap).
  const scratch = mkdtempSync(join(tmpdir(), 'seed-'));
  let seq = 0;
  return {
    async exec(statements) {
      const sql = (Array.isArray(statements) ? statements : [statements]).join('\n');
      if (!sql.trim()) return;
      const tmp = join(scratch, `q${seq++}.sql`);
      writeFileSync(tmp, sql);
      // The result is intentionally not read back: --remote --file returns only
      // an execution summary (not result rows), which is why reads use --command.
      wrangler(['d1', 'execute', DB_NAME, ...CONFIG, ...TARGET, '--json', '--file', tmp]);
    },
    async rows(sql) {
      const out = wrangler(['d1', 'execute', DB_NAME, ...CONFIG, ...TARGET, '--json', '--command', sql]);
      return parseWranglerJson(out)[0]?.results ?? [];
    },
    async r2Put(key, body) {
      const tmp = join(scratch, `o${seq++}.gz`);
      writeFileSync(tmp, body);
      await wranglerAsync([
        'r2', 'object', 'put', `${R2_BUCKET}/${key}`,
        '--file', tmp, '--content-type', 'application/octet-stream',
        '--content-encoding', 'gzip', ...CONFIG, ...TARGET,
      ]);
    },
    async r2Delete(key) {
      try {
        await wranglerAsync(['r2', 'object', 'delete', `${R2_BUCKET}/${key}`, ...CONFIG, ...TARGET]);
      } catch {
        /* object may not exist — fine */
      }
    },
    async dispose() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
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

async function main(): Promise<void> {
  const where = REMOTE ? 'REMOTE (production)' : `local (${PERSIST})`;
  const store = REMOTE ? createRemoteStore() : await createLocalStore();
  try {
    await seed(store, where);
  } finally {
    await store.dispose();
  }
}

async function seed(store: SeedStore, where: string): Promise<void> {
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
  const existing = await store.rows(`SELECT comp_id FROM comp WHERE name = ${q(compName)};`);
  let compId: number;
  if (existing.length > 0) {
    compId = Number(existing[0].comp_id);
    console.log(`  reusing comp_id ${compId} — wiping its tasks/pilots/tracks`);
    // Delete R2 objects for the comp's tracks first (need the keys from D1).
    const oldKeys = await store.rows(
      `SELECT tt.igc_filename AS k FROM task_track tt
       JOIN task t ON tt.task_id = t.task_id WHERE t.comp_id = ${compId};`,
    );
    await mapPool(oldKeys, R2_CONCURRENCY, (r) => store.r2Delete(String(r.k)));
    await store.exec([
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
    ]);
  } else {
    await store.exec(
      `INSERT INTO comp (name, creation_date, category, test, scoring_format, pilot_classes, default_pilot_class, timezone)
       VALUES (${q(compName)}, ${q(today)}, ${q(category)}, 0, ${q(scoringFormat)}, ${q(classesJson)}, ${q(defaultClass)}, ${q(tzOut.value ?? null)});`,
    );
    compId = Number((await store.rows(`SELECT comp_id FROM comp WHERE name = ${q(compName)};`))[0].comp_id);
    console.log(`  created comp_id ${compId}`);
  }

  // 2) comp_pilot rows (one per registration), then read back ids by our key.
  const registrations = [...registry.values()];
  await store.exec(
    registrations.map(
      (p) =>
        `INSERT INTO comp_pilot (comp_id, registered_pilot_name, ${idColumn}, pilot_class)
         VALUES (${compId}, ${q(p.name)}, ${q(p.id)}, ${q(p.pilotClass)});`,
    ),
  );
  const cpRows = await store.rows(
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
  const now = new Date().toISOString();
  let totalTracks = 0;
  const taskSummaries: string[] = [];
  for (const t of tasks) {
    const taskName = `${t.name} (${classLabel(t.pilotClass)})`;
    await store.exec(
      `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
       VALUES (${compId}, ${q(taskName)}, ${q(t.date)}, ${q(today)}, ${q(t.xctsk)});`,
    );
    const taskId = Number(
      (await store.rows(`SELECT task_id FROM task WHERE comp_id = ${compId} AND name = ${q(taskName)};`))[0]
        .task_id,
    );
    await store.exec(`INSERT INTO task_class (task_id, pilot_class) VALUES (${taskId}, ${q(t.pilotClass)});`);

    // Resolve every pilot that has a comp_pilot row into its R2 object + its two
    // D1 rows, then upload the objects concurrently and insert the rows in one
    // batch. (A pilot with a track took off and landed, so we mark them "Landed"
    // — the same status a real upload sets via applyStatusOnTrackUpload; the
    // direct insert bypasses that hook, so without it the roll call would show
    // every seeded pilot "Present". Pilots with no track keep the default.)
    const uploads: Array<{ key: string; gz: Buffer }> = [];
    const trackInserts: string[] = [];
    for (const p of t.pilots) {
      const compPilotId = cpByKey.get(pilotKey(t.pilotClass, p.id, p.name));
      if (compPilotId === undefined) continue;
      const key = `c/${compId}/t/${taskId}/${compPilotId}.igc`;
      uploads.push({ key, gz: p.gz });
      trackInserts.push(
        `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size, igc_pilot_name)
         VALUES (${taskId}, ${compPilotId}, ${q(key)}, ${q(now)}, ${p.fileSize}, ${q(p.name)});`,
      );
      trackInserts.push(
        `INSERT INTO task_pilot_status (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
         VALUES (${compId}, ${taskId}, ${compPilotId}, 'landed', NULL, NULL, 'Sample data', ${q(now)});`,
      );
    }
    await mapPool(uploads, R2_CONCURRENCY, (u) => store.r2Put(u.key, u.gz));
    await store.exec(trackInserts);
    totalTracks += uploads.length;
    taskSummaries.push(`${taskName} (task_id=${taskId}, ${uploads.length} tracks)`);
    console.log(`  seeded ${taskName}: task_id=${taskId}, ${uploads.length} tracks`);
  }

  console.log(`\nDone. comp_id=${compId} — ${tasks.length} tasks, ${totalTracks} tracks total`);
  for (const s of taskSummaries) console.log(`    ${s}`);
  console.log(`  Sample 3dvis: GET /api/comp/sample-3dvis`);
  console.log(`  View at:      /replay`);
  if (!REMOTE) console.log('  (local state — start dev servers with `bun run dev`)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
