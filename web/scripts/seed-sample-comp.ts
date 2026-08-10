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
 * and IGC objects (R2) are rebuilt, so if users have messed with a loaded sample
 * it gets fixed back up.
 *
 * **Every id that appears in a URL survives a re-seed.** `/comp/:comp/task/:task
 * /pilot/:pilot` is a shareable, indexable link, so a rebuild that deleted and
 * reinserted those rows handed out fresh auto-increment ids and 404'd every link
 * anyone had saved. The comp row was always matched by name and reused; tasks
 * and pilots now match the same way one level down (see lib/seed-identity.ts):
 * a task by its seeded name within the comp, a pilot registration by the same
 * (class, id-or-name) key that already collapses a pilot's tasks onto one
 * comp_pilot row. Matched rows are UPDATEd in place; only what the source no
 * longer describes is deleted. As a bonus, a pilot who linked their account to
 * a seeded registration keeps that link, and the task's cached weather (keyed by
 * route + date, not by revision) survives instead of being re-fetched.
 *
 * Usage:
 *   bun run seed                      # every bundled comp → local dev state
 *   bun run seed big-chip kosci-loop  # just these comps
 *   bun run seed ../glidecomp-archive/comps/forbes-flatlands-2026
 *                                     # a comp named by path (e.g. from the
 *                                     # archive checkout) — equivalent to
 *                                     # GLIDECOMP_COMPS_DIR=… + its slug
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
import { createHash } from 'node:crypto';
import {
  ellipsoidDistance,
  calculateBearingRadians,
  calculateOptimizedTaskLine,
  destinationPoint,
  parseIGC,
  parseXCTask,
  assessTrackQuality,
  xctaskTurnpointsToRecords,
  type GAPParameters,
  type WaypointFileRecord,
} from '@glidecomp/engine';
import { timezoneForXctsk } from '@glidecomp/engine/timezone';
import { SAMPLE_COMP_NAME } from '../workers/competition-api/src/sample';
import { encodeId } from '../workers/competition-api/src/sqids';
import { revalidateFieldAnalysis } from '../workers/competition-api/src/field-analysis-store';
import {
  compPath,
  compScoresPath,
  compWaypointsPath,
  pilotPath,
  taskPath,
} from '../frontend/src/react/lib/slug';
import {
  buildTrackedNameIndex,
  matchExisting,
  pilotKey,
  taskSeedName,
  trackLessPilotKey,
} from './lib/seed-identity';
import {
  airscoreCompUrl,
  airscoreTaskUrl,
  parseCuratedOfficialRows,
  parseRawOfficialRows,
  type OfficialResultRow,
} from './lib/official-results';
import {
  orphanedTrackKeys,
  trackSyncDecision,
  type OldTrackInfo,
} from './lib/seed-track-sync';
import {
  REPO_ROOT,
  isTransientWranglerError,
  parseWranglerJson,
  q,
  tomlValue as readTomlValue,
  wrangler,
  wranglerAsync,
} from './lib/wrangler-d1';

/** Comp-folder root — override with GLIDECOMP_COMPS_DIR to seed from a
 * checkout of pokle/glidecomp-archive (the history back-catalogue). */
const COMPS_ROOT = process.env.GLIDECOMP_COMPS_DIR
  ? resolve(process.env.GLIDECOMP_COMPS_DIR)
  : join(REPO_ROOT, 'web/samples/comps');

/** A comp to seed: the directory its folders live under + its slug. */
interface CompRef {
  root: string;
  slug: string;
}

/**
 * Resolve one CLI argument to the comp it names. A bare slug ("big-chip")
 * is looked up under COMPS_ROOT; anything path-like — containing a slash,
 * or an existing directory holding a comp.json — is taken as a direct path
 * to a comp's meta folder (e.g. `../glidecomp-archive/comps/forbes-
 * flatlands-2026/`), whose PARENT becomes the comps root so the task
 * folders resolve as its siblings.
 */
function resolveCompArg(arg: string): CompRef {
  const looksLikePath = arg.includes('/') || arg.startsWith('.');
  const asPath = resolve(arg.replace(/\/+$/, ''));
  if (looksLikePath || existsSync(join(asPath, 'comp.json'))) {
    if (!existsSync(join(asPath, 'comp.json'))) {
      throw new Error(`No comp manifest at ${join(asPath, 'comp.json')}`);
    }
    return { root: resolve(asPath, '..'), slug: basename(asPath) };
  }
  return { root: COMPS_ROOT, slug: arg };
}

// Which bundled comps to seed. Each argument is a slug under COMPS_ROOT or a
// path to a comp folder; with no argument we seed every bundled comp. Flags
// and comp arguments can appear in any order.
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

