/**
 * The seams between the competition server and the engine that the engine
 * code review of 2026-10-20 found leaking (findings 2.1–2.5): which mutations
 * mark scores stale, what a file holding no flight does to the scores, how a
 * withheld upload sits beside a pilot's other evidence, what the ETag
 * identifies, and how published ranks tie.
 *
 * Tracks, statuses and manual flights are seeded with direct D1 + R2 writes
 * (no route schedules a background re-score), and every compute is an
 * explicitly awaited call — except where a test is ABOUT a route.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { authRequest, createComp, createTask, clearCompData, request } from "./helpers";
import { decodeId, encodeId } from "../src/sqids";
import {
  bumpScoreInputs,
  computeAndStoreTaskScore,
  readTaskScoreRow,
  taskIdsForPilots,
} from "../src/score-store";
import { computeTaskScore } from "../src/scoring";

const NOW = "2026-01-05T00:00:00Z";

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sampleIgcs(): string[] {
  const files = JSON.parse(env.SAMPLE_IGC_FILES) as Record<string, string>;
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text);
}

/** The same real flight, ten days later — a HARD `wrong-day` verdict. */
function tenDaysLater(igc: string): string {
  return igc.replace(/^HFDTE050126/m, "HFDTE150126");
}

/** A file the upload check accepts that holds no flight: header, no fixes. */
const HEADER_ONLY_IGC = "AXCT001Test\r\nHFDTE050126\r\n";

interface Seeded {
  compId: string;
  taskId: string;
  compIdNum: number;
  taskIdNum: number;
  scorePath: string;
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

/** A comp (user-1 admin) and one task over the bundled sample route. */
async function seedTask(category: "hg" | "pg" = "hg"): Promise<Seeded> {
  const compId = await createComp({ category });
  const taskId = await createTask(compId, {
    xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
    pilot_classes: ["open"],
  });
  return {
    compId,
    taskId,
    compIdNum: decodeId(env.SQIDS_ALPHABET, compId)!,
    taskIdNum: decodeId(env.SQIDS_ALPHABET, taskId)!,
    scorePath: `/api/comp/${compId}/task/${taskId}/score`,
  };
}

async function addPilot(t: Seeded, name: string): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO comp_pilot (comp_id, registered_pilot_name, pilot_class) VALUES (?, ?, 'open')`
  )
    .bind(t.compIdNum, name)
    .run();
  return res.meta.last_row_id;
}

/** Store raw (already-gzipped) bytes as this pilot's active track. */
async function addTrackBytes(t: Seeded, cp: number, bytes: Uint8Array): Promise<void> {
  const key = `c/${t.compIdNum}/t/${t.taskIdNum}/${cp}.igc`;
  await env.R2.put(key, bytes);
  await env.DB.prepare(
    `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(t.taskIdNum, cp, key, NOW, bytes.byteLength)
    .run();
}

async function addTrack(t: Seeded, cp: number, igc: string): Promise<void> {
  await addTrackBytes(t, cp, await gzip(igc));
}

async function setDnf(t: Seeded, cp: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO task_pilot_status (comp_id, task_id, comp_pilot_id, status_key, set_by_name, set_at)
     VALUES (?, ?, ?, 'dnf', 'Test', ?)`
  )
    .bind(t.compIdNum, t.taskIdNum, cp, NOW)
    .run();
}

/** An active manual flight that reached the first turnpoint and landed there. */
async function addManualFlight(t: Seeded, cp: number): Promise<void> {
  const xctsk = JSON.parse(env.SAMPLE_TASK_XCTSK) as {
    turnpoints: { waypoint: { lat: number; lon: number } }[];
  };
  const { lat, lon } = xctsk.turnpoints[0].waypoint;
  await env.DB.prepare(
    `INSERT INTO task_manual_flight
       (task_id, comp_pilot_id, last_reached_tp_index, landing_lat, landing_lon, set_by_name, set_at)
     VALUES (?, ?, 0, ?, ?, 'Test', ?)`
  )
    .bind(t.taskIdNum, cp, lat, lon, NOW)
    .run();
}

/** Bump, then compute and store at the new inputs revision: the write is
 * guaranteed to land (a background compute the seeding routes scheduled may
 * already hold the old revision) and the stored body reads as fresh. */
async function storeFresh(t: Seeded): Promise<void> {
  await bumpScoreInputs(env.DB, [t.taskIdNum]);
  const rev = (await readTaskScoreRow(env.DB, t.taskIdNum))!.inputs_rev;
  await computeAndStoreTaskScore(env, t.taskIdNum, rev);
}

async function score(t: Seeded) {
  const res = await computeTaskScore(t.taskIdNum, env.DB, env.R2, env.SQIDS_ALPHABET);
  return res.classes.find((c) => c.pilot_class === "open")!;
}

function conditionalGet(path: string, etag: string): Promise<Response> {
  return SELF.fetch(`https://test${path}`, { headers: { "If-None-Match": etag } });
}

