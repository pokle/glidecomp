/**
 * Sweep every bundled (and, with GLIDECOMP_COMPS_DIR, every archived) task
 * through assessTrackQuality and report what it flags.
 *
 * This is the false-positive guard the unit tests cannot be: the thresholds
 * in track-quality.ts are calibrated against the whole archive, and the only
 * way to know a re-tune has not started rejecting honest pilots is to run it
 * over every real track we have. A HARD finding on anything other than the
 * known New Zealand track in corryong-cup-2025-open-t4 is a regression.
 *
 *   bun web/scripts/audit-track-quality.ts
 *   GLIDECOMP_COMPS_DIR=~/dev/glidecomp-archive/comps bun web/scripts/audit-track-quality.ts
 *   ... --soft     also list every soft finding (there are many, by design)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseIGC } from '../engine/src/igc-parser';
import { parseXCTask } from '../engine/src/xctsk-parser';
import { assessTrackQuality } from '../engine/src/track-quality';
import type { TrackQualityCheckId } from '../engine/src/track-quality';

const COMPS_DIR =
  process.env.GLIDECOMP_COMPS_DIR ?? join(import.meta.dir, '..', 'samples', 'comps');
const SHOW_SOFT = process.argv.includes('--soft');

/** Competition time zone by comp slug. The manifests don't carry one, and the
 * check only needs it to place the local day — Australian comps are the whole
 * bundled and archived set. */
function zoneForSlug(slug: string): string {
  if (slug.startsWith('bright-open') || slug.startsWith('corryong') || slug.startsWith('unungra'))
    return 'Australia/Melbourne';
  if (slug.startsWith('forbes') || slug.startsWith('dalby') || slug.startsWith('kosci'))
    return 'Australia/Sydney';
  if (slug.startsWith('big-chip')) return 'Australia/Melbourne';
  return 'Australia/Sydney';
}

interface TaskEntry {
  dir: string;
  date: string;
  slug: string;
  category: 'hg' | 'pg';
}

function collectTasks(): TaskEntry[] {
  const out: TaskEntry[] = [];
  for (const name of readdirSync(COMPS_DIR).sort()) {
    const manifest = join(COMPS_DIR, name, 'comp.json');
    if (!existsSync(manifest)) continue;
    const comp = JSON.parse(readFileSync(manifest, 'utf8'));
    const category: 'hg' | 'pg' = comp.category === 'pg' ? 'pg' : 'hg';
    for (const task of comp.tasks ?? []) {
      if (!task.dir || !task.date) continue;
      if (!existsSync(join(COMPS_DIR, task.dir, 'task.xctsk'))) continue;
      out.push({ dir: task.dir, date: task.date, slug: comp.slug ?? name, category });
    }
  }
  return out;
}

const tasks = collectTasks();
if (tasks.length === 0) {
  console.error(`No tasks with a route under ${COMPS_DIR}`);
  process.exit(1);
}

let trackCount = 0;
const hard: string[] = [];
const softCounts = new Map<TrackQualityCheckId, number>();
const softExamples = new Map<TrackQualityCheckId, string[]>();

for (const task of tasks) {
  const dir = join(COMPS_DIR, task.dir);
  const xcTask = parseXCTask(readFileSync(join(dir, 'task.xctsk'), 'utf8'));
  const context = {
    task: xcTask,
    taskDate: task.date,
    timeZone: zoneForSlug(task.slug),
    category: task.category,
  };
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.igc')) continue;
    trackCount++;
    const igc = parseIGC(readFileSync(join(dir, file), 'utf8'));
    const report = assessTrackQuality(igc.fixes, igc.header, context);
    for (const f of report.findings) {
      const where = `${task.dir}/${file}`;
      if (f.severity === 'hard') hard.push(`${where}\n    ${f.title} — ${f.detail}`);
      else {
        softCounts.set(f.id, (softCounts.get(f.id) ?? 0) + 1);
        const ex = softExamples.get(f.id) ?? [];
        if (ex.length < 5) ex.push(where);
        softExamples.set(f.id, ex);
      }
    }
  }
}

console.log(`Scanned ${trackCount} tracks across ${tasks.length} tasks in ${COMPS_DIR}\n`);

console.log(`HARD findings: ${hard.length}`);
for (const h of hard) console.log(`  ${h}`);

const softTotal = [...softCounts.values()].reduce((a, b) => a + b, 0);
console.log(`\nSOFT findings: ${softTotal}`);
for (const [id, n] of [...softCounts.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((n / trackCount) * 100).toFixed(1);
  console.log(`  ${id.padEnd(20)} ${String(n).padStart(5)}  (${pct}% of tracks)`);
  if (SHOW_SOFT) for (const ex of softExamples.get(id) ?? []) console.log(`      e.g. ${ex}`);
}
