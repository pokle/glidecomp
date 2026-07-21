#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Seed (or re-seed) the bundled sample competitions into D1 + R2, so every user
 * can view them and the /replay page can pull packed track data from the
 * competition-api Worker (GET /api/comp/sample-3dvis).
 *
 * Loads each comp in full — every task and pilot track — as a single comp. Each
 * task lives in its own source directory (e.g.
 * web/samples/comps/corryong-cup-2026-open-t{1,2,3}); a pilot who flew several
 * tasks gets one comp_pilot row (keyed by their federation id, see
 * `filename_id_field` below) with a task_track per task.
 *
 * Idempotent: each comp is identified by name (its manifest's `comp_name`, else
 * SAMPLE_COMP_NAME). On a rerun the existing comp's tasks / pilots / tracks (D1)
 * and IGC objects (R2) are wiped and rebuilt under the SAME comp_id, so if users
 * have messed with a loaded sample it gets fixed back up.
 *
 * Usage:
 *   bun run seed                      # every bundled comp → local dev state
 *   bun run seed big-chip kosci-loop  # just these comps
 *   bun run seed --history            # include history-flagged comps too
 *   bun run seed --remote             # production D1 + R2 (needs wrangler auth)
 *
 * A manifest with `history: true` (a back-catalogue comp, see
 * docs/2026-07-21-airscore-history-import-plan.md) is skipped by the default
 * "seed everything" run — seed it by naming its slug or passing --history.
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

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  andoyerDistance,
  calculateBearingRadians,
  calculateOptimizedTaskLine,
  destinationPoint,
  parseIGC,
  parseXCTask,
  xctaskTurnpointsToRecords,
  type GAPParameters,
  type WaypointFileRecord,
} from '@glidecomp/engine';
import { timezoneForXctsk } from '@glidecomp/engine/timezone';
import { SAMPLE_COMP_NAME } from '../workers/competition-api/src/sample';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Comp-folder root — override with GLIDECOMP_COMPS_DIR to seed from a
 * checkout of pokle/glidecomp-archive (the history back-catalogue). */
const COMPS_ROOT = process.env.GLIDECOMP_COMPS_DIR
  ? resolve(process.env.GLIDECOMP_COMPS_DIR)
  : join(REPO_ROOT, 'web/samples/comps');
// Which bundled comps to seed (each slug matches a folder under COMPS_ROOT
// holding a comp.json manifest). With no slug given we seed every bundled comp;
// flags and slugs can appear in any arg order.
const ARG_SLUGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
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

/**
 * A pilot in the task's PUBLISHED AirScore results who has no IGC in the
 * download (a handful per comp). Without them the seeded field is smaller
 * than the field AirScore scored, so launch/distance validity — and with it
 * every pilot's points — drifts from the published numbers. They seed as
 * what they are: a DNF status, or a manual flight (S7F §8.4) landed at the
 * published distance along the optimised route plus a "landed" status.
 */
interface TrackLessPilot {
  name: string;
  kind: 'dnf' | 'flew';
  /** Published distance in metres, or null when unknown (a bare 'lo' row —
   * scored at minimum distance, so the landing synthesizes at the start). */
  distance: number | null;
}

/** '<a …>Todd Wisewould</a>' → "wisewould" — the IGC-filename surname key. */
function surnameKeyFromPublishedName(html: string): string {
  const full = String(html).replace(/<[^>]+>/g, '').trim();
  const words = full.split(/\s+/);
  return (words.length > 1 ? words.slice(1) : words).join('_').toLowerCase();
}

/**
 * Published result rows with no matching IGC in the task folder. Matching is
 * by the same surname key the IGC filenames use, consuming one file per row
 * so duplicate surnames pair off correctly.
 */
