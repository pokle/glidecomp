import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { parseIGC, parseXCTask, scoreTask, calculateOptimizedTaskDistance } from "@glidecomp/engine";
import {
  request,
  authRequest,
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";

/** Compress a string to gzip for upload. */
async function compressText(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(
    new CompressionStream("gzip")
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * GET task/comp scores, waiting out any in-flight background re-score.
 * Stale-first serving means a read right after a mutation may return the
 * pre-mutation body labelled `stale: true` while revalidation runs in the
 * background — poll until the store is fresh before asserting on content.
 */
async function getFreshScores<T extends { stale: boolean }>(
  path: string
): Promise<{ res: Response; data: T }> {
  for (let attempt = 0; ; attempt++) {
    const res = await request("GET", path);
    expect(res.status).toBe(200);
    const data = (await res.json()) as T;
    if (data.stale === false) return { res, data };
    if (attempt >= 50) throw new Error(`scores at ${path} still stale after polling`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Get all sample IGC files as a sorted array of [filename, content] pairs. */
function sampleIgcEntries(): Array<[string, string]> {
  const files = JSON.parse(env.SAMPLE_IGC_FILES) as Record<string, string>;
  return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

describe("Live Scoring", () => {
  test("scores task with real pilots and matches engine output", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp({ category: "hg" });
    const taskId = await createTask(compId, {
      xctsk: taskXctsk,
      pilot_classes: ["open"],
    });

    // Upload a subset of real IGC files (first 3 for test speed)
    const igcEntries = sampleIgcEntries().slice(0, 3);
    const users = ["user-1", "user-2", "user-3"];

    for (let i = 0; i < igcEntries.length; i++) {
      const [, content] = igcEntries[i];
      const user = users[i];
      const res = await uploadRequest(
        `/api/comp/${compId}/task/${taskId}/igc`,
        await compressText(content),
        { user }
      );
      expect(res.status).toBe(201);
    }

    // Call scoring endpoint. Uploads already materialized the scores in the
    // background (compute-on-write), so the read serves the stored row.
    const { res, data } = await getFreshScores<{
      task_id: string;
      computed_at: string;
      stale: boolean;
      classes: Array<{
        pilot_class: string;
        pilots: Array<{
          rank: number;
          pilot_name: string;
          total_score: number;
          made_goal: boolean;
          flown_distance: number;
        }>;
      }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(new Date(data.computed_at).getTime()).not.toBeNaN();

    expect(data.classes).toHaveLength(1);
    const openClass = data.classes[0];
    expect(openClass.pilot_class).toBe("open");
    expect(openClass.pilots.length).toBeGreaterThan(0);

    // Ranks are sequential from 1
    const ranks = openClass.pilots.map((p) => p.rank);
    expect(ranks[0]).toBe(1);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    // Scores are in descending order
    const scores = openClass.pilots.map((p) => p.total_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // Verify against engine ground truth
    const xcTask = parseXCTask(env.SAMPLE_TASK_XCTSK);
    const taskDistance = calculateOptimizedTaskDistance(xcTask);
    const enginePilots = igcEntries.map(([, text]) => {
      const igc = parseIGC(text);
      return {
        pilotName: igc.header.pilot || igc.header.competitionId || "unknown",
        trackFile: "sample.igc",
        fixes: igc.fixes,
      };
    });

    const engineResult = scoreTask(xcTask, enginePilots, {
      nominalDistance: taskDistance * 0.7,
    });

    // API pilot count matches engine result
    expect(openClass.pilots.length).toBe(engineResult.pilotScores.length);

    // Top scorer in API matches top scorer from engine (by totalScore)
    const apiTopScore = openClass.pilots[0].total_score;
    const engineTopScore = engineResult.pilotScores[0].totalScore;
    expect(apiTopScore).toBe(engineTopScore);
  });

  test("repeat requests serve the same stored result with its ETag", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp();
    const taskId = await createTask(compId, {
      xctsk: taskXctsk,
      pilot_classes: ["open"],
    });

    const [, content] = sampleIgcEntries()[0];
    const res0 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(content),
      { user: "user-1" }
    );
    expect(res0.status).toBe(201);

    const { data: body1 } = await getFreshScores(
      `/api/comp/${compId}/task/${taskId}/score`
    );

    // Second request — served from the same materialized row.
    const res2 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Cache")).toBe("HIT");
    const body2 = await res2.json();

    expect(body2).toEqual(body1);
  });

  test("a new upload re-scores in the background; readers never wait", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp();
    const taskId = await createTask(compId, {
      xctsk: taskXctsk,
      pilot_classes: ["open"],
    });

    const igcEntries = sampleIgcEntries();

    // Upload first pilot and let the background compute land.
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[0][1]),
      { user: "user-1" }
    );
    const { data: data1 } = await getFreshScores<{
      stale: boolean;
      classes: Array<{ pilots: unknown[] }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);
    expect(data1.classes[0].pilots).toHaveLength(1);

    // Upload second pilot. Every read stays an instant row read (200) —
    // possibly the pre-upload body labelled stale — until the re-score
    // lands, after which the fresh result includes the new pilot.
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[1][1]),
      { user: "user-2" }
    );

    const { data: data2 } = await getFreshScores<{
      stale: boolean;
      classes: Array<{ pilots: unknown[] }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);
    expect(data2.classes[0].pilots.length).toBeGreaterThan(
      data1.classes[0].pilots.length
    );
  });

  test("penalty reduces pilot score and triggers re-rank", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp();
    const taskId = await createTask(compId, {
      xctsk: taskXctsk,
      pilot_classes: ["open"],
    });

    const igcEntries = sampleIgcEntries();

    const r1 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[0][1]),
      { user: "user-1" }
    );
    const r2 = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[1][1]),
      { user: "user-2" }
    );
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);

    // Score without penalty
    const { data: data1 } = await getFreshScores<{
      stale: boolean;
      classes: Array<{
        pilots: Array<{ rank: number; comp_pilot_id: string; total_score: number }>;
      }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);
    const rank1Pilot = data1.classes[0].pilots.find((p) => p.rank === 1)!;

    // Apply penalty large enough to guarantee a re-rank (pilot drops to 0)
    const penalty = rank1Pilot.total_score + 1;
    await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${rank1Pilot.comp_pilot_id}`,
      { penalty_points: penalty, penalty_reason: "Test penalty" }
    );

    // The penalty edit re-scores in the background; wait for it to land.
    const { data: data2 } = await getFreshScores<{
      stale: boolean;
      classes: Array<{
        pilots: Array<{
          rank: number;
          comp_pilot_id: string;
          total_score: number;
          penalty_points: number;
        }>;
      }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);

    // Penalised pilot's score is reduced
    const penalisedPilot = data2.classes[0].pilots.find(
      (p) => p.comp_pilot_id === rank1Pilot.comp_pilot_id
    )!;
    expect(penalisedPilot.penalty_points).toBe(penalty);
    expect(penalisedPilot.total_score).toBe(0);
    // They are no longer rank 1
    expect(penalisedPilot.rank).toBeGreaterThan(1);
  });

  test("PG leading-points comp: cached-aggregate scoring matches the engine", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    // A paragliding comp with leading (departure) points enabled — the path
    // that caches a per-track leading aggregate instead of re-scanning tracks.
    const gapParams = {
      nominalLaunch: 0.96,
      nominalGoal: 0.3,
      nominalTime: 5400,
      minimumDistance: 5000,
      scoring: "PG" as const,
      useLeading: true,
      useArrival: false,
      leadingFormula: "weighted" as const,
    };
    const compId = await createComp({ category: "pg", gap_params: gapParams });
    const taskId = await createTask(compId, {
      xctsk: taskXctsk,
      pilot_classes: ["open"],
    });

    const igcEntries = sampleIgcEntries().slice(0, 3);
    const users = ["user-1", "user-2", "user-3"];
    for (let i = 0; i < igcEntries.length; i++) {
      const res = await uploadRequest(
        `/api/comp/${compId}/task/${taskId}/igc`,
        await compressText(igcEntries[i][1]),
        { user: users[i] }
      );
      expect(res.status).toBe(201);
    }

    const { data } = await getFreshScores<{
      stale: boolean;
      classes: Array<{
        pilot_class: string;
        available_points: { leading: number };
        pilots: Array<{ total_score: number; leading_points: number }>;
      }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);
    const openClass = data.classes.find((c) => c.pilot_class === "open")!;

    // Engine ground truth with the same leading params (worker auto-computes
    // nominalDistance as 70% of task distance when unset).
    const xcTask = parseXCTask(env.SAMPLE_TASK_XCTSK);
    const taskDistance = calculateOptimizedTaskDistance(xcTask);
    const enginePilots = igcEntries.map(([, text]) => {
      const igc = parseIGC(text);
      return {
        pilotName: igc.header.pilot || igc.header.competitionId || "unknown",
        trackFile: "sample.igc",
        fixes: igc.fixes,
      };
    });
    const engineResult = scoreTask(xcTask, enginePilots, {
      ...gapParams,
      nominalDistance: taskDistance * 0.7,
    });

    // Whole-field parity: the per-pilot totals (which include leading points
    // via the cached aggregate) match the engine exactly, as does the leading
    // points pool.
    const apiTotals = openClass.pilots.map((p) => p.total_score).sort((a, b) => a - b);
    const engineTotals = engineResult.pilotScores.map((p) => p.totalScore).sort((a, b) => a - b);
    expect(apiTotals).toEqual(engineTotals);
    expect(openClass.available_points.leading).toBeCloseTo(
      engineResult.availablePoints.leading,
      5
    );

    // Second request is served from the materialized row, unchanged.
    const res2 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res2.headers.get("X-Cache")).toBe("HIT");
    expect(await res2.json()).toEqual(data);
  });

  test("task without xctsk returns 422", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId); // no xctsk

    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res.status).toBe(422);
  });

  test("class-based scoring ranks pilots within their class only", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    // Create comp with two classes
    const compId = await createComp({
      pilot_classes: ["open", "sport"],
      default_pilot_class: "open",
    });

    // Task scores both classes
    const taskId = await createTask(compId, {
      xctsk: taskXctsk,
      pilot_classes: ["open", "sport"],
    });

    const igcEntries = sampleIgcEntries();

    // user-1 → open (default), user-2 → also open initially
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[0][1]),
      { user: "user-1" }
    );
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[1][1]),
      { user: "user-2" }
    );

    // Move user-2 to sport class
    const pilotRes = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}/igc`
    );
    const pilotData = (await pilotRes.json()) as {
      tracks: Array<{ comp_pilot_id: string; pilot_class: string }>;
    };
    const sportPilot = pilotData.tracks[1];

    await authRequest(
      "PATCH",
      `/api/comp/${compId}/pilot/${sportPilot.comp_pilot_id}`,
      { pilot_class: "sport" }
    );

    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      classes: Array<{ pilot_class: string; pilots: unknown[] }>;
    };

    const openClass = data.classes.find((c) => c.pilot_class === "open");
    const sportClass = data.classes.find((c) => c.pilot_class === "sport");

    expect(openClass).toBeDefined();
    expect(sportClass).toBeDefined();
    expect(openClass!.pilots).toHaveLength(1);
    expect(sportClass!.pilots).toHaveLength(1);
  });
});

