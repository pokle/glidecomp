// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Corpus discovery for the track-placement experiment.
 *
 * Enumerates every non-synthetic competition task across the two checkouts —
 * this repo's bundled comps and a checkout of pokle/glidecomp-archive — and
 * resolves, per task, everything the extractor needs before it opens a single
 * IGC file: the scoring category, the merged GAP parameters, the comp's
 * timezone, and the published AirScore rows to carry alongside as a parity
 * column.
 *
 * Nothing here is imported by the app, the engine's scoring closure, or CI.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GAPParameters } from '@glidecomp/engine';
import { timezoneForXctsk } from '@glidecomp/engine/timezone';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** This repo's bundled comps; `GLIDECOMP_COMPS_DIR` moves it. */
export const COMPS_ROOT = process.env.GLIDECOMP_COMPS_DIR
  ? resolve(process.env.GLIDECOMP_COMPS_DIR)
  : join(REPO_ROOT, 'web/samples/comps');

/**
 * The pokle/glidecomp-archive checkout: comps in, weather and features out.
 *
 * Found as a sibling of the checkout, walking up so a run from inside a git
 * worktree (`<repo>/.claude/worktrees/<name>`) still lands on the archive
 * beside the main checkout rather than beside the worktree.
 * `GLIDECOMP_ARCHIVE_DIR` overrides it outright.
 */
export const ARCHIVE_ROOT = process.env.GLIDECOMP_ARCHIVE_DIR
  ? resolve(process.env.GLIDECOMP_ARCHIVE_DIR)
  : findSiblingArchive(REPO_ROOT);

function findSiblingArchive(from: string): string {
  const fallback = join(from, '../glidecomp-archive');
  let dir = from;
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, '../glidecomp-archive');
    if (existsSync(join(candidate, 'comps'))) return resolve(candidate);
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(fallback);
}

/**
 * Generated comps, excluded from the corpus: `kosci-loop` and `big-chip` are
 * written by `web/scripts/generate-*.ts` from forged tracks, so a model
 * trained on them would be learning the generator.
 */
const SYNTHETIC_COMPS = new Set(['kosci-loop', 'big-chip']);

export interface CompEntry {
  slug: string;
  name: string;
  /** Directory holding the comp folder AND its task folders as siblings. */
  root: string;
  /** Which checkout it came from — reported in the dataset stats. */
  source: 'samples' | 'archive';
  /** Scoring category, resolved exactly as verify-airscore-parity.ts does. */
  category: 'hg' | 'pg';
  gapParams: Partial<GAPParameters> | undefined;
  /** The comp's zone, from the first task's route (the seed's own rule). */
  timezone: string | undefined;
  tasks: TaskEntry[];
}

export interface TaskEntry {
  compSlug: string;
  compName: string;
  root: string;
  /** Task folder name — the dataset's key, one-to-one with `comps/`. */
  dir: string;
  pilotClass: string;
  taskName: string;
  date: string | undefined;
  category: 'hg' | 'pg';
  /**
   * The wing the field flew, from the published `task.comp_class` where
   * AirScore rows exist and the comp registry's category otherwise. Kept
   * apart from `category` so a disagreement between the two is visible in
   * the stats rather than silently resolved.
   */
  wing: 'hg' | 'pg';
  /** Task overrides merged over the comp's base — the seed → scorer path. */
  gapParams: Partial<GAPParameters>;
  timezone: string | undefined;
  /** Published AirScore rows, or null when this task has no results file. */
  airscore: AirscoreResult | null;
  igcFiles: string[];
}

export interface AirscoreResult {
  compClass: string | undefined;
  stopped: boolean;
  /** Published total points by surname key, ascending within a duplicate. */
  totalsBySurname: Map<string, number[]>;
  rowCount: number;
}

interface RawTaskManifest {
  dir: string;
  name?: string;
  pilot_class?: string;
  date?: string;
  gap_params?: Partial<GAPParameters>;
}

/** "lamb_18239_050126.igc" → "lamb"; "de_vecchi_31_050126.igc" → "de_vecchi". */
export function surnameFromFilename(f: string): string {
  return f.replace(/_\d+_\d{6}\.igc$/i, '').toLowerCase();
}

/** '<a …>Todd Wisewould</a>' → "wisewould" (all-but-first words, joined). */
function surnameFromPublishedName(html: string): string {
  const full = String(html).replace(/<[^>]+>/g, '').trim();
  const words = full.split(/\s+/);
  return (words.length > 1 ? words.slice(1) : words).join('_').toLowerCase();
}

