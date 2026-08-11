#!/usr/bin/env bun
/**
 * Forge a tracklog that flies a real task, so track submission can be tested
 * end to end without anybody going flying.
 *
 * It is easy to make a file that PARSES and almost as easy to make one that is
 * quietly rejected: the upload path checks the file's shape (SEC-04), and then
 * track-quality.ts asks whether the flight happened on the task's day and at
 * the task's place. A tracklog that fails either is stored but never scores,
 * which makes it useless for testing the happy path and indistinguishable from
 * a bug. So this synthesises a flight that actually flies the route, on the
 * day, at plausible speeds — and can deliberately break either check when the
 * warning paths are what you want to see.
 *
 * The output is verified against the same engine the worker runs, so a PASS
 * here means the file will be accepted and scored, not that it looks right.
 *
 *   bun run forge-igc -- --open                      # list what is flying now
 *   bun run forge-igc -- --task <sqid> --out f.igc
 *   bun run forge-igc -- --task <sqid> --submit --ident 12345
 *   bun run forge-igc -- --task <sqid> --out f.igc --sabotage day
 *
 * See docs/track-submission.md.
 */

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  parseIGC,
  assessTrackQuality,
  summariseFlight,
  forgeIgc,
  startSecondsFor,
  zoneOffsetHours,
  type XCTask,
} from "@glidecomp/engine";

const API = process.env.DEV_API_ORIGIN || "http://localhost:8790";

// ── options ───────────────────────────────────────────────────────────────

interface Options {
  open: boolean;
  comp: string | null;
  task: string | null;
  out: string | null;
  submit: boolean;
  identKind: string;
  ident: string | null;
  pilot: string;
  glider: string;
  date: string | null;
  startLocal: string;
  rate: number;
  speedKmh: number;
  sabotage: "none" | "day" | "place";
  /**
   * Land out this far along the optimised course. Null flies the whole task —
   * or, on an open-distance task, the engine's default open distance.
   */
  landOutKm: number | null;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    open: false, comp: null, task: null, out: null, submit: false,
    identKind: "civl_id", ident: null, landOutKm: null,
    pilot: "Forge Test Pilot", glider: "Moyes RX 3.5",
    date: null, startLocal: "12:30", rate: 2, speedKmh: 42, sabotage: "none",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--open": o.open = true; break;
      case "--comp": o.comp = next(); break;
      case "--task": o.task = next(); break;
      case "--out": o.out = next(); break;
      case "--submit": o.submit = true; break;
      case "--ident-kind": o.identKind = next(); break;
      case "--ident": o.ident = next(); break;
      case "--pilot": o.pilot = next(); break;
      case "--glider": o.glider = next(); break;
      case "--date": o.date = next(); break;
      case "--start": o.startLocal = next(); break;
      case "--rate": o.rate = Number(next()); break;
      case "--speed": o.speedKmh = Number(next()); break;
      case "--sabotage": o.sabotage = next() as Options["sabotage"]; break;
      case "--land-out": o.landOutKm = Number(next()); break;
      case "--help": case "-h": usage(); process.exit(0);
      default:
        if (a.startsWith("--")) { console.error(`Unknown option ${a}`); usage(); process.exit(2); }
    }
  }
  return o;
}

function usage() {
  console.log(`
Forge an IGC tracklog that flies a real task.

  --open                  List the competitions open for submission now
  --task <sqid>           Task to fly (required unless --open)
  --comp <sqid>           Competition, if the task id alone is ambiguous
  --out <path>            Write the .igc here
  --submit                Submit it anonymously instead of writing a file
  --ident <value>         Identifier to submit as (with --submit)
  --ident-kind <kind>     civl_id (default) | email | safa_id | ...
  --pilot <name>          Name written into the file's header
  --glider <type>         Glider written into the file's header
  --date <YYYY-MM-DD>     Override the task's own date
  --start <HH:MM>         Local take-off time (default 12:30)
  --speed <km/h>          Cruise ground speed (default 42)
  --rate <seconds>        Fix interval (default 2)
  --land-out <km>         Land out this far along the optimised course
                          (default: fly the whole task, i.e. make goal).
                          On an open-distance task there is no course: this is
                          how far beyond the take-off cylinder the pilot lands,
                          on a random bearing, up to 250 km (default 80).
  --sabotage day|place    Deliberately fail a HARD track-quality check
`);
}

// ── the API ───────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

interface OpenComp {
  comp_id: string; name: string; timezone: string | null; suggested_task_id: string;
  tasks: { task_id: string; name: string; task_date: string }[];
}

async function listOpen(): Promise<OpenComp[]> {
  const body = await getJson<{ comps: OpenComp[] }>("/api/comp/open-now");
  return body.comps;
}

/** Find which open competition holds a task id, so --comp is usually optional. */
async function locateTask(taskId: string, compHint: string | null) {
  if (compHint) return compHint;
  for (const comp of await listOpen()) {
    if (comp.tasks.some((t) => t.task_id === taskId)) return comp.comp_id;
  }
  throw new Error(
    `Could not find task ${taskId} in any competition open for submission. ` +
    `Pass --comp <sqid>, or run --open to see what is flying.`
  );
}

// ── main ──────────────────────────────────────────────────────────────────

const o = parseArgs(process.argv.slice(2));