// Bindings are read out of the worker's own wrangler.toml rather than
// hardcoded: Miniflare keys the local D1 sqlite file by the *database_id*, so
// the in-process store must use the very same id wrangler/`bun run dev` use or
// it silently writes to a different file than the app reads.
const tomlValue = (header: string, key: string) =>
  readTomlValue(WRANGLER_CONFIG_PATH, header, key);
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
  /**
   * Compute and store each task's field analysis, one task at a time — local
   * backend only. Seeding leaves the field-analysis store cold, and the first
   * read then schedules a whole-field compute (every pilot's raw fixes at
   * once) inside `wrangler dev`'s workerd — which, on a CPU-starved machine
   * (CI runners), pegs the process long enough for wrangler's internal
   * loopback to drop a connection, and wrangler treats that as fatal (issue
   * #477's crash, reproduced under a CPU-constrained container). Doing the
   * same compute HERE — in this bun process, against the same on-disk state,
   * with no wrangler involved — means seeded comps always serve warm and the
   * dev stack never runs the cold burst. The remote backend omits it: prod
   * workerd doesn't share the fragility, and the compute would pull every
   * track down from real R2.
   */
  warmFieldAnalysis?(taskIds: number[]): Promise<void>;
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
    async warmFieldAnalysis(taskIds) {
      // Same alphabet note as PURGE_SQIDS_ALPHABET below: the report body
      // embeds sqid-encoded ids, so this must match what the dev workers
      // serve under (the competition-api wrangler.toml default).
      const env = {
        DB: db,
        R2: bucket,
        SQIDS_ALPHABET: process.env.SQIDS_ALPHABET ?? 'abcdefghijklmnopqrstuvwxyz',
      };
      for (const taskId of taskIds) {
        const started = Date.now();
        // Best-effort: a task the analysis refuses (open distance, no tracks)
        // stores its refusal, which is exactly what the endpoint would do.
        await revalidateFieldAnalysis(env, taskId).catch((err) => {
          console.warn(`  field analysis warm failed for task ${taskId}:`, err);
        });
        console.log(`  warmed field analysis: task_id=${taskId} (${Date.now() - started}ms)`);
      }
    },
    async dispose() {
      await mf.dispose();
    },
  };
}

// -- remote backend: wrangler CLI against real Cloudflare D1 + R2 -------------


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
  /** SHA-256 (hex) of the RAW IGC text (migration 0032) — the content
   * identity a re-seed compares to skip uploading an unchanged track. Raw
   * text, not the gzip: compressed bytes vary across zlib versions. */
  sha256: string;
  /** True when a HARD data-quality check withholds this track from scoring
   * (engine track-quality.ts). The track is still seeded — it is a real
   * archive file and the regression fixture — but the pilot must not be
   * stamped "Landed" on the strength of it. */
  qualityHardFailed: boolean;
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
  // Collapse rows that resolve to the same comp_pilot. Track-less pilots are
  // keyed by name (they have no distinguishing id), and the registry merges
  // same-name rows into ONE comp_pilot — so the synthesis has to as well, or a
  // repeated published name (AirScore lists the odd competitor twice, e.g. two
  // "James McGinty" land-out rows in Corryong 2017 open T1) would emit two
  // manual flights / statuses for one comp_pilot and trip its UNIQUE(task_id,
  // comp_pilot_id) index. Keep the best outcome: a flight beats a DNF, and the
  // longer distance wins (a real number beats a bare 'lo'/null minimum).
  const better = (a: TrackLessPilot, b: TrackLessPilot): TrackLessPilot => {
    if (a.kind !== b.kind) return a.kind === 'flew' ? a : b;
    if (a.kind === 'dnf') return a;
    return (b.distance ?? -1) > (a.distance ?? -1) ? b : a;
  };
  const merged = new Map<string, TrackLessPilot>();
  for (const p of out) {
    const key = p.name.toLowerCase();
    const prev = merged.get(key);
    merged.set(key, prev ? better(prev, p) : p);
  }
  return [...merged.values()];
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
    const leg = ellipsoidDistance(line[i].lat, line[i].lon, line[i + 1].lat, line[i + 1].lon);
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
  /** AirScore keys for this task's published record (absent for synthetic
   * comps) — with the manifest's source_host they build the official comp
   * and task scores page URLs. */
  comPk?: number;
  tasPk?: number;
}

interface SampleTask extends TaskSpec {
  xctsk: string;
  pilots: SamplePilot[];
  /** Published-result pilots with no IGC in the folder (see TrackLessPilot). */
  trackless: TrackLessPilot[];
  /** The officially published per-pilot results (issue #603) — rank and
   * total exactly as AirScore published them, stored beside the task as a
   * display-only annotation. Empty for the synthetic comps. */
  official: OfficialResultRow[];
}

