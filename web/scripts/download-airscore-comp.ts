#!/usr/bin/env bun
// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Download an entire AirScore competition — every task, every pilot track, and
 * the region waypoints — into web/samples/comps/, idempotently. This is the
 * source-of-truth loader for the bundled sample competition(s); the seed script
 * (seed-sample-comp.ts) then loads what this writes into D1 + R2.
 *
 * AirScore models each pilot class as a SEPARATE competition (different comPk),
 * even when they are really one event flying different tasks per day. A comp
 * config here can therefore list several sources, each mapped to a GlideComp
 * pilot class; every source's tasks land in class-tagged folders under one comp.
 *
 * Output layout (flat, one served compId per folder):
 *   web/samples/comps/<slug>/                     comp meta (comp.json, waypoints)
 *   web/samples/comps/<slug>-<class>-t<N>/        one task: task.xctsk + *.igc + result
 *
 * Idempotent: each run rewrites every task folder from the source. A folder
 * containing a `.curated` marker is left untouched (e.g. a hand-tuned parity
 * fixture) but still recorded in comp.json.
 *
 * POLITE BY DEFAULT: requests are spaced out like a human clicking through the
 * site (a few seconds apart, with jitter) so we never hammer the AirScore host.
 * Tune with REQUEST_DELAY_MS (milliseconds between requests; default 3500).
 *
 * Usage:
 *   bun web/scripts/download-airscore-comp.ts                 # default comp
 *   bun web/scripts/download-airscore-comp.ts corryong-cup-2026
 *   REQUEST_DELAY_MS=6000 bun web/scripts/download-airscore-comp.ts
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIGC } from '@glidecomp/engine';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const COMPS_ROOT = join(REPO_ROOT, 'web/samples/comps');

// --- comp registry ---------------------------------------------------------

interface CompSource {
  /** AirScore competition primary key (one per pilot class). */
  comPk: number;
  /** GlideComp pilot class these tasks belong to. */
  pilotClass: string;
}
interface CompConfig {
  name: string;
  host: string;
  sources: CompSource[];
  /**
   * D1 comp name the seed script should use. When omitted the seed script
   * falls back to the fixed SAMPLE_COMP_NAME (the Corryong 2026 sample) — so
   * every other comp MUST set this, or seeding it would overwrite the sample.
   */
  compName?: string;
  /**
   * Comp category ('hg' | 'pg'), matching the hg/pg symbol AirScore shows in
   * its comp list. When omitted the seed script defaults to 'hg'.
   */
  category?: string;
}

const HIGHCLOUD = 'https://xc.highcloud.net';

/**
 * Helper for the Corryong Cup lineage: one event, two AirScore comps (open +
 * floater), merged here into one GlideComp comp with two pilot classes.
 */
function corryongCup(year: number, openComPk: number, floaterComPk: number): CompConfig {
  return {
    name: `Corryong Cup ${year}`,
    compName: `Corryong Cup ${year}`,
    host: HIGHCLOUD,
    sources: [
      { comPk: openComPk, pilotClass: 'open' },
      { comPk: floaterComPk, pilotClass: 'floater' },
    ],
  };
}

const COMPS: Record<string, CompConfig> = {
  'corryong-cup-2026': {
    name: 'Corryong Cup 2026',
    host: HIGHCLOUD,
    // AirScore splits the event into two comps by class; same real competition.
    // No compName: the 2026 sample keeps seeding under the fixed SAMPLE_COMP_NAME.
    sources: [
      { comPk: 466, pilotClass: 'open' },
      { comPk: 465, pilotClass: 'floater' },
    ],
  },
  // Prior years of the same event. AirScore names vary ("Corryong Cup 2025" is
  // the open comp even without the word "Open"); comPks come from
  // get_all_comps.php on the host.
  'corryong-cup-2025': corryongCup(2025, 428, 427),
  'corryong-cup-2024': corryongCup(2024, 393, 394),
  'corryong-cup-2023': corryongCup(2023, 363, 364),
  'corryong-cup-2022': corryongCup(2022, 335, 336),
  'corryong-cup-2021': corryongCup(2021, 305, 308),
  // Dec 2020 stand-in for the Corryong Cup (COVID season); a single comp with
  // no separate floater class.
  'unungra-cup-2020': {
    name: 'Unungra Cup',
    compName: 'Unungra Cup',
    host: HIGHCLOUD,
    category: 'pg', // unlike the (hang gliding) Corryong Cups, this one is PG
    sources: [{ comPk: 303, pilotClass: 'open' }],
  },
  'corryong-cup-2017': corryongCup(2017, 208, 209),
};