/** Build a single-Takeoff open-distance task from the sample task's launch. */
function openDistanceTaskFromSample() {
  const sample = JSON.parse(env.SAMPLE_TASK_XCTSK) as {
    turnpoints: Array<{ radius: number; waypoint: unknown }>;
  };
  return {
    taskType: "OPEN-DISTANCE",
    version: 1,
    earthModel: "WGS84",
    turnpoints: [
      { type: "TAKEOFF", radius: 400, waypoint: sample.turnpoints[0].waypoint },
    ],
  };
}

describe("Open distance scoring", () => {
  test("scores by distance from take-off and reports the format", async () => {
    const compId = await createComp({
      category: "hg",
      scoring_format: "open_distance",
    });
    const taskId = await createTask(compId, {
      xctsk: openDistanceTaskFromSample(),
      pilot_classes: ["open"],
    });

    const igcEntries = sampleIgcEntries().slice(0, 3);
    const users = ["user-1", "user-2", "user-3"];
    for (let i = 0; i < igcEntries.length; i++) {
      const res = await uploadRequest(
        `/api/comp/${compId}/task/${taskId}/igc`,
        await compressText(igcEntries[i][1]),
        { user: users[i] }
      );
      expect(res.status).toBe(201);
    }

    const { data } = await getFreshScores<{
      stale: boolean;
      scoring_format: string;
      classes: Array<{
        pilots: Array<{
          rank: number;
          total_score: number;
          flown_distance: number;
          made_goal: boolean;
          time_points: number;
          leading_points: number;
        }>;
      }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);

    expect(data.scoring_format).toBe("open_distance");
    const pilots = data.classes[0].pilots;
    expect(pilots.length).toBe(3);

    // Ranked by open distance, furthest first.
    const distances = pilots.map((p) => p.flown_distance);
    expect(distances).toEqual([...distances].sort((a, b) => b - a));
    expect(pilots[0].rank).toBe(1);
    expect(pilots[0].flown_distance).toBeGreaterThan(0);

    // Score is the distance in whole metres; no GAP point components.
    for (const p of pilots) {
      expect(p.total_score).toBe(Math.round(p.flown_distance));
      expect(p.made_goal).toBe(false);
      expect(p.time_points).toBe(0);
      expect(p.leading_points).toBe(0);
    }
  });

  test("switching a comp to open distance re-scores every task and is audit-logged", async () => {
    const sampleTask = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp({ category: "hg" }); // GAP by default
    const taskId = await createTask(compId, {
      xctsk: sampleTask,
      pilot_classes: ["open"],
    });

    const igcEntries = sampleIgcEntries();
    for (const [i, user] of ["user-1", "user-2"].entries()) {
      await uploadRequest(
        `/api/comp/${compId}/task/${taskId}/igc`,
        await compressText(igcEntries[i][1]),
        { user }
      );
    }

    // Score as GAP first — materializes the row under the GAP format.
    const { data: gap } = await getFreshScores<{ stale: boolean; scoring_format: string }>(
      `/api/comp/${compId}/task/${taskId}/score`
    );
    expect(gap.scoring_format).toBe("gap");

    // Switch the comp to open distance — marks the task stale and re-scores.
    const patch = await authRequest("PATCH", `/api/comp/${compId}`, {
      scoring_format: "open_distance",
    });
    expect(patch.status).toBe(200);

    const { data: od } = await getFreshScores<{ stale: boolean; scoring_format: string }>(
      `/api/comp/${compId}/task/${taskId}/score`
    );
    expect(od.scoring_format).toBe("open_distance");

    // The format change is recorded in the (publicly visible) audit log.
    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE description LIKE 'Changed scoring format%'"
    ).all<{ description: string }>();
    expect(audit.results.length).toBe(1);
    expect(audit.results[0].description).toContain("Open distance");
  });

  test("reuses stored per-track analyses when a new track is added", async () => {
    const compId = await createComp({
      category: "hg",
      scoring_format: "open_distance",
    });
    const taskId = await createTask(compId, {
      xctsk: openDistanceTaskFromSample(),
      pilot_classes: ["open"],
    });
    const igcEntries = sampleIgcEntries();

    // First pilot → score.
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[0][1]),
      { user: "user-1" }
    );
    const { data: data1 } = await getFreshScores<{
      stale: boolean;
      classes: Array<{ pilots: Array<{ pilot_name: string; flown_distance: number }> }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);
    const first = data1.classes[0].pilots[0];

    // The compute persisted the field-independent analysis for the track.
    const analysesAfterFirst = await env.DB.prepare(
      "SELECT task_track_id, payload_json FROM track_analysis WHERE variant = 'od'"
    ).all<{ task_track_id: number; payload_json: string }>();
    expect(analysesAfterFirst.results.length).toBe(1);
    const firstPayload = analysesAfterFirst.results[0].payload_json;

    // Second pilot → re-score. The first pilot's analysis row is reused
    // byte-for-byte (not recomputed) and their distance is unchanged.
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[1][1]),
      { user: "user-2" }
    );
    const { data: data2 } = await getFreshScores<{
      stale: boolean;
      classes: Array<{ pilots: Array<{ pilot_name: string; flown_distance: number }> }>;
    }>(`/api/comp/${compId}/task/${taskId}/score`);

    expect(data2.classes[0].pilots.length).toBe(2);
    const firstAgain = data2.classes[0].pilots.find(
      (p) => p.pilot_name === first.pilot_name
    )!;
    expect(firstAgain.flown_distance).toBe(first.flown_distance);

    const analysesAfterSecond = await env.DB.prepare(
      "SELECT task_track_id, payload_json FROM track_analysis WHERE variant = 'od' ORDER BY task_track_id"
    ).all<{ task_track_id: number; payload_json: string }>();
    expect(analysesAfterSecond.results.length).toBe(2);
    expect(analysesAfterSecond.results[0].payload_json).toBe(firstPayload);
  });
});