function readAirscore(dir: string): AirscoreResult | null {
  const path = join(dir, 'airscore-result-raw.json');
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const totals = new Map<string, number[]>();
  for (const row of raw.data ?? []) {
    const total = Number(row[16]);
    if (!Number.isFinite(total)) continue;
    const key = surnameFromPublishedName(row[2]);
    const bucket = totals.get(key) ?? totals.set(key, []).get(key)!;
    bucket.push(total);
  }
  for (const bucket of totals.values()) bucket.sort((a, b) => a - b);
  return {
    compClass: typeof raw.task?.comp_class === 'string' ? raw.task.comp_class : undefined,
    stopped: raw.task?.stopped === true,
    totalsBySurname: totals,
    rowCount: Array.isArray(raw.data) ? raw.data.length : 0,
  };
}

function loadComp(root: string, slug: string, source: 'samples' | 'archive'): CompEntry | null {
  const manifestPath = join(root, slug, 'comp.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const category: 'hg' | 'pg' = manifest.category === 'pg' ? 'pg' : 'hg';

  const rawTasks: RawTaskManifest[] = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  const firstWithRoute = rawTasks.find((t) => existsSync(join(root, t.dir, 'task.xctsk')));
  const timezone = firstWithRoute
    ? timezoneForXctsk(readFileSync(join(root, firstWithRoute.dir, 'task.xctsk'), 'utf-8'))
    : undefined;

  const tasks: TaskEntry[] = [];
  for (const t of rawTasks) {
    const dir = join(root, t.dir);
    if (!existsSync(join(dir, 'task.xctsk'))) continue;
    const igcFiles = readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.igc'))
      .sort();
    if (igcFiles.length === 0) continue;
    const airscore = readAirscore(dir);
    const published = airscore?.compClass?.toLowerCase();
    tasks.push({
      compSlug: slug,
      compName: manifest.name ?? slug,
      root,
      dir: t.dir,
      pilotClass: t.pilot_class ?? 'open',
      taskName: t.name ?? t.dir,
      date: t.date,
      category,
      wing: published === 'pg' || published === 'hg' ? published : category,
      gapParams: { ...(manifest.gap_params ?? {}), ...(t.gap_params ?? {}) },
      timezone,
      airscore,
      igcFiles,
    });
  }
  if (tasks.length === 0) return null;
  return {
    slug,
    name: manifest.name ?? slug,
    root,
    source,
    category,
    gapParams: manifest.gap_params,
    timezone,
    tasks,
  };
}

function compSlugsIn(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'comp.json')))
    .map((e) => e.name)
    .sort();
}

export interface CorpusOptions {
  /** Restrict to these comp slugs (the `--comp` flag). Empty means all. */
  only?: string[];
}

export interface Corpus {
  comps: CompEntry[];
  /**
   * Task folders reachable from more than one root, and therefore counted
   * once. `web/samples/comps/corryong-cup-2021-open-t1` is the parity fixture
   * that duplicates an archive task folder; anything else appearing here is
   * worth looking at before trusting the dataset.
   */
  duplicateTaskDirs: string[];
  /** Comp slugs skipped because they are generated, not flown. */
  syntheticSkipped: string[];
}

/**
 * Every non-synthetic comp across both checkouts, archive first so a task
 * folder duplicated into the samples tree de-duplicates against the archive
 * original rather than the copy.
 */
export function loadCorpus(options: CorpusOptions = {}): Corpus {
  const only = new Set(options.only ?? []);
  const roots: { root: string; source: 'samples' | 'archive' }[] = [
    { root: join(ARCHIVE_ROOT, 'comps'), source: 'archive' },
    { root: COMPS_ROOT, source: 'samples' },
  ];

  const comps: CompEntry[] = [];
  const seenTaskDirs = new Set<string>();
  const duplicateTaskDirs: string[] = [];
  const syntheticSkipped: string[] = [];

  for (const { root, source } of roots) {
    for (const slug of compSlugsIn(root)) {
      if (SYNTHETIC_COMPS.has(slug)) {
        syntheticSkipped.push(slug);
        continue;
      }
      if (only.size > 0 && !only.has(slug)) continue;
      const comp = loadComp(root, slug, source);
      if (!comp) continue;
      comp.tasks = comp.tasks.filter((t) => {
        if (seenTaskDirs.has(t.dir)) {
          duplicateTaskDirs.push(t.dir);
          return false;
        }
        seenTaskDirs.add(t.dir);
        return true;
      });
      if (comp.tasks.length > 0) comps.push(comp);
    }
  }
  return { comps, duplicateTaskDirs, syntheticSkipped };
}