describe("2.1 — a DNF-only pilot is a scoring input", () => {
  test("taskIdsForPilots finds a task through a status row alone", async () => {
    const t = await seedTask();
    const dnf = await addPilot(t, "Dee En Eff");
    await setDnf(t, dnf);
    expect(await taskIdsForPilots(env.DB, [dnf])).toEqual([t.taskIdNum]);
  });

  test("more pilots than D1's 100-parameter cap allows in one statement", async () => {
    const t = await seedTask();
    const ids: number[] = [];
    for (let i = 0; i < 120; i++) ids.push(await addPilot(t, `Pilot ${i}`));
    await setDnf(t, ids[119]);
    expect(await taskIdsForPilots(env.DB, ids)).toEqual([t.taskIdNum]);
  });

  test("deleting a DNF pilot marks the scores stale and moves launch validity", async () => {
    const t = await seedTask();
    const igcs = sampleIgcs();
    await addTrack(t, await addPilot(t, "Flyer One"), igcs[0]);
    await addTrack(t, await addPilot(t, "Flyer Two"), igcs[1]);
    const dnf = await addPilot(t, "Dee En Eff");
    await setDnf(t, dnf);
    expect((await score(t)).validity_inputs!.num_present).toBe(3);
    await storeFresh(t);
    const revBefore = (await readTaskScoreRow(env.DB, t.taskIdNum))!.inputs_rev;

    const del = await authRequest(
      "DELETE",
      `/api/comp/${t.compId}/pilot/${encodeId(env.SQIDS_ALPHABET, dnf)}`
    );
    expect(del.status).toBe(200);

    expect((await readTaskScoreRow(env.DB, t.taskIdNum))!.inputs_rev).toBeGreaterThan(revBefore);
    expect((await score(t)).validity_inputs!.num_present).toBe(2);
  });
});

