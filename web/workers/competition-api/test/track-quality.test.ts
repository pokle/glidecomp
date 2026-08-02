/**
 * Track data-quality on the read path: a tracklog that a HARD check withholds
 * (engine track-quality.ts, FAI S7A §4.4.2) must be kept out of scoring, out
 * of field analysis and out of the 3D replay WITHOUT deleting the pilot from
 * the results, and without costing the rest of the field their points.
 */
import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  request,
  authRequest,
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
  SAMPLE_TASK_DATE,
} from "./helpers";

async function compressText(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function sampleIgcEntries(): Array<[string, string]> {
  const files = JSON.parse(env.SAMPLE_IGC_FILES) as Record<string, string>;
  return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The same real flight, restamped ten days later. This is the shape of the
 * track that prompted the feature (a New Zealand flight submitted to a
 * Corryong task) reduced to its decisive property: no fix falls anywhere near
 * the task's day.
 */
function restampedTenDaysLater(igcText: string): string {
  return igcText.replace(/^HFDTE050126/m, "HFDTE150126");
}

interface ScoreBody {
  stale: boolean;
  classes: Array<{
    pilot_class: string;
    task_validity: { launch: number; distance: number; time: number; task: number };
    pilots: Array<{
      rank: number;
      comp_pilot_id: string;
      pilot_name: string;
      total_score: number;
      flown_distance: number;
      track_excluded?: { reasons: string[] } | null;
    }>;
  }>;
}

async function getFreshScores(path: string): Promise<ScoreBody> {
  for (let attempt = 0; ; attempt++) {
    const res = await request("GET", path);
    expect(res.status).toBe(200);
    const data = (await res.json()) as ScoreBody;
    if (data.stale === false) return data;
    if (attempt >= 50) throw new Error(`scores at ${path} still stale after polling`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The registered test users, one uploaded track each (see vitest.config.ts). */
const USERS = ["user-1", "user-2", "user-3"];

/** Upload `good` sound tracks plus, optionally, one restamped bad one. */
async function seedTask(opts: { good: number; bad: boolean }) {
  const compId = await createComp({ category: "hg" });
  const taskId = await createTask(compId, {
    xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
    pilot_classes: ["open"],
  });

  const entries = sampleIgcEntries();
  for (let i = 0; i < opts.good; i++) {
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(entries[i][1]),
      { user: USERS[i] }
    );
    expect(res.status).toBe(201);
  }
  if (opts.bad) {
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(restampedTenDaysLater(entries[opts.good][1])),
      { user: USERS[opts.good] }
    );
    expect(res.status).toBe(201);
  }
  return { compId, taskId };
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

/**
 * The `if (!quality?.hardFailed)` guard around applyStatusOnTrackUpload.
 *
 * Every other upload test uses a fixture with no B records, so
 * assessUploadedTrack returns null and this guard is only ever exercised in
 * its "quality is absent" form. These are the tests that actually run it in
 * its "quality says no" form — the one the source comment says would
 * otherwise "destroy a real result on the strength of a rejected upload".
 */
describe("a rejected tracklog must not claim the pilot flew", () => {
  async function onlyTaskDbId(): Promise<number> {
    const row = await env.DB.prepare("SELECT task_id FROM task").first<{
      task_id: number;
    }>();
    return row!.task_id;
  }

  test("does not stamp Landed", async () => {
    const compId = await createComp({ category: "hg" });
    const taskId = await createTask(compId, {
      xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
      pilot_classes: ["open"],
    });
    const entries = sampleIgcEntries();

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(restampedTenDaysLater(entries[0][1])),
      { user: "user-1" }
    );
    expect(res.status).toBe(201);
    // The file IS stored and IS reported as hard-failed on the wire.
    const body = (await res.json()) as {
      track_quality: { hard_failed: boolean; findings: { id: string }[] };
    };
    expect(body.track_quality.hard_failed).toBe(true);
    expect(body.track_quality.findings.map((f) => f.id)).toContain("wrong-day");

    // …but it is not evidence that this pilot flew this task.
    const status = await env.DB.prepare(
      "SELECT status_key FROM task_pilot_status WHERE task_id = ?"
    )
      .bind(await onlyTaskDbId())
      .first<{ status_key: string }>();
    expect(status).toBeNull();
  });

  test("does not supersede a scorekeeper's manual flight", async () => {
    const compId = await createComp({ category: "hg" });
    const taskId = await createTask(compId, {
      xctsk: JSON.parse(env.SAMPLE_TASK_XCTSK),
      pilot_classes: ["open"],
    });

    // user-1 joins and gets a manual flight recorded by the scorekeeper.
    const entries = sampleIgcEntries();
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(entries[0][1]),
      { user: "user-1" }
    );
    const roster = (await (
      await request("GET", `/api/comp/${compId}/pilot`)
    ).json()) as { pilots: { comp_pilot_id: string; name: string }[] };
    const me = roster.pilots[0];

    const manualRes = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${me.comp_pilot_id}`,
      { last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15 }
    );
    expect(manualRes.status).toBe(200);

    // Now the same pilot uploads a tracklog from another day.
    const bad = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(restampedTenDaysLater(entries[1][1])),
      { user: "user-1" }
    );
    expect(bad.status).toBe(200); // a replacement

    // The manual flight is the real result and must still be the active one.
    const manual = await env.DB.prepare(
      "SELECT active FROM task_manual_flight ORDER BY rowid DESC LIMIT 1"
    ).first<{ active: number }>();
    expect(manual?.active).toBe(1);
  });
});

describe("hard-failed tracks in the standings", () => {
  // THE regression guard. Before the standings fix, removing a track from
  // scoring removed its pilot from the results entirely: uploading a track
  // auto-stamps the pilot "Landed", which counts in neither numFlying nor
  // numDNF, so they appeared in no pilots[] array at all and their score page
  // 404'd. A withheld pilot must hold a place, at zero, with a reason.
  test("the pilot stays in the results, last, at zero, with reasons", async () => {
    const { compId, taskId } = await seedTask({ good: 2, bad: true });
    const data = await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);

    const open = data.classes.find((c) => c.pilot_class === "open")!;
    expect(open.pilots).toHaveLength(3);

    const withheld = open.pilots.filter((p) => p.track_excluded);
    expect(withheld).toHaveLength(1);
    expect(withheld[0].rank).toBe(3);
    expect(withheld[0].total_score).toBe(0);
    expect(withheld[0].flown_distance).toBe(0);
    expect(withheld[0].track_excluded!.reasons).toContain("Track is from a different day");

    // Ranks stay sequential from 1 with the withheld pilot seated last.
    expect(open.pilots.map((p) => p.rank)).toEqual([1, 2, 3]);
    for (const p of open.pilots.slice(0, 2)) expect(p.track_excluded ?? null).toBeNull();
  });

  // The blast-radius guarantee: an automatic heuristic must not be able to
  // move anyone else's points. If a withheld pilot counted toward S7F §9.1
  // "pilots present", one false positive would cut the whole field's score.
  test("withholding a track leaves the rest of the field's scores untouched", async () => {
    const withBad = await seedTask({ good: 2, bad: true });
    const badData = await getFreshScores(
      `/api/comp/${withBad.compId}/task/${withBad.taskId}/score`
    );

    await clearCompData();
    const listed = await env.R2.list();
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));

    const clean = await seedTask({ good: 2, bad: false });
    const cleanData = await getFreshScores(
      `/api/comp/${clean.compId}/task/${clean.taskId}/score`
    );

    const withBadOpen = badData.classes.find((c) => c.pilot_class === "open")!;
    const cleanOpen = cleanData.classes.find((c) => c.pilot_class === "open")!;

    expect(withBadOpen.task_validity).toEqual(cleanOpen.task_validity);
    expect(withBadOpen.pilots.filter((p) => !p.track_excluded).map((p) => p.total_score)).toEqual(
      cleanOpen.pilots.map((p) => p.total_score)
    );
  });

  test("a class whose only track is withheld still seats that pilot", async () => {
    const { compId, taskId } = await seedTask({ good: 0, bad: true });
    const data = await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);
    const open = data.classes.find((c) => c.pilot_class === "open")!;
    expect(open.pilots).toHaveLength(1);
    expect(open.pilots[0].total_score).toBe(0);
    expect(open.pilots[0].track_excluded!.reasons.length).toBeGreaterThan(0);
  });

  // S7A §4.4.6 makes rejection the organiser's call, so the automatic verdict
  // has to be overrulable — and overruling it must restore a real score.
  test("a scorekeeper override puts the track back into scoring", async () => {
    const { compId, taskId } = await seedTask({ good: 2, bad: true });
    const before = await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);
    const withheld = before.classes
      .find((c) => c.pilot_class === "open")!
      .pilots.find((p) => p.track_excluded)!;

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${withheld.comp_pilot_id}/quality-override`,
      { quality_override: true }
    );
    expect(res.status).toBe(200);

    const data = await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);
    const open = data.classes.find((c) => c.pilot_class === "open")!;
    expect(open.pilots).toHaveLength(3);
    expect(open.pilots.some((p) => p.track_excluded)).toBe(false);
    // It scores like any other short flight — the S7F §5.3 minimum distance,
    // which is exactly what the rules require for a pilot who took off.
    expect(open.pilots.some((p) => p.total_score > 0)).toBe(true);
  });
});