function readTrackLessRows(compDir: string, igcFiles: string[]): TrackLessPilot[] {
  const rawPath = join(compDir, 'airscore-result-raw.json');
  if (!existsSync(rawPath)) return [];
  const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
  const available = new Map<string, number>();
  for (const f of igcFiles) {
    const key = basename(f, '.igc').replace(/_\d+_\d{6}$/, '').toLowerCase();
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  const out: TrackLessPilot[] = [];
  for (const row of raw.data ?? []) {
    const name = String(row[2]).replace(/<[^>]+>/g, '').trim();
    if (!name) continue;
    const key = surnameKeyFromPublishedName(row[2]);
    const n = available.get(key) ?? 0;
    if (n > 0) {
      available.set(key, n - 1);
      continue;
    }
    const dist = row[10];
    if (dist === 'abs') continue; // absent — not part of the scored field
    if (dist === 'dnf') {
      out.push({ name, kind: 'dnf', distance: null });
    } else if (typeof dist === 'number' && Number.isFinite(dist)) {
      out.push({ name, kind: 'flew', distance: dist * 1000 });
    } else {
      out.push({ name, kind: 'flew', distance: null }); // 'lo' etc. — min distance
    }
  }
  return out;
}

/**
 * A landing point at `targetMeters` along the task's optimised route, plus
 * the index of the last turnpoint passed getting there — the two facts a
 * manual flight stores. The engine's made-good for a point ON the optimised
 * line at cumulative distance d is d itself, so the synthesized flight
 * scores the published distance.
 */
function landingAtRouteDistance(
  xctsk: string,
  targetMeters: number,
): { lastReachedIndex: number; lat: number; lon: number } {
  const line = calculateOptimizedTaskLine(parseXCTask(xctsk));
  if (line.length === 0) throw new Error('task has no turnpoints');
  let remaining = Math.max(0, targetMeters);
  let index = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const leg = andoyerDistance(line[i].lat, line[i].lon, line[i + 1].lat, line[i + 1].lon);
    if (remaining <= leg || i + 2 === line.length) {
      // Land on this leg — capped 100 m short of its end so a published
      // distance at/near full course stays a land-out, never a goal.
      const along = Math.min(remaining, Math.max(0, leg - 100));
      const bearing = calculateBearingRadians(line[i].lat, line[i].lon, line[i + 1].lat, line[i + 1].lon);
      const p = destinationPoint(line[i].lat, line[i].lon, along, bearing);
      return { lastReachedIndex: index, lat: p.lat, lon: p.lon };
    }
    remaining -= leg;
    index = i + 1;
  }
  return { lastReachedIndex: 0, lat: line[0].lat, lon: line[0].lon };
}

interface TaskSpec {
  dir: string;
  name: string;
  date: string;
  pilotClass: string;
  /** Per-task GAP overrides from the manifest (AirScore formula capture). */
  gapParams?: Partial<GAPParameters>;
}

interface SampleTask extends TaskSpec {
  xctsk: string;
  pilots: SamplePilot[];
  /** Published-result pilots with no IGC in the folder (see TrackLessPilot). */
  trackless: TrackLessPilot[];
}

interface CompManifest {
  name: string;
  slug: string;
  classes: string[];
  tasks: Array<{
    pilot_class: string;
    name: string;
    date: string;
    dir: string;
    /** Mapped GAP overrides where this task's published AirScore formula
     * differs from the comp-wide gap_params (see download-airscore-comp.ts). */
    gap_params?: Partial<GAPParameters>;
  }>;
  /**
   * Comp-wide GAP parameters mapped from the AirScore-published formula the
   * comp was actually scored with (shared across its tasks; per-task
   * differences ride on each task entry). Absent for the synthetic comps —
   * they score under the per-category defaults.
   */
  gap_params?: Partial<GAPParameters>;
  /**
   * Optional overrides. The Corryong sample omits these and inherits the
   * historical defaults (the fixed SAMPLE_COMP_NAME, 'hg', GAP scoring). The
   * synthetic Big Chip comp sets them to seed a second, open-distance comp.
   */
  comp_name?: string;
  category?: string;
  scoring_format?: 'gap' | 'open_distance';
  /**
   * Hide the comp from the public: it seeds with the D1 `test` flag set, so it
   * 404s for anonymous visitors and is left out of the public comp list, while
   * admins still see it. Use for the fabricated comps (Big Chip, Kosciuszko
   * Loop) — they're generated fixtures, not real events, so they shouldn't show
   * up as competitions the public can browse. Defaults to false (public).
   */
  hidden?: boolean;
  /** Back-catalogue comp: excluded from the default "seed everything" run
   * (seed it by slug or with --history). */
  history?: boolean;
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
  const nonEmptyIgc: string[] = [];
  for (const file of igcFiles) {
    const text = readFileSync(join(compDir, file), 'utf-8');
    const igc = parseIGC(text);
    if (igc.fixes.length === 0) continue;
    nonEmptyIgc.push(file);
    const name = (igc.header.pilot || basename(file, '.igc')).replace(/\s+/g, ' ').trim();
    const gz = gzipSync(Buffer.from(text, 'utf-8'), { level: 9 });
    pilots.push({ name, id: idFromFilename(file), gz, fileSize: gz.byteLength });
  }

