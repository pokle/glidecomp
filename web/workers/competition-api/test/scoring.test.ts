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