describe("the quality cache interlock", () => {
  // A warm scoring row with a cold quality row must NOT short-circuit the R2
  // read, or the verdict would never be learned and the track would score
  // forever unassessed.
  test("a verdict is stored once, and relearned if its row is dropped", async () => {
    const { compId, taskId } = await seedTask({ good: 2, bad: true });
    await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM track_analysis WHERE variant = 'quality'"
    ).first<{ n: number }>();
    expect(stored!.n).toBe(3);

    // Drop only the quality rows, leaving the scoring analyses warm. That is
    // the interlock: a warm "gap" row must not let the pass skip the R2 read,
    // or the verdict would never be relearned and the track would silently
    // start scoring again.
    await env.DB.prepare("DELETE FROM track_analysis WHERE variant = 'quality'").run();
    await env.DB.prepare("UPDATE task_scores SET inputs_rev = inputs_rev + 1").run();

    const again = await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);
    const open = again.classes.find((c) => c.pilot_class === "open")!;
    expect(open.pilots.filter((p) => p.track_excluded)).toHaveLength(1);

    const relearned = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM track_analysis WHERE variant = 'quality'"
    ).first<{ n: number }>();
    expect(relearned!.n).toBe(3);
  });
});

/**
 * The replay is a visualisation of the day, so a track that is not this
 * flight must not be drawn any more than it may be scored. It is not merely
 * an extra dot: the packed bundle's bounds and clock come from the tracks in
 * it, so ONE withheld track sets the whole scene's scale and the whole
 * timeline. A real one (a New Zealand flight on a Corryong task, ten days
 * off) took a task's scene extent to 2,225 km against a 28 km field and its
 * replay clock to 243 hours against a 6-hour day — every pilot drawn into
 * five pixels, on a scrubber where the task was 2% of the travel.
 */