  // Published pilots with no (non-empty) IGC — they seed as DNF statuses or
  // manual flights so validity matches the field AirScore actually scored.
  const trackless = readTrackLessRows(compDir, nonEmptyIgc);

  return { ...spec, xctsk, pilots, trackless };
}

// --- seed ------------------------------------------------------------------

/**
 * Registry key for a pilot within a class: CIVL id when known (the primary
 * match key), else the display name, scoped by pilot class. A pilot who flew in
 * two classes (e.g. floater one day, open the next) gets one comp_pilot row per
 * class; within a class, all their tasks share a single row.
 *
 * The `|` separator only has to be absent from `pilotClass`: the second field is
 * last and self-describing (`id:` / `name:`), so nothing a pilot name contains
 * can shift the parse. Classes come from the checked-in comp.json manifests
 * ("open" / "floater"), so `|` can't collide. This key is in-memory only — the
 * DB stores name / id / class as separate columns — so the separator is free to
 * change. (It used to be a literal NUL, which made the whole file read as binary
 * to grep/rg and git's word-diff; don't reintroduce one.)
 */
function pilotKey(pilotClass: string, id: string | null, name: string): string {
  return `${pilotClass}|${id ? `id:${id}` : `name:${name}`}`;
}

/** "open" → "Open", so task names read "Task 1 (Open)". */
function classLabel(pilotClass: string): string {
  return pilotClass.charAt(0).toUpperCase() + pilotClass.slice(1);
}

/**
 * Build the comp's waypoint database as the union of every task's turnpoints.
 * A comp waypoint set is a database of named points that tasks pick from, so
 * we key by the waypoint `code` and keep the first occurrence — the same
 * point (e.g. a shared take-off cylinder) recurring across tasks collapses to
 * one row rather than appearing once per task.
 */
function unionTaskWaypoints(tasks: SampleTask[]): WaypointFileRecord[] {
  const byCode = new Map<string, WaypointFileRecord>();
  for (const t of tasks) {
    const records = xctaskTurnpointsToRecords(parseXCTask(t.xctsk).turnpoints);
    for (const r of records) {
      if (!byCode.has(r.code)) byCode.set(r.code, r);
    }
  }
  return [...byCode.values()];
}