// --- polite HTTP -----------------------------------------------------------

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 3500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait a human-ish interval before each request (base delay + up to ~1.5s jitter). */
const pace = () => sleep(BASE_DELAY_MS + Math.floor(Math.random() * 1500));

let requestCount = 0;

async function getText(url: string): Promise<string> {
  await pace();
  requestCount++;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function getJson<T = any>(url: string): Promise<T> {
  return JSON.parse(await getText(url)) as T;
}

async function postForm(url: string, form: Record<string, string>): Promise<ArrayBuffer> {
  await pace();
  requestCount++;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.arrayBuffer();
}

// --- time helpers (AirScore publishes local HH:MM:SS; xctsk gates are Z) ----

const pad2 = (n: number) => String(n).padStart(2, '0');
const toMin = (hms: string): number => {
  const [h, m] = hms.split(':').map(Number);
  return h * 60 + m;
};
const zToMin = (z: string): number => toMin(z.replace(/Z$/, ''));
const minToZ = (mins: number): string => {
  const w = ((mins % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(w / 60))}:${pad2(w % 60)}:00Z`;
};
/** '2026-01-07' → '070126' (the DDMMYY stamp AirScore puts in IGC filenames). */
const dateToDDMMYY = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}${m}${y.slice(2)}`;
};

// --- xctsk building --------------------------------------------------------

/**
 * AirScore's `download_task.php` export coerces everything to strings and, for
 * interval-start tasks, collapses the start gates to a single opening time.
 * Rebuild a clean xctsk: numeric turnpoints, and — for interval tasks — the
 * real start-gate grid reconstructed from the pilots' credited start times in
 * the published results (each credited start is a gate a pilot actually used,
 * so snapping is reproduced exactly; the opening gate is always included).
 */
function buildXctsk(
  source: any,
  taskType: string,
  resultRows: any[],
  taskStartLocal: number,
  offsetH: number,
): string {
  const turnpoints = source.turnpoints.map((tp: any) => {
    const w = tp.waypoint;
    const out: any = {
      radius: Math.round(Number(tp.radius)),
      waypoint: {
        lat: Number(w.lat),
        lon: Number(w.lon),
        altSmoothed: Math.round(Number(w.altSmoothed ?? 0) || 0),
        name: w.name,
        description: w.description ?? w.name,
      },
    };
    if (tp.type) out.type = tp.type;
    return out;
  });

  let timeGates: string[] = source.sss?.timeGates ?? [];
  if (/interval/i.test(taskType)) {
    // Credited pilot starts (col 6), local, keep only those at/after task open.
    const credited = resultRows
      .map((r) => r[6])
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map(toMin)
      .filter((s) => s >= taskStartLocal)
      .map((s) => minToZ(s - offsetH * 60));
    // Always include the source opening gate, then every used gate, unique+sorted.
    const opening = timeGates[0] ? [timeGates[0]] : [];
    const grid = [...new Set([...opening, ...credited])].sort(
      (a, b) => zToMin(a) - zToMin(b),
    );
    if (grid.length) timeGates = grid;
  }

  const xctsk: any = {
    earthModel: source.earthModel ?? 'WGS84',
    goal: {
      deadline: source.goal?.deadline,
      type: source.goal?.type ?? 'CYLINDER',
    },
    sss: {
      direction: source.sss?.direction ?? 'EXIT',
      timeGates,
      type: source.sss?.type ?? 'RACE',
    },
    taskType: source.taskType ?? 'CLASSIC',
    turnpoints,
    version: source.version ?? 1,
  };
  return JSON.stringify(xctsk, null, 2);
}

// --- track zip handling ----------------------------------------------------

/**
 * Extract the tracks zip into `dir`, then drop stray off-date duplicates: a few
 * pilots have an extra IGC whose filename stamp is from another day (a mis-dated
 * upload). When a pilot has several files, keep the one matching this task's
 * date. Returns the count of tracks kept.
 */
function extractTracks(zipBuf: ArrayBuffer, dir: string, taskDateIso: string): number {
  for (const f of readdirSync(dir)) {
    if (f.toLowerCase().endsWith('.igc')) rmSync(join(dir, f));
  }
  const zipPath = join(dir, '_tracks.zip');
  writeFileSync(zipPath, Buffer.from(zipBuf));
  const res = spawnSync('unzip', ['-o', '-q', '-j', zipPath, '-d', dir]);
  rmSync(zipPath);
  if (res.status !== 0) {
    throw new Error(`unzip failed: ${res.stderr?.toString() || res.stdout?.toString()}`);
  }

  const stamp = dateToDDMMYY(taskDateIso);
  const igc = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.igc'));
  // Group by pilot (filename minus the trailing _DDMMYY stamp).
  const byPilot = new Map<string, string[]>();
  for (const f of igc) {
    const key = f.replace(/_\d{6}\.igc$/i, '');
    (byPilot.get(key) ?? byPilot.set(key, []).get(key)!).push(f);
  }
  let kept = 0;
  for (const files of byPilot.values()) {
    if (files.length > 1) {
      const onDate = files.filter((f) => f.includes(`_${stamp}.igc`));
      const drop = onDate.length ? files.filter((f) => !f.includes(`_${stamp}.igc`)) : [];
      for (const f of drop) rmSync(join(dir, f));
      kept += files.length - drop.length;
    } else {
      kept += 1;
    }
  }
  return kept;
}

// --- per-comp download -----------------------------------------------------

interface TaskManifestEntry {
  pilot_class: string;
  name: string;
  date: string;
  dir: string;
  tasPk: number;
  comPk: number;
  task_type: string;
}

async function downloadComp(slug: string): Promise<void> {
  const cfg = COMPS[slug];
  if (!cfg) throw new Error(`Unknown comp "${slug}". Known: ${Object.keys(COMPS).join(', ')}`);
  console.log(`Downloading "${cfg.name}" from ${cfg.host} (delay ~${BASE_DELAY_MS}ms/request)…`);
  mkdirSync(COMPS_ROOT, { recursive: true });

  const tasks: TaskManifestEntry[] = [];
  const classes: string[] = [];
  let regPk: string | undefined;
  let regionName: string | undefined;

  for (const src of cfg.sources) {
    if (!classes.includes(src.pilotClass)) classes.push(src.pilotClass);
    console.log(`\n▶ ${src.pilotClass} (comPk=${src.comPk})`);
    const all = await getJson(`${cfg.host}/get_all_tasks.php?comPk=${src.comPk}`);
    const offsetH = Number(all.comp?.comTimeOffset ?? 0);

    // Sort tasks by date then tasPk → stable t1, t2, t3 ordering.
    const list = Object.values<any>(all.tasks).sort((a, b) => {
      const ta = a.task, tb = b.task;
      return ta.tasDate === tb.tasDate
        ? Number(ta.tasPk) - Number(tb.tasPk)
        : ta.tasDate.localeCompare(tb.tasDate);
    });
    if (regPk === undefined) {
      regPk = list[0]?.waypoints?.[0]?.regPk;
    }

    let idx = 0;
    for (const item of list) {
      idx++;
      const t = item.task;
      const dir = join(COMPS_ROOT, `${slug}-${src.pilotClass}-t${idx}`);
      const entry: TaskManifestEntry = {
        pilot_class: src.pilotClass,
        name: `Task ${idx}`,
        date: t.tasDate,
        dir: basename(dir),
        tasPk: Number(t.tasPk),
        comPk: src.comPk,
        task_type: t.tasTaskType,
      };
      tasks.push(entry);

      if (existsSync(join(dir, '.curated'))) {
        console.log(`  t${idx} (${t.tasName}, ${t.tasDate}) — curated, left untouched`);
        continue;
      }
      mkdirSync(dir, { recursive: true });

      const source = JSON.parse(
        await getText(`${cfg.host}/download_task.php?comPk=${src.comPk}&tasPk=${t.tasPk}`),
      );
      const result = await getJson(
        `${cfg.host}/get_task_result.php?comPk=${src.comPk}&tasPk=${t.tasPk}`,
      );
      const taskStartLocal = toMin(result.task.start);
      const xctsk = buildXctsk(source, t.tasTaskType, result.data ?? [], taskStartLocal, offsetH);
      writeFileSync(join(dir, 'task.xctsk'), xctsk);

      writeFileSync(
        join(dir, 'airscore-result-raw.json'),
        JSON.stringify(
          {
            source: `${cfg.host}/get_task_result.php?comPk=${src.comPk}&tasPk=${t.tasPk}`,
            note: 'Raw AirScore published results (verbatim), kept as provenance/parity reference.',
            ...result,
          },
          null,
          2,
        ),
      );

      const zip = await postForm(`${cfg.host}/download_tracks.php`, {
        tasPk: String(t.tasPk),
        count: '0',
      });
      const kept = extractTracks(zip, dir, t.tasDate);
      // Validate the tracks parse (surfaces a bad download early).
      const parsed = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.igc'))
        .filter((f) => parseIGC(readFileSync(join(dir, f), 'utf-8')).fixes.length > 0).length;
      console.log(
        `  t${idx} (${t.tasName}, ${t.tasDate}, ${t.tasTaskType}): ${kept} tracks ` +
          `(${parsed} non-empty), gates=${JSON.parse(xctsk).sss.timeGates.length}`,
      );
    }
  }

  // Region waypoints — shared across classes; fetched once.
  const metaDir = join(COMPS_ROOT, slug);
  mkdirSync(metaDir, { recursive: true });
  if (regPk) {
    const wptFile = await postForm(`${cfg.host}/download_waypoints.php`, {
      regPk: String(regPk),
      download: '1',
    });
    writeFileSync(join(metaDir, 'waypoints.wpt'), Buffer.from(wptFile));
    const wptJson = await getJson(`${cfg.host}/get_waypoints.php?regPk=${regPk}`);
    regionName = Array.isArray(wptJson.region) ? wptJson.region[1] : undefined;
    writeFileSync(join(metaDir, 'waypoints.json'), JSON.stringify(wptJson, null, 2));
    console.log(`\n▶ waypoints: region ${regionName ?? regPk} (${wptJson.waypoints?.length ?? 0} points)`);
  }

  // comp.json manifest — the seed script's source of truth for this comp.
  const manifest = {
    name: cfg.name,
    slug,
    source_host: cfg.host,
    ...(cfg.compName ? { comp_name: cfg.compName } : {}),
    ...(cfg.category ? { category: cfg.category } : {}),
    classes,
    waypoint_region: regPk ? { regPk: Number(regPk), name: regionName ?? null } : null,
    tasks,
  };
  writeFileSync(join(metaDir, 'comp.json'), JSON.stringify(manifest, null, 2));

  console.log(
    `\nDone. ${tasks.length} tasks across ${classes.length} classes ` +
      `(${classes.join(', ')}); ${requestCount} requests.`,
  );
  console.log(`  Manifest: ${join('web/samples/comps', slug, 'comp.json')}`);
  console.log(`  Seed it:  bun run seed:sample`);
}

const slug = process.argv[2] ?? 'corryong-cup-2026';
await downloadComp(slug);
