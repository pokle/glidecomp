#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Parity report: score every task of a downloaded comp with the GlideComp
 * engine — under the AirScore-mapped gap_params from its manifest — and
 * compare per-pilot totals against the published AirScore results
 * (airscore-result-raw.json). This is the go/no-go gate in the history
 * import pipeline (docs/2026-07-21-airscore-history-import-plan.md,
 * workstream 4): download → manifest → verify → seed.
 *
 * Prints, per task: the formula it was scored with, any mapping warnings,
 * matched-pilot count, and the mean/max absolute total-point difference.
 * Tasks above the thresholds are flagged; known-unreproducible comps
 * (GGap, Dpt/Lkm departure, …) will flag — record their report rather
 * than silently seeding wrong numbers.
 *
 * Usage:
 *   bun web/scripts/verify-airscore-parity.ts <slug> [<slug>…]
 *   bun web/scripts/verify-airscore-parity.ts corryong-cup-2021
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIGC,
  parseXCTask,
  scoreTask,
  resolveCompGapParams,
  type GAPParameters,
  type PilotFlight,
} from '@glidecomp/engine';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const COMPS_ROOT = join(REPO_ROOT, 'web/samples/comps');

// Flag thresholds (points): tune from experience per the plan doc.
const MEAN_THRESHOLD = 2;
const MAX_THRESHOLD = 10;

/** "lamb_18239_050126.igc" → "lamb"; "de_vecchi_31_050126.igc" → "de_vecchi". */
function surnameFromFilename(f: string): string {
  return f.replace(/_\d+_\d{6}\.igc$/i, '').toLowerCase();
}

/** '<a …>Todd Wisewould</a>' → "wisewould" (all-but-first words, joined). */
function surnameFromPublishedName(html: string): string {
  const full = String(html).replace(/<[^>]+>/g, '').trim();
  const words = full.split(/\s+/);
  return (words.length > 1 ? words.slice(1) : words).join('_').toLowerCase();
}

interface TaskReport {
  dir: string;
  formula: string;
  warnings: string[];
  matched: number;
  publishedRows: number;
  mean: number;
  max: number;
  flagged: boolean;
  note?: string;
}

function verifyTask(
  taskEntry: {
    dir: string;
    gap_params?: Partial<GAPParameters>;
    airscore_formula?: { formula?: string };
    formula_warnings?: string[];
  },
  category: 'hg' | 'pg',
  compGapParams: Partial<GAPParameters> | undefined,
): TaskReport | null {
  const dir = join(COMPS_ROOT, taskEntry.dir);
  const rawPath = join(dir, 'airscore-result-raw.json');
  if (!existsSync(rawPath)) return null;
  const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));

  const report: TaskReport = {
    dir: taskEntry.dir,
    formula: taskEntry.airscore_formula?.formula ?? '(unknown)',
    warnings: taskEntry.formula_warnings ?? [],
    matched: 0,
    publishedRows: Array.isArray(raw.data) ? raw.data.length : 0,
    mean: NaN,
    max: NaN,
    flagged: false,
  };
  if (raw.task?.stopped) {
    report.note = 'stopped task — engine stop context not driven by this script; not verified';
    return report;
  }

  const xctsk = parseXCTask(readFileSync(join(dir, 'task.xctsk'), 'utf-8'));
  const pilots: PilotFlight[] = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.igc'))
    .map((f) => ({
      pilotName: surnameFromFilename(f),
      trackFile: f,
      fixes: parseIGC(readFileSync(join(dir, f), 'utf-8')).fixes,
    }))
    .filter((p) => p.fixes.length > 0);

  // The same parameter resolution the seed → scorer path produces: task
  // overrides merged over the comp's mapped base, defaults filled per
  // category. (No creation date — imported comps always pin their formula.)
  const merged = { ...(compGapParams ?? {}), ...(taskEntry.gap_params ?? {}) };
  const params = resolveCompGapParams(category, merged);
  const result = scoreTask(xctsk, pilots, params);

  // Published totals by surname key; duplicate surnames compare as sorted
  // multisets so two same-surname pilots can't misreport a diff.
  const published = new Map<string, number[]>();
  for (const row of raw.data ?? []) {
    const key = surnameFromPublishedName(row[2]);
    const total = Number(row[16]);
    if (!Number.isFinite(total)) continue;
    (published.get(key) ?? published.set(key, []).get(key)!).push(total);
  }
  const ours = new Map<string, number[]>();
  for (const p of result.pilotScores) {
    (ours.get(p.pilotName) ?? ours.set(p.pilotName, []).get(p.pilotName)!).push(p.totalScore);
  }

  const diffs: number[] = [];
  for (const [key, ourTotals] of ours) {
    const pubTotals = published.get(key);
    if (!pubTotals || pubTotals.length !== ourTotals.length) continue;
    const a = [...ourTotals].sort((x, y) => x - y);
    const b = [...pubTotals].sort((x, y) => x - y);
    for (let i = 0; i < a.length; i++) diffs.push(Math.abs(a[i] - b[i]));
    report.matched += a.length;
  }
  if (diffs.length > 0) {
    report.mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    report.max = Math.max(...diffs);
    report.flagged = report.mean > MEAN_THRESHOLD || report.max > MAX_THRESHOLD;
  }
  return report;
}

function verifyComp(slug: string): boolean {
  const manifestPath = join(COMPS_ROOT, slug, 'comp.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest at ${manifestPath} — download the comp first`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const category: 'hg' | 'pg' = manifest.category === 'pg' ? 'pg' : 'hg';
  console.log(`\n=== ${manifest.name} (${slug}, ${category}) ===`);

  let anyFlagged = false;
  for (const t of manifest.tasks) {
    const r = verifyTask(t, category, manifest.gap_params);
    if (!r) {
      console.log(`  ${t.dir}: no airscore-result-raw.json (curated fixture?) — skipped`);
      continue;
    }
    if (r.note) {
      console.log(`  ${t.dir} [${r.formula}]: ${r.note}`);
      continue;
    }
    const flag = r.flagged ? '  ⚠ ABOVE THRESHOLD' : '';
    console.log(
      `  ${r.dir} [${r.formula}]: ${r.matched}/${r.publishedRows} pilots matched, ` +
        `mean |Δtotal| ${r.mean.toFixed(1)}, max ${r.max.toFixed(1)}${flag}`,
    );
    for (const w of r.warnings) console.log(`      warning: ${w}`);
    anyFlagged ||= r.flagged;
  }
  return anyFlagged;
}

const slugs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (slugs.length === 0) {
  console.error('Usage: bun web/scripts/verify-airscore-parity.ts <slug> [<slug>…]');
  process.exit(2);
}
let flagged = false;
for (const slug of slugs) flagged = verifyComp(slug) || flagged;
console.log(
  flagged
    ? `\nSome tasks exceed the thresholds (mean > ${MEAN_THRESHOLD} or max > ${MAX_THRESHOLD} pts) — record the report before seeding.`
    : '\nAll verified tasks are within thresholds.',
);
process.exit(flagged ? 1 : 0);