if (o.open) {
  const comps = await listOpen();
  if (comps.length === 0) {
    console.log("Nothing is open for submission right now.");
    console.log("A competition qualifies when it is not closed, has open_igc_upload on,");
    console.log("and has a task dated within two days of today.");
    process.exit(0);
  }
  for (const c of comps) {
    console.log(`\n${c.name}  (${c.comp_id})   ${c.timezone ?? "no timezone"}`);
    for (const t of c.tasks) {
      const star = t.task_id === c.suggested_task_id ? " ←" : "";
      console.log(`  ${t.task_id.padEnd(8)} ${t.task_date}  ${t.name}${star}`);
    }
  }
  console.log("\n← the task this competition suggests for a submission today\n");
  process.exit(0);
}

if (!o.task) { console.error("Need --task <sqid> (or --open to list them)."); usage(); process.exit(2); }

const compId = await locateTask(o.task, o.comp);
const task = await getJson<{ name: string; task_date: string; xctsk: XCTask | null }>(
  `/api/comp/${compId}/task/${o.task}`
);
const comp = await getJson<{ name: string; timezone: string | null; category: string }>(
  `/api/comp/${compId}`
);

if (!task.xctsk) throw new Error(`"${task.name}" has no route defined yet — nothing to fly.`);

const taskDate = o.date ?? task.task_date;
const zone = comp.timezone ?? "UTC";
const offset = zoneOffsetHours(taskDate, zone);

// The forging itself lives in the engine (web/engine/src/forge-igc.ts), so the
// dialog on the task page and this script cannot drift into making different
// files. Everything below is the CLI's own job: fetching, reporting, sending.
const { text, fixCount, courseMeters, taskMeters, openDistance } = forgeIgc(task.xctsk, {
  stopAfterMeters: o.landOutKm == null ? null : o.landOutKm * 1000,
  pilot: o.pilot,
  glider: o.glider,
  startSec: startSecondsFor(o.startLocal, taskDate, zone),
  rate: o.rate,
  speedKmh: o.speedKmh,
  headerDate: new Date(`${taskDate}T00:00:00Z`),
  sabotage: o.sabotage,
});
const gz = gzipSync(Buffer.from(text));

// ── verify against the very engine the worker will run ────────────────────

const igc = parseIGC(text);
const summary = summariseFlight(igc);
const quality = assessTrackQuality(igc.fixes, igc.header, {
  task: task.xctsk,
  taskDate,
  timeZone: comp.timezone ?? undefined,
  category: comp.category === "pg" ? "pg" : "hg",
});

const shapeOk = text[0] === "A" && text.includes("HFDTE");
const hrs = Math.floor((summary.durationSeconds ?? 0) / 3600);
const mins = Math.round(((summary.durationSeconds ?? 0) % 3600) / 60);

console.log(`\n${comp.name} · ${task.name} · ${taskDate} (${zone}, UTC${offset >= 0 ? "+" : ""}${offset})`);
// An open-distance task has no course and no goal to be short of, so the same
// numbers would read as a land-out 170 km short of a goal that does not exist.
console.log(
  openDistance
    ? `  take off ${o.startLocal} local · ${(courseMeters / 1000).toFixed(1)} km of open distance, off in a random direction\n`
    : `  take off ${o.startLocal} local · ${(courseMeters / 1000).toFixed(1)} km of ${(taskMeters / 1000).toFixed(1)} km flown${courseMeters >= taskMeters ? " (goal)" : " (landed out)"}\n`
);
console.log(`  flight        ${summary.flightDate}  ${hrs}h ${String(mins).padStart(2, "0")}m airborne`);
console.log(`  track         ${((summary.trackLengthMeters ?? 0) / 1000).toFixed(1)} km, top ${summary.maxAltitudeMeters} m`);
console.log(`  file          ${fixCount.toLocaleString()} fixes · ${(text.length / 1024).toFixed(0)} KB · ${(gz.length / 1024).toFixed(0)} KB gzipped`);
console.log(`  shape (SEC-04) ${shapeOk ? "ok" : "FAILS"}`);
console.log(`  quality       ${quality.hardFailed ? "HARD FAIL" : quality.findings.length ? "flagged" : "clean"}`);
for (const f of quality.findings) console.log(`    [${f.severity}] ${f.title}`);

if (!shapeOk) { console.error("\nRefusing to go on: the file would be rejected on upload."); process.exit(1); }
if (o.sabotage === "none" && quality.hardFailed) {
  console.error("\nRefusing to go on: this was meant to be a clean file but it fails a HARD check.");
  process.exit(1);
}

// ── deliver ───────────────────────────────────────────────────────────────

if (o.submit) {
  if (!o.ident) { console.error("\n--submit needs --ident <value> (and --ident-kind if not civl_id)."); process.exit(2); }
  const res = await fetch(`${API}/api/comp/${compId}/task/${o.task}/igc/open-submit`, {
    method: "POST",
    headers: {
      "x-pilot-ident-kind": o.identKind,
      "x-pilot-ident": encodeURIComponent(o.ident),
      "content-type": "application/octet-stream",
    },
    body: gz,
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`\nSubmission refused (${res.status} ${body.code ?? ""}): ${body.error}`);
    if (Array.isArray(body.organisers) && body.organisers.length) {
      console.error(`  Ask: ${(body.organisers as { name: string; email: string }[]).map((x) => `${x.name} <${x.email}>`).join(", ")}`);
    }
    process.exit(1);
  }
  console.log(`\nSubmitted for ${body.pilot_name} (matched on ${body.matched_on})`);
  console.log(`  ${body.replaced ? "replaced their existing track" : "first track for this task"}`);
  console.log(`  report card: /comp/${compId}/task/${o.task}/pilot/${body.comp_pilot_id}`);
} else if (o.out) {
  writeFileSync(o.out, text);
  console.log(`\nWrote ${o.out}`);
} else {
  console.log("\nNothing to do — pass --out <path> to save it, or --submit to send it.");
}
