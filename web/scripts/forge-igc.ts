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
  parseXCTask,
  assessTrackQuality,
  summariseFlight,
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
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    open: false, comp: null, task: null, out: null, submit: false,
    identKind: "civl_id", ident: null,
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
  --sabotage day|place    Deliberately fail a HARD track-quality check
`);
}

// ── geometry ──────────────────────────────────────────────────────────────

interface Pt { lat: number; lon: number }
const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

function dist(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const la1 = rad(a.lat), la2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function towards(p: Pt, q: Pt, metres: number): Pt {
  const total = dist(p, q);
  if (total < 1) return { lat: p.lat, lon: p.lon };
  const f = metres / total;
  return { lat: p.lat + (q.lat - p.lat) * f, lon: p.lon + (q.lon - p.lon) * f };
}

// ── IGC encoding (matches the engine's B_RECORD_RE) ───────────────────────

function encLat(v: number): string {
  const h = v < 0 ? "S" : "N";
  v = Math.abs(v);
  const d = Math.floor(v);
  return String(d).padStart(2, "0") + String(Math.round((v - d) * 60 * 1000)).padStart(5, "0") + h;
}
function encLon(v: number): string {
  const h = v < 0 ? "W" : "E";
  v = Math.abs(v);
  const d = Math.floor(v);
  return String(d).padStart(3, "0") + String(Math.round((v - d) * 60 * 1000)).padStart(5, "0") + h;
}
const encAlt = (a: number) => String(Math.min(Math.max(0, Math.round(a)), 99999)).padStart(5, "0");
const hhmmss = (s: number) => {
  s = ((s % 86400) + 86400) % 86400;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60)]
    .map((n) => String(n).padStart(2, "0")).join("");
};

// ── the flight ────────────────────────────────────────────────────────────

interface Turnpoint extends Pt { radius: number; alt: number; name: string }
interface Fix extends Pt { t: number; alt: number }

/**
 * Launch, climb out, then leg by leg: glide towards the next turnpoint,
 * thermal back up when it gets low, and enter each cylinder. Finishes with a
 * descent and a stint on the ground, which is what makes the landing
 * detectable — without it the flight summary has no duration to report.
 */
function buildFlight(tps: Turnpoint[], opts: { rate: number; speedKmh: number; startSec: number }): Fix[] {
  if (tps.length < 2) throw new Error("A task needs at least two turnpoints");

  const step = opts.rate;
  const cruise = opts.speedKmh / 3.6;
  const climbRate = 2.2;      // m/s, an ordinary thermal
  const sink = -1.15;         // m/s on glide
  const groundAlt = tps[0].alt || 500;
  const floor = groundAlt + 350;
  // Clamped absolutely, not just relative to launch: a task whose waypoints
  // carry odd altitudes would otherwise produce a flight topping out in the
  // flight levels, and a fabricated track that nobody believes is no use for
  // testing what a pilot sees.
  const ceiling = Math.min(groundAlt + 1900, 4200);

  const fixes: Fix[] = [];
  let t = opts.startSec;
  let alt = groundAlt;
  let pos: Pt = { lat: tps[0].lat, lon: tps[0].lon };
  const push = () => fixes.push({ t, lat: pos.lat, lon: pos.lon, alt });

  // On the hill. The takeoff detector averages the first ten fixes for its
  // ground altitude, so there has to be a ground to start from.
  for (let i = 0; i < Math.ceil(120 / step); i++) {
    pos = { lat: tps[0].lat + (Math.random() - 0.5) * 2e-5, lon: tps[0].lon + (Math.random() - 0.5) * 2e-5 };
    push(); t += step;
  }

  // Climb-out: clears minAltitudeGain (50 m) and minGroundSpeed (5 m/s), so
  // takeoff is unambiguous.
  const heading = tps.find((tp) => dist(tp, tps[0]) > 50) ?? tps[1];
  while (alt < groundAlt + 600) {
    alt += climbRate * step;
    pos = towards(pos, heading, 8 * step);
    push(); t += step;
    if (t - opts.startSec > 8 * 3600) break;
  }

  let climbing = false;
  for (let i = 1; i < tps.length; i++) {
    const tp = tps[i];
    if (dist(pos, tp) < 30) continue;   // takeoff and SSS are usually one waypoint
    const reach = Math.max(60, tp.radius * 0.55);
    let guard = 0;
    while (dist(pos, tp) > reach && guard++ < 20000) {
      if (climbing) {
        alt += climbRate * step;
        pos = towards(pos, tp, 1.5 * step);   // circling drifts, barely advances
        if (alt >= ceiling) climbing = false;
      } else {
        alt += sink * step;
        pos = towards(pos, tp, cruise * step);
        if (alt <= floor) climbing = true;
      }
      push(); t += step;
    }
  }

  const last = tps[tps.length - 1];
  const landAlt = (last.alt || groundAlt) + 5;
  while (alt > landAlt) {
    alt = Math.max(landAlt, alt + sink * 1.3 * step);
    pos = towards(pos, last, cruise * 0.55 * step);
    push(); t += step;
  }
  for (let i = 0; i < Math.ceil(90 / step); i++) {
    pos = { lat: pos.lat + (Math.random() - 0.5) * 1.5e-5, lon: pos.lon + (Math.random() - 0.5) * 1.5e-5 };
    push(); t += step;
  }

  return fixes;
}

function toIgc(fixes: Fix[], headerDate: Date, o: Options, site: string): string {
  const dd = String(headerDate.getUTCDate()).padStart(2, "0");
  const mm = String(headerDate.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(headerDate.getUTCFullYear() % 100).padStart(2, "0");
  const lines = [
    // Must begin with an A record and contain "HFDTE" — the worker's SEC-04
    // content check rejects anything else before it reaches R2.
    "AXGCFRG GlideComp forge-igc",
    `HFDTE${dd}${mm}${yy}`,
    `HFPLTPILOTINCHARGE:${o.pilot}`,
    `HFGTYGLIDERTYPE:${o.glider}`,
    "HFGIDGLIDERID:FORGE",
    "HFDTMGPSDATUM:WGS-84",
    `HFSITSITE:${site}`,
  ];
  for (const f of fixes) {
    lines.push(`B${hhmmss(f.t)}${encLat(f.lat)}${encLon(f.lon)}A${encAlt(f.alt)}${encAlt(f.alt)}`);
  }
  return lines.join("\r\n") + "\r\n";
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

const tps: Turnpoint[] = task.xctsk.turnpoints.map((tp) => ({
  lat: tp.waypoint.lat,
  lon: tp.waypoint.lon,
  radius: tp.radius || 400,
  alt: tp.waypoint.altSmoothed ?? 500,
  name: tp.waypoint.name,
}));

const taskDate = o.date ?? task.task_date;
const zone = comp.timezone ?? "UTC";

// Take-off is given as a local wall clock; convert it to seconds past the
// header date's UTC midnight using the competition's OWN zone, because that is
// the zone the wrong-day check will judge it in.
function zoneOffsetHours(isoDate: string, timeZone: string): number {
  const probe = new Date(`${isoDate}T12:00:00Z`);
  const asUtc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  const asZone = new Date(probe.toLocaleString("en-US", { timeZone }));
  return Math.round(((asZone.getTime() - asUtc.getTime()) / 3600000) * 2) / 2;
}
const offset = zoneOffsetHours(taskDate, zone);
const [sh, sm] = o.startLocal.split(":").map(Number);
const startSec = sh * 3600 + sm * 60 - offset * 3600;

let fixes = buildFlight(tps, { rate: o.rate, speedKmh: o.speedKmh, startSec });
if (o.sabotage === "place") fixes = fixes.map((f) => ({ ...f, lon: f.lon + 16 }));

const headerDate = new Date(`${taskDate}T00:00:00Z`);
if (o.sabotage === "day") headerDate.setUTCDate(headerDate.getUTCDate() - 14);

const text = toIgc(fixes, headerDate, o, tps[0].name);
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
console.log(`  ${tps.length} turnpoints, take off ${o.startLocal} local\n`);
console.log(`  flight        ${summary.flightDate}  ${hrs}h ${String(mins).padStart(2, "0")}m airborne`);
console.log(`  track         ${((summary.trackLengthMeters ?? 0) / 1000).toFixed(1)} km, top ${summary.maxAltitudeMeters} m`);
console.log(`  file          ${fixes.length.toLocaleString()} fixes · ${(text.length / 1024).toFixed(0)} KB · ${(gz.length / 1024).toFixed(0)} KB gzipped`);
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