function loadManifest(slug: string): CompManifest {
  const path = join(COMPS_ROOT, slug, 'comp.json');
  if (!existsSync(path)) {
    throw new Error(`No comp manifest at ${path} — is "${slug}" a bundled comp?`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as CompManifest;
}

/**
 * Every bundled comp, i.e. each folder under COMPS_ROOT holding a comp.json.
 * The per-task folders (`<slug>-<class>-t<N>`) have no manifest, so they're
 * skipped, as are history-flagged manifests unless --history is passed.
 * Sorted so a full seed runs in a stable order.
 */
function allSlugs(): string[] {
  const withHistory = process.argv.includes('--history');
  return readdirSync(COMPS_ROOT)
    .filter((name) => existsSync(join(COMPS_ROOT, name, 'comp.json')))
    .filter((name) => withHistory || !loadManifest(name).history)
    .sort();
}

async function main(): Promise<void> {
  const slugs = ARG_SLUGS.length > 0 ? ARG_SLUGS : allSlugs();
  const where = REMOTE ? 'REMOTE (production)' : `local (${PERSIST})`;
  // One store (and for local, one Miniflare boot) shared across every comp.
  const store = REMOTE ? createRemoteStore() : await createLocalStore();
  try {
    console.log(`Seeding ${slugs.length} competition(s): ${slugs.join(', ')}\n`);
    for (const slug of slugs) {
      await seed(store, where, slug);
      console.log('');
    }
    console.log(`Seeded ${slugs.length} competition(s) into ${where}.`);
    if (!REMOTE) console.log('  (local state — start dev servers with `bun run dev`)');
  } finally {
    await store.dispose();
  }
}

async function seed(store: SeedStore, where: string, slug: string): Promise<void> {
  const manifest = loadManifest(slug);
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
  // The D1 `test` flag doubles as "hidden from the public".
  const testFlag = manifest.hidden ? 1 : 0;
  console.log(`Seeding "${compName}" (${slug}) into ${where}…`);
  console.log(`  classes: ${manifest.classes.join(', ')}`);
  console.log(`  category: ${category}, scoring: ${scoringFormat}, filename id: ${idField}`);
  console.log(`  visibility: ${manifest.hidden ? 'hidden (test=1, admins only)' : 'public'}`);

  // Comp-wide GAP parameters from the manifest's AirScore formula capture
  // (null for the synthetic comps → the per-category defaults apply).
  const compGapParamsJson = manifest.gap_params ? JSON.stringify(manifest.gap_params) : null;
  console.log(
    `  gap_params: ${compGapParamsJson ? 'from AirScore formula capture' : 'none (category defaults)'}`,
  );

  // Read every task, sharing one resolved timezone across the comp.
  const tzOut: { value?: string } = {};
  const tasks = manifest.tasks.map((t) =>
    readTask(
      { dir: t.dir, name: t.name, date: t.date, pilotClass: t.pilot_class, gapParams: t.gap_params },
      tzOut,
    ),
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
    // Track-less published pilots register too (keyed by name — the published
    // rows carry no federation id).
    for (const p of t.trackless) {
      const key = pilotKey(t.pilotClass, null, p.name);
      if (!registry.has(key)) {
        registry.set(key, { name: p.name, id: null, pilotClass: t.pilotClass });
      }
    }
  }
  const perClass = manifest.classes
    .map((c) => `${c}: ${[...registry.values()].filter((p) => p.pilotClass === c).length}`)
    .join(', ');
  console.log(`  ${registry.size} pilot registrations (${perClass})`);

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const classesJson = JSON.stringify(manifest.classes);
  const defaultClass = manifest.classes[0];
  // Seeded fixtures are finished events: close them on their last task's
  // date so the app treats them as historical (no new track submissions).
  // Account linking still reaches closed comps — see pilot-linker.ts.
  const closeDate = manifest.tasks.map((t) => t.date).sort().at(-1)!;
  console.log(`  close date: ${closeDate}`);

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
      `DELETE FROM task_manual_flight WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
      `DELETE FROM task_pilot_status WHERE comp_id = ${compId};`,
      `DELETE FROM task_class WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
      `DELETE FROM task WHERE comp_id = ${compId};`,
      `DELETE FROM comp_pilot WHERE comp_id = ${compId};`,
      `DELETE FROM comp_waypoints WHERE comp_id = ${compId};`,
      `DELETE FROM audit_log WHERE comp_id = ${compId};`,
      `UPDATE comp SET category=${q(category)}, test=${testFlag}, scoring_format=${q(scoringFormat)},
         pilot_classes=${q(classesJson)},
         default_pilot_class=${q(defaultClass)},
         close_date=${q(closeDate)},
         gap_params=${q(compGapParamsJson)},
         timezone=${q(tzOut.value ?? null)} WHERE comp_id = ${compId};`,
    ]);
  } else {
    await store.exec(
      `INSERT INTO comp (name, creation_date, category, test, scoring_format, pilot_classes, default_pilot_class, close_date, gap_params, timezone)
       VALUES (${q(compName)}, ${q(today)}, ${q(category)}, ${testFlag}, ${q(scoringFormat)}, ${q(classesJson)}, ${q(defaultClass)}, ${q(closeDate)}, ${q(compGapParamsJson)}, ${q(tzOut.value ?? null)});`,
    );
    compId = Number((await store.rows(`SELECT comp_id FROM comp WHERE name = ${q(compName)};`))[0].comp_id);
    console.log(`  created comp_id ${compId}`);
  }

  // 1b) Comp waypoint database — the union of every task's turnpoints, so the
  //     route editor can pick from the points the tasks already use. Not a
  //     scoring input (tasks froze their own turnpoints), so no score bump.
  //     The reseed wipe above cleared any stale row; upsert covers new comps.
  const waypoints = unionTaskWaypoints(tasks);
  await store.exec(
    `INSERT INTO comp_waypoints (comp_id, waypoints, updated_at)
     VALUES (${compId}, ${q(JSON.stringify(waypoints))}, ${q(now)})
     ON CONFLICT(comp_id) DO UPDATE SET waypoints = excluded.waypoints, updated_at = excluded.updated_at;`,
  );
  console.log(`  seeded ${waypoints.length} competition waypoints (union of task turnpoints)`);

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
  let totalTracks = 0;
  for (const t of tasks) {
    const taskName = `${t.name} (${classLabel(t.pilotClass)})`;
    await store.exec(
      `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk, gap_params)
       VALUES (${compId}, ${q(taskName)}, ${q(t.date)}, ${q(today)}, ${q(t.xctsk)},
               ${q(t.gapParams ? JSON.stringify(t.gapParams) : null)});`,
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
    // Track-less published pilots (see TrackLessPilot): DNF rows become a
    // DNF status (launch validity, S7F §9.1); flown rows become a manual
    // flight landed at the published distance along the optimised route
    // (+ a landed status), so the seeded field — and with it every pilot's
    // validity-scaled points — matches the field AirScore scored.
    for (const p of t.trackless) {
      const compPilotId = cpByKey.get(pilotKey(t.pilotClass, null, p.name));
      if (compPilotId === undefined) continue;
      if (p.kind === 'dnf') {
        trackInserts.push(
          `INSERT INTO task_pilot_status (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
           VALUES (${compId}, ${taskId}, ${compPilotId}, 'dnf', 'Published AirScore result (no tracklog in download)', NULL, 'AirScore import', ${q(now)});`,
        );
        continue;
      }
      const landing = landingAtRouteDistance(t.xctsk, p.distance ?? 0);
      trackInserts.push(
        `INSERT INTO task_manual_flight (task_id, comp_pilot_id, last_reached_tp_index, landing_lat, landing_lon, made_goal, duration_seconds, computed_distance, active, set_by_user_id, set_by_name, set_at)
         VALUES (${taskId}, ${compPilotId}, ${landing.lastReachedIndex}, ${landing.lat}, ${landing.lon}, 0, NULL, ${p.distance ?? 0}, 1, NULL, 'AirScore import', ${q(now)});`,
      );
      trackInserts.push(
        `INSERT INTO task_pilot_status (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
         VALUES (${compId}, ${taskId}, ${compPilotId}, 'landed', 'Published AirScore result (no tracklog in download)', NULL, 'AirScore import', ${q(now)});`,
      );
    }

    await mapPool(uploads, R2_CONCURRENCY, (u) => store.r2Put(u.key, u.gz));
    await store.exec(trackInserts);
    totalTracks += uploads.length;
    const extras = t.trackless.length > 0 ? `, ${t.trackless.length} track-less published pilot(s)` : '';
    console.log(`  seeded ${taskName}: task_id=${taskId}, ${uploads.length} tracks${extras}`);
  }

  console.log(`  Done. comp_id=${compId} — ${tasks.length} tasks, ${totalTracks} tracks total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