describe("2.2 — a file that holds no flight seats its pilot, never deletes them", () => {
  test("header-only and corrupt files are withheld at 0 with a reason", async () => {
    const t = await seedTask();
    const igcs = sampleIgcs();
    await addTrack(t, await addPilot(t, "Flyer One"), igcs[0]);
    await addTrack(t, await addPilot(t, "Flyer Two"), igcs[1]);
    await addTrack(t, await addPilot(t, "Header Only"), HEADER_ONLY_IGC);
    await addTrackBytes(t, await addPilot(t, "Not Gzip"), new TextEncoder().encode("garbage"));

    const open = await score(t);
    expect(open.pilots.map((p) => p.pilot_name).slice(0, 2).sort()).toEqual([
      "Flyer One",
      "Flyer Two",
    ]);
    const withheld = open.pilots.filter((p) => p.track_excluded);
    expect(withheld.map((p) => p.pilot_name).sort()).toEqual(["Header Only", "Not Gzip"]);
    for (const p of withheld) {
      expect(p.total_score).toBe(0);
      expect(p.track_excluded!.reasons).toEqual(["Track holds no flight"]);
    }
    // They count as neither flying nor present (the withheld-track rule).
    expect(open.validity_inputs!.num_flying).toBe(2);
  });

  test("the verdict is remembered, and a scorekeeper override cannot score nothing", async () => {
    const t = await seedTask();
    const cp = await addPilot(t, "Header Only");
    await addTrack(t, cp, HEADER_ONLY_IGC);
    await score(t);
    const stored = await env.DB.prepare(
      `SELECT payload_json FROM track_analysis WHERE variant = 'quality'`
    ).first<{ payload_json: string }>();
    expect(JSON.parse(stored!.payload_json).hardFailed).toBe(true);

    await env.DB.prepare("UPDATE task_track SET quality_override = 1").run();
    const open = await score(t);
    expect(open.pilots).toHaveLength(1);
    expect(open.pilots[0].track_excluded!.reasons).toEqual(["Track holds no flight"]);
  });

  test("an upload with no fixes neither marks Landed nor supersedes a manual flight", async () => {
    const t = await seedTask();
    const cp = await addPilot(t, "Manual Mo");
    await addManualFlight(t, cp);
    const res = await SELF.fetch(
      `https://test/api/comp/${t.compId}/task/${t.taskId}/igc/${encodeId(env.SQIDS_ALPHABET, cp)}`,
      {
        method: "POST",
        headers: { Cookie: "better-auth.test-user=user-1" },
        body: await gzip(HEADER_ONLY_IGC),
      }
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { track_quality: { hard_failed: boolean } };
    expect(body.track_quality.hard_failed).toBe(true);

    const manual = await env.DB.prepare("SELECT active FROM task_manual_flight").first<{
      active: number;
    }>();
    expect(manual!.active).toBe(1);
    const status = await env.DB.prepare("SELECT status_key FROM task_pilot_status").first();
    expect(status).toBeNull();
  });
});

describe("2.3 — a withheld upload beside the pilot's other evidence", () => {
  test("a manual flight stays the pilot's one entry", async () => {
    const t = await seedTask();
    const igcs = sampleIgcs();
    await addTrack(t, await addPilot(t, "Flyer One"), igcs[0]);
    const cp = await addPilot(t, "Manual Mo");
    await addManualFlight(t, cp);
    await addTrack(t, cp, tenDaysLater(igcs[1]));

    const open = await score(t);
    const mine = open.pilots.filter((p) => p.pilot_name === "Manual Mo");
    expect(mine).toHaveLength(1);
    expect(mine[0].track_excluded).toBeNull();
    expect(open.pilots).toHaveLength(2);
  });

  test("a DNF still counts in launch validity", async () => {
    const t = await seedTask();
    const igcs = sampleIgcs();
    await addTrack(t, await addPilot(t, "Flyer One"), igcs[0]);
    await addTrack(t, await addPilot(t, "Flyer Two"), igcs[1]);
    const dnf = await addPilot(t, "Dee En Eff");
    await setDnf(t, dnf);
    const clean = await score(t);

    await addTrack(t, dnf, tenDaysLater(igcs[2]));
    const withUpload = await score(t);
    expect(withUpload.validity_inputs!.num_present).toBe(3);
    // The blast-radius guarantee: everyone else's points are unmoved.
    expect(withUpload.task_validity).toEqual(clean.task_validity);
    const scored = (c: typeof clean) =>
      c.pilots.filter((p) => !p.track_excluded).map((p) => [p.pilot_name, p.total_score]);
    expect(scored(withUpload)).toEqual(scored(clean));
    // …and the DNF pilot's file is seated, withheld, with its reason.
    const seat = withUpload.pilots.find((p) => p.pilot_name === "Dee En Eff")!;
    expect(seat.track_excluded!.reasons).toContain("Track is from a different day");
  });
});

describe("2.4 — the ETag identifies the served body", () => {
  test("a gap_params change re-scores to a new ETag; the old one no longer 304s", async () => {
    const t = await seedTask();
    const igcs = sampleIgcs();
    await addTrack(t, await addPilot(t, "Flyer One"), igcs[0]);
    await addTrack(t, await addPilot(t, "Flyer Two"), igcs[1]);
    await storeFresh(t);

    const first = await request("GET", t.scorePath);
    const etag = first.headers.get("ETag")!;
    const compPath = `/api/comp/${t.compId}/scores`;
    const compEtag = (await request("GET", compPath)).headers.get("ETag")!;
    const stateKey = (await readTaskScoreRow(env.DB, t.taskIdNum))!.state_key;

    // gap_params is not in the state key — that is the bug this guards.
    await env.DB.prepare("UPDATE comp SET gap_params = ? WHERE comp_id = ?")
      .bind(JSON.stringify({ nominalGoal: 0.9 }), t.compIdNum)
      .run();
    await storeFresh(t);
    expect((await readTaskScoreRow(env.DB, t.taskIdNum))!.state_key).toBe(stateKey);

    const after = await conditionalGet(t.scorePath, etag);
    expect(after.status).toBe(200);
    const newEtag = after.headers.get("ETag")!;
    const again = await conditionalGet(t.scorePath, newEtag);
    expect(newEtag).not.toBe(etag);
    expect((await conditionalGet(t.scorePath, newEtag)).status).toBe(304);
    expect((await conditionalGet(compPath, compEtag)).status).toBe(200);
  });
});

describe("2.5 — published ranks share ties", () => {
  test("pilots on the same total share the task rank; withheld pilots share theirs", async () => {
    // PG: no arrival points — the engine hands equal ESS times different
    // arrival positions by input order (review §9.5, an open question) — so
    // the same flight twice is an exact tie.
    const t = await seedTask("pg");
    const igcs = sampleIgcs();
    await addTrack(t, await addPilot(t, "Twin A"), igcs[0]);
    await addTrack(t, await addPilot(t, "Twin B"), igcs[0]);
    await addTrack(t, await addPilot(t, "Withheld A"), tenDaysLater(igcs[1]));
    await addTrack(t, await addPilot(t, "Withheld B"), HEADER_ONLY_IGC);

    const open = await score(t);
    expect(open.pilots.map((p) => p.rank)).toEqual([1, 1, 3, 3]);
  });
});