interface CompManifest {
  name: string;
  slug: string;
  classes: string[];
  /** The AirScore host the comp was downloaded from (absent for synthetic
   * comps) — the base for the official scores page links. */
  source_host?: string;
  tasks: Array<{
    pilot_class: string;
    name: string;
    date: string;
    dir: string;
    /** AirScore comp/task keys (absent for synthetic comps). */
    comPk?: number;
    tasPk?: number;
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
 *
 * Returns null for a task that was SET but never flown — a route on disk with
 * no tracklog beside it, which the source published with zero results and zero
 * day quality (Dalby Big Air 2022 T6, both classes: the last day was called
 * off). There is nothing to seed for such a day, so the caller drops it and
 * says so rather than aborting the whole comp.
 */
function readTask(
  spec: TaskSpec,
  tzOut: { value?: string },
  root: string,
  category: string,
): SampleTask | null {
  const compDir = join(root, spec.dir);
  const entries = readdirSync(compDir);
  const igcFiles = entries.filter((f) => f.toLowerCase().endsWith('.igc')).sort();
  if (igcFiles.length === 0) return null;

  const taskFile = entries.find((f) => f.toLowerCase().endsWith('.xctsk'));
  if (!taskFile) throw new Error(`No .xctsk task file in ${compDir}`);
  const xctsk = readFileSync(join(compDir, taskFile), 'utf-8');
  if (tzOut.value === undefined) {
    tzOut.value = timezoneForXctsk(xctsk);
  }

  // Assess every track against the task it is being seeded into, the same way
  // the upload route and the read path do. Deliberately does NOT skip the
  // file: a hard-failed track (Corryong Cup 2025 task 4 has one — a New
  // Zealand flight from ten days later) is the regression fixture, and
  // dropping it here would hide the very case this exists to catch.
  const qualityContext = {
    task: parseXCTask(xctsk),
    taskDate: spec.date,
    timeZone: tzOut.value ?? undefined,
    category: category === 'pg' ? ('pg' as const) : ('hg' as const),
  };

  const pilots: SamplePilot[] = [];
  const nonEmptyIgc: string[] = [];
  for (const file of igcFiles) {
    const text = readFileSync(join(compDir, file), 'utf-8');
    const igc = parseIGC(text);
    if (igc.fixes.length === 0) continue;
    nonEmptyIgc.push(file);
    const name = (igc.header.pilot || basename(file, '.igc')).replace(/\s+/g, ' ').trim();
    const gz = gzipSync(Buffer.from(text, 'utf-8'), { level: 9 });
    const quality = assessTrackQuality(igc.fixes, igc.header, qualityContext);
    if (quality.hardFailed) {
      const why = quality.findings
        .filter((f) => f.severity === 'hard')
        .map((f) => f.title)
        .join('; ');
      console.warn(`  ! ${file}: withheld from scoring — ${why}`);
    }
    pilots.push({
      name,
      id: idFromFilename(file),
      gz,
      fileSize: gz.byteLength,
      sha256: createHash('sha256').update(text).digest('hex'),
      qualityHardFailed: quality.hardFailed,
    });
  }

  // Published pilots with no (non-empty) IGC — they seed as DNF statuses or
  // manual flights so validity matches the field AirScore actually scored.
  const trackless = readTrackLessRows(compDir, nonEmptyIgc);

  return { ...spec, xctsk, pilots, trackless, official: readOfficialRows(compDir) };
}

/**
 * The officially published per-pilot results for a task folder (issue #603):
 * the verbatim raw result when the downloader kept it, else a `.curated`
 * fixture's trimmed copy (ranks re-derived from its totals). Empty for the
 * synthetic comps, which have no published record.
 */
function readOfficialRows(compDir: string): OfficialResultRow[] {
  const rawPath = join(compDir, 'airscore-result-raw.json');
  if (existsSync(rawPath)) {
    return parseRawOfficialRows(JSON.parse(readFileSync(rawPath, 'utf-8')));
  }
  const trimmedPath = join(compDir, 'airscore-result.json');
  if (existsSync(trimmedPath)) {
    return parseCuratedOfficialRows(JSON.parse(readFileSync(trimmedPath, 'utf-8')));
  }
  return [];
}

// --- seed ------------------------------------------------------------------

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

function loadManifest(ref: CompRef): CompManifest {
  const path = join(ref.root, ref.slug, 'comp.json');
  if (!existsSync(path)) {
    throw new Error(`No comp manifest at ${path} — is "${ref.slug}" a bundled comp?`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as CompManifest;
}

/**
 * Every bundled comp, i.e. each folder under COMPS_ROOT holding a comp.json.
 * The per-task folders (`<slug>-<class>-t<N>`) have no manifest, so they're
 * skipped, as are history-flagged manifests unless --history is passed.
 * Sorted so a full seed runs in a stable order.
 */
function allSlugs(): CompRef[] {
  const withHistory = process.argv.includes('--history');
  return readdirSync(COMPS_ROOT)
    .filter((name) => existsSync(join(COMPS_ROOT, name, 'comp.json')))
    .map((name) => ({ root: COMPS_ROOT, slug: name }))
    .filter((ref) => withHistory || !loadManifest(ref).history)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

async function main(): Promise<void> {
  const refs = ARG_SLUGS.length > 0 ? ARG_SLUGS.map(resolveCompArg) : allSlugs();
  const where = REMOTE ? 'REMOTE (production)' : `local (${PERSIST})`;
  // One store (and for local, one Miniflare boot) shared across every comp.
  const store = REMOTE ? createRemoteStore() : await createLocalStore();
  try {
    console.log(`Seeding ${refs.length} competition(s): ${refs.map((r) => r.slug).join(', ')}\n`);
    for (const ref of refs) {
      await seed(store, where, ref);
      console.log('');
    }
    console.log(`Seeded ${refs.length} competition(s) into ${where}.`);
    if (!REMOTE) console.log('  (local state — start dev servers with `bun run dev`)');
  } finally {
    await store.dispose();
  }
}

async function seed(store: SeedStore, where: string, ref: CompRef): Promise<void> {
  const { slug } = ref;
  const manifest = loadManifest(ref);
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

  // Read every task, sharing one resolved timezone across the comp. A task the
  // source describes but has no tracklog for was never flown — it is named
  // here and left out of the seed (see readTask).
  const tzOut: { value?: string } = {};
  const tasks: SampleTask[] = [];
  for (const t of manifest.tasks) {
    const task = readTask(
      {
        dir: t.dir,
        name: t.name,
        date: t.date,
        pilotClass: t.pilot_class,
        gapParams: t.gap_params,
        comPk: t.comPk,
        tasPk: t.tasPk,
      },
      tzOut,
      ref.root,
      manifest.category ?? 'hg',
    );
    if (task) tasks.push(task);
    else console.log(`  ${t.pilot_class}/${t.name} (${t.date}): no tracklogs — not flown, skipped`);
  }
  for (const t of tasks) {
    console.log(`  ${t.pilotClass}/${t.name} (${t.date}): ${t.pilots.length} pilots`);
  }
  console.log(`  timezone ${tzOut.value ?? 'unresolved'}`);

  // One comp_pilot row per (class, pilot). First-seen name/id wins within a key.
  //
  // Two passes, because the two sources identify a pilot differently: an IGC
  // filename carries their federation id, a published result row carries only a
  // name. Every tracked pilot registers FIRST, so a track-less row can then join
  // the row its own tracked days already have (buildTrackedNameIndex) instead of
  // minting a second one for the same person. See seed-identity.ts.
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
  const trackedByName = buildTrackedNameIndex(registry.values());
  /** The comp_pilot a track-less published row belongs to (see seed-identity). */
  const trackLessKey = (pilotClass: string, name: string) =>
    trackLessPilotKey(pilotClass, name, trackedByName);
  let merged = 0;
  for (const t of tasks) {
    for (const p of t.trackless) {
      const key = trackLessKey(t.pilotClass, p.name);
      if (registry.has(key)) {
        if (key !== pilotKey(t.pilotClass, null, p.name)) merged++;
        continue;
      }
      registry.set(key, { name: p.name, id: null, pilotClass: t.pilotClass });
    }
  }
  const perClass = manifest.classes
    .map((c) => `${c}: ${[...registry.values()].filter((p) => p.pilotClass === c).length}`)
    .join(', ');
  console.log(`  ${registry.size} pilot registrations (${perClass})`);
  if (merged > 0) {
    console.log(
      `  ${merged} track-less published row(s) joined a pilot's own registration ` +
        `(no tracklog that day — they are not a second pilot)`,
    );
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const classesJson = JSON.stringify(manifest.classes);
  const defaultClass = manifest.classes[0];
  // Seeded fixtures are finished events: close them on their last task's
  // date so the app treats them as historical (no new track submissions).
  // Account linking still reaches closed comps — see pilot-linker.ts.
  const closeDate = manifest.tasks.map((t) => t.date).sort().at(-1)!;
  console.log(`  close date: ${closeDate}`);

  const registrations = [...registry.values()];

  // What the previous seed left in R2, keyed by object key, so the task loop
  // can skip re-uploading a track whose content is unchanged (migration 0032,
  // lib/seed-track-sync.ts). Populated on the re-seed path; empty for a new
  // comp, where everything uploads.
  const oldTracks = new Map<string, OldTrackInfo>();
  // Every R2 key this seed claims (uploaded or kept); what the previous seed
  // holds beyond these is orphaned and deleted at the end.
  const liveKeys = new Set<string>();

  // 1) Find or create the comp (stable comp_id across reruns).
  const existing = await store.rows(`SELECT comp_id FROM comp WHERE name = ${q(compName)};`);
  let compId: number;
  /** Seeded task name → the existing task_id to rebuild in place. Empty for a
   *  comp we're creating, so every task below takes the INSERT path. */
  let reusedTaskIds = new Map<string, number>();
  if (existing.length > 0) {
    compId = Number(existing[0].comp_id);

    // Match what we're about to seed against what is already stored, so every
    // id that appears in a URL survives the rebuild (see the header comment and
    // lib/seed-identity.ts). Tasks match on their seeded name, pilots on the
    // same (class, id-or-name) registry key built above; whatever the source no
    // longer describes is an orphan and is deleted below.
    const existingTaskRows = await store.rows(
      `SELECT task_id, name FROM task WHERE comp_id = ${compId};`,
    );
    const taskMatch = matchExisting(
      tasks.map((t) => taskSeedName(t.name, t.pilotClass)),
      existingTaskRows.map((r) => ({ id: Number(r.task_id), key: String(r.name) })),
    );
    reusedTaskIds = taskMatch.reused;

    const existingPilotRows = await store.rows(
      `SELECT comp_pilot_id, registered_pilot_name, ${idColumn} AS id, pilot_class
         FROM comp_pilot WHERE comp_id = ${compId};`,
    );
    const pilotMatch = matchExisting(
      registrations.map((p) => pilotKey(p.pilotClass, p.id, p.name)),
      existingPilotRows.map((r) => ({
        id: Number(r.comp_pilot_id),
        key: pilotKey(
          String(r.pilot_class),
          r.id ? String(r.id) : null,
          String(r.registered_pilot_name),
        ),
      })),
    );

    // A registration matched on its federation id can have been published under
    // a different display name since the last seed. Bringing the stored name
    // back in line is not cosmetic: the read-back below re-derives each row's
    // key from its columns, so a stale name would fail to match the key its own
    // tracks are looked up under and the pilot would seed with no flights.
    const wantedByKey = new Map(
      registrations.map((p) => [pilotKey(p.pilotClass, p.id, p.name), p] as const),
    );
    const pilotNameFixes: string[] = [];
    for (const r of existingPilotRows) {
      const id = Number(r.comp_pilot_id);
      const key = pilotKey(
        String(r.pilot_class),
        r.id ? String(r.id) : null,
        String(r.registered_pilot_name),
      );
      const wanted = wantedByKey.get(key);
      // Skip the duplicate rows of a key — they are orphans, deleted below.
      if (!wanted || pilotMatch.reused.get(key) !== id) continue;
      if (String(r.registered_pilot_name) !== wanted.name) {
        pilotNameFixes.push(
          `UPDATE comp_pilot SET registered_pilot_name = ${q(wanted.name)} WHERE comp_pilot_id = ${id};`,
        );
      }
    }

    console.log(
      `  reusing comp_id ${compId} — ${reusedTaskIds.size}/${tasks.length} task(s) and ` +
        `${pilotMatch.reused.size}/${registrations.length} pilot(s) keep their ids`,
    );
    if (taskMatch.orphanIds.length > 0 || pilotMatch.orphanIds.length > 0) {
      console.log(
        `  removing ${taskMatch.orphanIds.length} task(s) and ` +
          `${pilotMatch.orphanIds.length} pilot registration(s) the source no longer describes`,
      );
    }

    // Remember what the previous seed put in R2 — key, content hash and
    // stored gzip size — BEFORE the wipe below deletes the rows that say so.
    // The task loop compares each source track against this map and only
    // deletes-and-puts where the content actually changed; the objects
    // nothing claims are removed at the END of the seed (orphanedTrackKeys),
    // so a crash mid-seed can leave at worst a few unreachable objects,
    // never a live row pointing at a deleted one. (The rows are wiped before
    // any upload, so a crashed seed also can't leave a stale hash behind —
    // the next run finds no rows and re-uploads everything.)
    const oldTrackRows = await store.rows(
      `SELECT tt.igc_filename AS k, tt.igc_sha256 AS h, tt.file_size AS s
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id WHERE t.comp_id = ${compId};`,
    );
    for (const r of oldTrackRows) {
      oldTracks.set(String(r.k), {
        hash: r.h == null ? null : String(r.h),
        size: Number(r.s),
      });
    }
    await store.exec([
      // Clear the materialized derived caches FIRST, while the rows they key
      // off still exist. task_scores / task_field_analysis are served verbatim
      // and their blobs embed sqid links built from task_id + comp_pilot_id;
      // the tracks behind them are all being rebuilt, so every blob is stale
      // even where the ids it names still resolve. These FK-cascade on task
      // delete, but only where foreign keys are enforced (local Miniflare D1
      // often runs with them OFF) — and a reused task is never deleted, so the
      // cascade would not fire for it at all. track_analysis is (geom_hash,
      // uploaded_at)-guarded so a stale row is never served, but drop it too so
      // a reseed leaves no orphans.
      //
      // task_weather is deliberately NOT cleared: it is keyed by the task's
      // route and date rather than by a revision, so an unchanged task keeps
      // the answer it already has and a moved one re-fetches by itself.
      `DELETE FROM track_analysis WHERE task_track_id IN
         (SELECT tt.task_track_id FROM task_track tt JOIN task t ON tt.task_id = t.task_id WHERE t.comp_id = ${compId});`,
      `DELETE FROM task_scores WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
      `DELETE FROM task_field_analysis WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
      `DELETE FROM task_track WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
      `DELETE FROM task_manual_flight WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
      `DELETE FROM task_pilot_status WHERE comp_id = ${compId};`,
      `DELETE FROM task_class WHERE task_id IN (SELECT task_id FROM task WHERE comp_id = ${compId});`,
      // Only the unmatched rows go — the matched ones are rebuilt in place by
      // the task loop and the pilot upsert below, keeping their ids. A deleted
      // task takes its weather with it (the one derived table not cleared
      // comp-wide above), explicitly, for the same foreign-keys-off reason.
      ...(taskMatch.orphanIds.length > 0
        ? [
            `DELETE FROM task_weather WHERE task_id IN (${taskMatch.orphanIds.join(',')});`,
            `DELETE FROM task WHERE task_id IN (${taskMatch.orphanIds.join(',')});`,
          ]
        : []),
      ...(pilotMatch.orphanIds.length > 0
        ? [`DELETE FROM comp_pilot WHERE comp_pilot_id IN (${pilotMatch.orphanIds.join(',')});`]
        : []),
      ...pilotNameFixes,
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

  // 2) comp_pilot rows: insert only the registrations that have no row yet
  //    (matched ones kept their comp_pilot_id — and with it their URL, and any
  //    account a real pilot has linked to it), then read back ids by our key.
  //    The read-back covers reused and new rows alike, so nothing downstream
  //    has to know which was which.
  const cpBefore = await store.rows(
    `SELECT comp_pilot_id, registered_pilot_name, ${idColumn} AS id, pilot_class
       FROM comp_pilot WHERE comp_id = ${compId};`,
  );
  const existingPilotKeys = new Set(
    cpBefore.map((r) =>
      pilotKey(
        String(r.pilot_class),
        r.id ? String(r.id) : null,
        String(r.registered_pilot_name),
      ),
    ),
  );
  const newRegistrations = registrations.filter(
    (p) => !existingPilotKeys.has(pilotKey(p.pilotClass, p.id, p.name)),
  );
  await store.exec(
    newRegistrations.map(
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
  console.log(
    `  ${cpRows.length} comp_pilot rows (${newRegistrations.length} newly registered, ` +
      `${cpRows.length - newRegistrations.length} keeping their ids)`,
  );

  // 3) Per task: insert the task + its single scored class, then upload each IGC
  //    to R2 and insert its task_track row (linked to the class's comp_pilot).
  //    Open and floater "Task 1" share a date but are distinct rows, named by
  //    class so the app's task list disambiguates them.
  let totalTracks = 0;
  let totalUnchanged = 0;
  let reusedTasks = 0;
  /** Everything a `--remote` seed needs to purge this comp's now-stable public
   *  URLs from the edge (see purgeCompCache). */
  const seededTasks: SeededTask[] = [];
  for (const t of tasks) {
    const taskName = taskSeedName(t.name, t.pilotClass);
    const gapParamsJson = t.gapParams ? JSON.stringify(t.gapParams) : null;

    // Officially published results (issue #603): resolve each published row
    // to its comp_pilot by the same name matching the track-less rows use —
    // import-time matching, stored by id, so nothing matches names at read
    // time. A row that resolves to no registration (e.g. an ambiguous name)
    // is dropped and counted below rather than guessed.
    const officialResolved = t.official
      .map((row) => ({
        row,
        compPilotId: cpByKey.get(trackLessKey(t.pilotClass, row.name)),
      }))
      .filter((x): x is { row: OfficialResultRow; compPilotId: number } =>
        x.compPilotId !== undefined,
      );
    const officialTaskUrl =
      manifest.source_host && t.comPk !== undefined && t.tasPk !== undefined
        ? airscoreTaskUrl(manifest.source_host, t.comPk, t.tasPk)
        : null;
    const officialCompUrl =
      manifest.source_host && t.comPk !== undefined
        ? airscoreCompUrl(manifest.source_host, t.comPk)
        : null;
    const officialJson =
      officialResolved.length > 0
        ? JSON.stringify({
            source: 'AirScore',
            comp_url: officialCompUrl,
            task_url: officialTaskUrl,
            results: officialResolved.map((x) => ({
              comp_pilot_id: x.compPilotId,
              rank: x.row.rank,
              total: x.row.total,
            })),
          })
        : null;

    const reusedTaskId = reusedTaskIds.get(taskName);
    let taskId: number;
    if (reusedTaskId !== undefined) {
      // Rebuild the task's definition in place so the row — and every URL under
      // it — keeps its id. `creation_date` stays as it was (it only breaks
      // same-date ordering ties). The two organizer-owned fields the source
      // can't describe are reset to their defaults, so a re-seed still lands on
      // a clean sample, exactly as the old delete-and-reinsert did.
      taskId = reusedTaskId;
      reusedTasks++;
      await store.exec(
        `UPDATE task SET task_date = ${q(t.date)}, xctsk = ${q(t.xctsk)},
           gap_params = ${q(gapParamsJson)}, official_results = ${q(officialJson)},
           stop_announcement_time = NULL, weather_notes = ''
         WHERE task_id = ${taskId};`,
      );
    } else {
      await store.exec(
        `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk, gap_params, official_results)
         VALUES (${compId}, ${q(taskName)}, ${q(t.date)}, ${q(today)}, ${q(t.xctsk)},
                 ${q(gapParamsJson)}, ${q(officialJson)});`,
      );
      // Newest first: the row we just wrote, even if a manifest ever repeats a
      // task name within one comp.
      taskId = Number(
        (
          await store.rows(
            `SELECT task_id FROM task WHERE comp_id = ${compId} AND name = ${q(taskName)}
               ORDER BY task_id DESC LIMIT 1;`,
          )
        )[0].task_id,
      );
    }
    await store.exec(`INSERT INTO task_class (task_id, pilot_class) VALUES (${taskId}, ${q(t.pilotClass)});`);

    // The official annotation is competition data an importer entered, so it
    // is audited (the reseed wiped this comp's audit_log above, so reruns
    // don't stack entries). It is NOT a scoring input — nothing derives from
    // it — so it takes no score bump; same reasoning as comp_pilot.wprs_points.
    if (officialJson) {
      await store.exec(
        `INSERT INTO audit_log (comp_id, timestamp, actor_user_id, actor_name, subject_type, subject_id, subject_name, description)
         VALUES (${compId}, ${q(now)}, NULL, 'AirScore import', 'task', ${taskId}, ${q(taskName)},
                 ${q(
                   `Recorded the officially published AirScore results for ${taskName} — ` +
                     `${officialResolved.length} pilot${officialResolved.length === 1 ? '' : 's'}` +
                     (officialTaskUrl ? `, from ${officialTaskUrl}` : ''),
                 )});`,
      );
    }

    // Resolve every pilot that has a comp_pilot row into its R2 object + its two
    // D1 rows, then upload the objects concurrently and insert the rows in one
    // batch. (A pilot with a track took off and landed, so we mark them "Landed"
    // — the same status a real upload sets via applyStatusOnTrackUpload; the
    // direct insert bypasses that hook, so without it the roll call would show
    // every seeded pilot "Present". Pilots with no track keep the default.)
    const uploads: Array<{ key: string; gz: Buffer }> = [];
    const trackInserts: string[] = [];
    const scoredPilots: SeededTask['pilots'] = [];
    /** Tracks whose content matched the object already in R2 — no upload. */
    let unchanged = 0;
    /** comp_pilots with a real track in THIS task — see the track-less loop. */
    const withTrack = new Set<number>();
    for (const p of t.pilots) {
      const compPilotId = cpByKey.get(pilotKey(t.pilotClass, p.id, p.name));
      if (compPilotId === undefined) continue;
      withTrack.add(compPilotId);
      scoredPilots.push({ compPilotId, name: p.name });
      const key = `c/${compId}/t/${taskId}/${compPilotId}.igc`;
      liveKeys.add(key);
      // Skip the delete-and-put when the object already in R2 holds exactly
      // this track (hash match, migration 0032); a kept row records the OLD
      // gzip's byte size — the object that is actually there.
      const sync = trackSyncDecision(oldTracks.get(key), p.sha256, p.fileSize);
      if (sync.upload) uploads.push({ key, gz: p.gz });
      else unchanged++;
      trackInserts.push(
        `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size, igc_pilot_name, igc_sha256)
         VALUES (${taskId}, ${compPilotId}, ${q(key)}, ${q(now)}, ${sync.fileSize}, ${q(p.name)}, ${q(p.sha256)});`,
      );
      // A withheld track is not evidence the pilot flew this task, so it must
      // not claim "Landed" — the same rule the upload route follows.
      if (!p.qualityHardFailed) {
        trackInserts.push(
          `INSERT INTO task_pilot_status (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
           VALUES (${compId}, ${taskId}, ${compPilotId}, 'landed', NULL, NULL, 'Sample data', ${q(now)});`,
        );
      }
    }
    // Track-less published pilots (see TrackLessPilot): DNF rows become a
    // DNF status (launch validity, S7F §9.1); flown rows become a manual
    // flight landed at the published distance along the optimised route
    // (+ a landed status), so the seeded field — and with it every pilot's
    // validity-scaled points — matches the field AirScore scored.
    let duplicateRows = 0;
    for (const p of t.trackless) {
      const compPilotId = cpByKey.get(trackLessKey(t.pilotClass, p.name));
      if (compPilotId === undefined) continue;
      // The pilot already has a real tracklog for this task, so this published
      // row is a duplicate registration of theirs, not a second flight (AirScore
      // lists Christopher Sutton twice in Corryong 2026 floater T1 — once with a
      // glider and a track, once blank at 0.01 km). Seeding it anyway would
      // write a second flight + status for one comp_pilot in one task and trip
      // the UNIQUE(task_id, comp_pilot_id) index.
      if (withTrack.has(compPilotId)) {
        duplicateRows++;
        continue;
      }
      scoredPilots.push({ compPilotId, name: p.name });
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
    seededTasks.push({ taskId, taskName, pilots: scoredPilots });
    totalTracks += uploads.length + unchanged;
    totalUnchanged += unchanged;
    const seededTrackLess = t.trackless.length - duplicateRows;
    const extras = seededTrackLess > 0 ? `, ${seededTrackLess} track-less published pilot(s)` : '';
    const dupes =
      duplicateRows > 0
        ? `, ${duplicateRows} duplicate published row(s) skipped (pilot already has a track here)`
        : '';
    const how = reusedTaskId !== undefined ? 'rebuilt' : 'created';
    // Name what the official annotation dropped — a published row that
    // resolved to no registration is a finding, not something to hide.
    const official =
      t.official.length > 0
        ? `, official results for ${officialResolved.length}/${t.official.length} published pilots`
        : '';
    const skipNote =
      unchanged > 0 ? ` (${unchanged} unchanged, not re-uploaded)` : '';
    console.log(
      `  ${how} ${taskName}: task_id=${taskId}, ${uploads.length + unchanged} tracks${skipNote}${extras}${dupes}${official}`,
    );
  }

  // The previous seed's objects nothing claimed this time — tracks of pilots
  // or tasks the source no longer describes. Deleted last, after every upload
  // landed (see lib/seed-track-sync.ts for the crash-safety reasoning).
  const orphans = orphanedTrackKeys(oldTracks.keys(), liveKeys);
  await mapPool(orphans, R2_CONCURRENCY, (k) => store.r2Delete(k));
  if (orphans.length > 0) {
    console.log(`  removed ${orphans.length} orphaned R2 object(s)`);
  }

  console.log(
    `  Done. comp_id=${compId} — ${tasks.length} tasks (${reusedTasks} kept their ids), ` +
      `${totalTracks} tracks total (${totalUnchanged} unchanged in R2, ${totalTracks - totalUnchanged} uploaded)`,
  );
  // Leave the comp warm (see SeedStore.warmFieldAnalysis). AFTER the Done log:
  // this is a bonus pass over a fully-seeded comp, and its per-task lines
  // explain themselves.
  await store.warmFieldAnalysis?.(seededTasks.map((t) => t.taskId));
  if (REMOTE) await purgeCompCache(compId, compName, seededTasks);
}

// ── Cloudflare edge cache purge (remote seeds only) ─────────────────────────
// A reseed rebuilds a comp's scores from scratch, but Cloudflare's edge — and
// visitors' browsers — may still hold the pre-reseed pages until their max-age
// lapses, which for a settled comp is up to three months (publicMaxAgeSeconds
// grows with how long the content has been stable). Tag/prefix/hostname purges
// are Enterprise-only (and we emit no Cache-Tag), so we purge by URL.
//
// That used to mean comp-level URLs ONLY: the comp sqid was stable but task and
// pilot ids changed on every reseed, so their old cache entries were unreachable
// orphans and the new URLs were uncached. Now that every id in a URL survives a
// reseed, those entries stay reachable and would serve pre-reseed content — so
// the purge follows the ids and covers each task page, each task's score API and
// each pilot's score page too. The API caps a purge at 30 URLs per call, hence
// the chunking.

const PURGE_ORIGIN = process.env.GLIDECOMP_ORIGIN ?? 'https://glidecomp.com';
// Production serves sqids under the competition-api default alphabet
// (web/workers/competition-api/wrangler.toml — encodeId(default, 27) === 'wugh',
// the live id). Override only if a deploy sets a different SQIDS_ALPHABET.
const PURGE_SQIDS_ALPHABET =
  process.env.SQIDS_ALPHABET ?? 'abcdefghijklmnopqrstuvwxyz';

/** Cloudflare's per-call limit for a purge-by-URL request. */
const PURGE_CHUNK = 30;
/** Safety rail on a very large comp: at 30 URLs a call this is 100 requests.
 * Anything beyond it is reported rather than silently dropped. */
const MAX_PURGE_URLS = 3000;

/** What a seeded task contributes to the purge list: its own page, its score
 * API, and one score page per pilot who has a result on it. */
interface SeededTask {
  taskId: number;
  taskName: string;
  pilots: Array<{ compPilotId: number; name: string }>;
}

/**
 * The stable, publicly-cacheable URLs a reseed invalidates. Comp level: the
 * three SSR HTML pages plus the one cacheable comp-level API (comp-detail and
 * the waypoints API are `no-store`). Then, per task, the task page and its score
 * API, and one page per pilot with a result — all reachable at the same URLs as
 * before the reseed now that the ids are preserved.
 */
function compCacheUrls(
  compId: number,
  compName: string,
  seededTasks: SeededTask[],
): string[] {
  const sqid = (id: number) => encodeId(PURGE_SQIDS_ALPHABET, id);
  const comp = sqid(compId);
  const urls = [
    `${PURGE_ORIGIN}${compPath(comp, compName)}`,
    `${PURGE_ORIGIN}${compScoresPath(comp, compName)}`,
    `${PURGE_ORIGIN}${compWaypointsPath(comp, compName)}`,
    `${PURGE_ORIGIN}/api/comp/${comp}/scores`,
  ];
  for (const t of seededTasks) {
    const task = sqid(t.taskId);
    urls.push(`${PURGE_ORIGIN}${taskPath(comp, compName, task, t.taskName)}`);
    urls.push(`${PURGE_ORIGIN}/api/comp/${comp}/task/${task}/score`);
    for (const p of t.pilots) {
      urls.push(
        `${PURGE_ORIGIN}${pilotPath(comp, compName, task, t.taskName, sqid(p.compPilotId), p.name)}`,
      );
    }
  }
  return urls;
}

/** Split `items` into consecutive runs of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Purge one comp's stable public URLs from Cloudflare's edge cache. Best-effort:
 * a failure only warns, never fails the seed. No-ops (with a one-line note)
 * unless BOTH CLOUDFLARE_API_TOKEN (needs the "Cache Purge" permission) and
 * CLOUDFLARE_ZONE_ID are set, so the credential stays optional. Edge only — the
 * machine that ran the reseed still holds its own browser copy until max-age
 * lapses (hard-refresh), but every other visitor gets fresh pages at once.
 */
async function purgeCompCache(
  compId: number,
  compName: string,
  seededTasks: SeededTask[],
): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zone) {
    console.log(
      '  cache purge skipped (set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID to purge the edge)',
    );
    return;
  }
  const all = compCacheUrls(compId, compName, seededTasks);
  const files = all.slice(0, MAX_PURGE_URLS);
  if (all.length > files.length) {
    console.warn(
      `  ⚠ ${all.length - files.length} of ${all.length} cacheable URLs left unpurged ` +
        `(cap ${MAX_PURGE_URLS}); they revalidate when their max-age lapses`,
    );
  }
  let purged = 0;
  for (const batch of chunk(files, PURGE_CHUNK)) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: batch }),
        },
      );
      const body = (await res.json().catch(() => null)) as
        | { success?: boolean; errors?: unknown }
        | null;
      if (!res.ok || !body?.success) {
        console.warn(
          `  ⚠ cache purge failed (${res.status}): ${JSON.stringify(body?.errors ?? body ?? {})}`,
        );
        return;
      }
      purged += batch.length;
    } catch (err) {
      console.warn(
        `  ⚠ cache purge error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }
  console.log(`  purged ${purged} edge URLs for comp ${compId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