describe("hard-failed tracks in the 3D replay bundle", () => {
  /** `[uint32 LE manifestLen][manifest JSON][gzipped data]` — see visualization.ts. */
  async function fetchManifest(compId: string, taskId: string) {
    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/3dvis`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    const len = new DataView(buf).getUint32(0, true);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as {
      t0: number;
      t1: number;
      pilots: { name: string }[];
    };
  }

  test("the withheld track is not packed, and does not stretch the clock", async () => {
    const withBad = await seedTask({ good: 2, bad: true });
    // The verdict is learned on the scoring pass; the bundle reads it from D1.
    await getFreshScores(`/api/comp/${withBad.compId}/task/${withBad.taskId}/score`);
    const packed = await fetchManifest(withBad.compId, withBad.taskId);

    expect(packed.pilots).toHaveLength(2);
    // The decisive property: the clock spans one flying day, not the ten-day
    // gap to the restamped track. Without the fix this is >200 hours.
    expect((packed.t1 - packed.t0) / 3600).toBeLessThan(24);
  });

  test("the two good tracks pack identically with or without the bad one", async () => {
    const withBad = await seedTask({ good: 2, bad: true });
    await getFreshScores(`/api/comp/${withBad.compId}/task/${withBad.taskId}/score`);
    const dirty = await fetchManifest(withBad.compId, withBad.taskId);

    await clearCompData();
    const listed = await env.R2.list();
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));

    const clean = await seedTask({ good: 2, bad: false });
    await getFreshScores(`/api/comp/${clean.compId}/task/${clean.taskId}/score`);
    const pure = await fetchManifest(clean.compId, clean.taskId);

    // Same field, same clock: the withheld track changed nothing for anyone.
    expect(dirty.pilots.map((p) => p.name)).toEqual(pure.pilots.map((p) => p.name));
    expect(dirty.t1 - dirty.t0).toBe(pure.t1 - pure.t0);
  });

  // S7A §4.4.6: the organiser's call overrules the heuristic here too, and the
  // cache key has to carry it or the bundle it was cut from would be served on.
  test("a scorekeeper override puts the track back into the replay", async () => {
    const { compId, taskId } = await seedTask({ good: 2, bad: true });
    const before = await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);
    expect(await fetchManifest(compId, taskId)).toHaveProperty("pilots.length", 2);

    const withheld = before.classes
      .find((c) => c.pilot_class === "open")!
      .pilots.find((p) => p.track_excluded)!;
    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${withheld.comp_pilot_id}/quality-override`,
      { quality_override: true }
    );
    expect(res.status).toBe(200);

    expect(await fetchManifest(compId, taskId)).toHaveProperty("pilots.length", 3);
  });
});
