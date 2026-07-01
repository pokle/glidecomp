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

    // Call scoring endpoint
    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");

    const data = (await res.json()) as {
      task_id: string;
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
    };

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

  test("cache hit returns same result on second request", async () => {
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

    // First request — cache miss
    const res1 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Cache")).toBe("MISS");
    const body1 = await res1.json();

    // Second request — cache hit
    const res2 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Cache")).toBe("HIT");
    const body2 = await res2.json();

    expect(body2).toEqual(body1);
  });

  test("cache invalidates after new upload", async () => {
    const taskXctsk = JSON.parse(env.SAMPLE_TASK_XCTSK);
    const compId = await createComp();
    const taskId = await createTask(compId, {
      xctsk: taskXctsk,
      pilot_classes: ["open"],
    });

    const igcEntries = sampleIgcEntries();

    // Upload first pilot, score (miss)
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[0][1]),
      { user: "user-1" }
    );
    const res1 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res1.headers.get("X-Cache")).toBe("MISS");
    const data1 = (await res1.json()) as { classes: Array<{ pilots: unknown[] }> };

    // Upload second pilot
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[1][1]),
      { user: "user-2" }
    );

    // Score again — must be a cache miss (new pilot changes cache key)
    const res2 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res2.headers.get("X-Cache")).toBe("MISS");
    const data2 = (await res2.json()) as { classes: Array<{ pilots: unknown[] }> };

    // New result has more pilots
    expect(data2.classes[0].pilots.length).toBeGreaterThan(
      (data1.classes[0].pilots as unknown[]).length
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
    const res1 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    const data1 = (await res1.json()) as {
      classes: Array<{
        pilots: Array<{ rank: number; comp_pilot_id: string; total_score: number }>;
      }>;
    };
    const rank1Pilot = data1.classes[0].pilots.find((p) => p.rank === 1)!;

    // Apply penalty large enough to guarantee a re-rank (pilot drops to 0)
    const penalty = rank1Pilot.total_score + 1;
    await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${rank1Pilot.comp_pilot_id}`,
      { penalty_points: penalty, penalty_reason: "Test penalty" }
    );

    // Re-score (cache miss due to penalty change)
    const res2 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res2.headers.get("X-Cache")).toBe("MISS");
    const data2 = (await res2.json()) as {
      classes: Array<{
        pilots: Array<{
          rank: number;
          comp_pilot_id: string;
          total_score: number;
          penalty_points: number;
        }>;
      }>;
    };

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

    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    const data = (await res.json()) as {
      classes: Array<{
        pilot_class: string;
        available_points: { leading: number };
        pilots: Array<{ total_score: number; leading_points: number }>;
      }>;
    };
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

    // Second request is served from the result cache, unchanged.
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

    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
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
    };

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

  test("switching a comp to open distance re-scores (cache miss) and is audit-logged", async () => {
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

    // Score as GAP first — populates the cache under the GAP-format key.
    const gapRes = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    const gap = (await gapRes.json()) as { scoring_format: string };
    expect(gap.scoring_format).toBe("gap");

    // Switch the comp to open distance.
    const patch = await authRequest("PATCH", `/api/comp/${compId}`, {
      scoring_format: "open_distance",
    });
    expect(patch.status).toBe(200);

    // Re-score: the cache key now includes the new format, so this is a MISS
    // and returns the open-distance result.
    const odRes = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(odRes.headers.get("X-Cache")).toBe("MISS");
    const od = (await odRes.json()) as { scoring_format: string };
    expect(od.scoring_format).toBe("open_distance");

    // The format change is recorded in the (publicly visible) audit log.
    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE description LIKE 'Changed scoring format%'"
    ).all<{ description: string }>();
    expect(audit.results.length).toBe(1);
    expect(audit.results[0].description).toContain("Open distance");
  });

  test("reuses the per-track cache when a new track is added", async () => {
    const compId = await createComp({
      category: "hg",
      scoring_format: "open_distance",
    });
    const taskId = await createTask(compId, {
      xctsk: openDistanceTaskFromSample(),
      pilot_classes: ["open"],
    });
    const igcEntries = sampleIgcEntries();

    // First pilot → score (miss).
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[0][1]),
      { user: "user-1" }
    );
    const res1 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    const data1 = (await res1.json()) as {
      classes: Array<{ pilots: Array<{ pilot_name: string; flown_distance: number }> }>;
    };
    const first = data1.classes[0].pilots[0];

    // Second pilot → the whole-task cache key changes, so this recomputes. The
    // first pilot's distance comes from the per-track cache and is unchanged.
    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      await compressText(igcEntries[1][1]),
      { user: "user-2" }
    );
    const res2 = await request("GET", `/api/comp/${compId}/task/${taskId}/score`);
    expect(res2.headers.get("X-Cache")).toBe("MISS");
    const data2 = (await res2.json()) as {
      classes: Array<{ pilots: Array<{ pilot_name: string; flown_distance: number }> }>;
    };

    expect(data2.classes[0].pilots.length).toBe(2);
    const firstAgain = data2.classes[0].pilots.find(
      (p) => p.pilot_name === first.pilot_name
    )!;
    expect(firstAgain.flown_distance).toBe(first.flown_distance);
  });
});
