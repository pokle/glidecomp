/**
 * Elevated Goal and control-zone altitude limits through the API (issue #600):
 * the stored task accepts them, a change is audited and rescores, and a goal
 * pilot under the elevation is published with the §13.1 factor.
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
} from "./helpers";
import { speedSectionTypeWarnings, summarizeXctskChange } from "../src/xctsk-summary";

async function compressText(text: string): Promise<Uint8Array> {
  const stream = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function freshScores<T extends { stale: boolean }>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await request("GET", path);
    expect(res.status).toBe(200);
    const data = (await res.json()) as T;
    if (data.stale === false) return data;
    if (attempt >= 50) throw new Error(`scores at ${path} still stale after polling`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function getAudit(compId: string): Promise<string[]> {
  const res = await authRequest("GET", `/api/comp/${compId}/audit`);
  const body = (await res.json()) as { entries: Array<{ description: string }> };
  return body.entries.map((e) => e.description);
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

type Pilot = {
  pilot_name: string;
  made_goal: boolean;
  time_points: number;
  distance_points: number;
  goal_altitude_factor: number | null;
  time_points_before_goal_altitude: number | null;
};

describe("Elevated Goal (S7F 2026 §6.2.3.2, §13.1)", () => {
  test("setting one is audited, rescores, and publishes each low pilot's factor", async () => {
    const xctsk = JSON.parse(env.SAMPLE_TASK_XCTSK) as {
      goal?: Record<string, unknown>;
      turnpoints: Array<{ waypoint: { altSmoothed?: number } }>;
    };
    const compId = await createComp({ category: "hg" });
    const taskId = await createTask(compId, { xctsk, pilot_classes: ["open"] });
    const files = Object.entries(JSON.parse(env.SAMPLE_IGC_FILES) as Record<string, string>)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 3);
    const users = ["user-1", "user-2", "user-3"];
    for (let i = 0; i < files.length; i++) {
      const r = await uploadRequest(
        `/api/comp/${compId}/task/${taskId}/igc`,
        await compressText(files[i][1]),
        { user: users[i] }
      );
      expect(r.status).toBe(201);
    }
    const path = `/api/comp/${compId}/task/${taskId}/score`;
    const ground = await freshScores<{ stale: boolean; class_scores: Array<{ pilots: Pilot[] }> }>(path);
    const groundPilots = ground.class_scores[0].pilots;
    expect(groundPilots.some((p) => p.made_goal), "a goal pilot to measure").toBe(true);
    for (const p of groundPilots) expect(p.goal_altitude_factor).toBeNull();

    // A deliberately high goal (1000 m above the goal waypoint) so the sample
    // goal pilots, who glided in low, all cross under it.
    const patched = await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: { ...xctsk, goal: { ...(xctsk.goal ?? {}), type: "CYLINDER", finishAltitude: 1000 } },
    });
    expect(patched.status).toBe(200);
    expect((await getAudit(compId)).some((d) => d.includes("elevated goal off → 1000 m above goal"))).toBe(true);

    const elevated = (
      await freshScores<{ stale: boolean; class_scores: Array<{ pilots: Pilot[] }> }>(path)
    ).class_scores[0].pilots;
    const byName = new Map(groundPilots.map((p) => [p.pilot_name, p]));
    for (const p of elevated) {
      const g = byName.get(p.pilot_name)!;
      // Distance never depends on the goal's altitude.
      expect(p.distance_points).toBe(g.distance_points);
      if (!p.made_goal) {
        expect(p.goal_altitude_factor).toBeNull();
        continue;
      }
      expect(p.goal_altitude_factor).not.toBeNull();
      expect(p.goal_altitude_factor!).toBeGreaterThanOrEqual(0.8);
      expect(p.goal_altitude_factor!).toBeLessThan(1);
      expect(p.time_points).toBeCloseTo(
        p.time_points_before_goal_altitude! * p.goal_altitude_factor!,
        0
      );
    }
  });
});

describe("altitude limits on the stored route (§6.2.1)", () => {
  test("accepted when sensible, rejected when not", async () => {
    const xctsk = JSON.parse(env.SAMPLE_TASK_XCTSK) as {
      turnpoints: Array<Record<string, unknown>>;
    };
    const compId = await createComp({ category: "hg" });
    const taskId = await createTask(compId, { xctsk, pilot_classes: ["open"] });
    const withLimits = (limits: unknown) => ({
      ...xctsk,
      turnpoints: xctsk.turnpoints.map((tp, i) => (i === 2 ? { ...tp, altitudeLimits: limits } : tp)),
    });

    const ok = await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: withLimits({ lower: 800, upper: 2500 }),
    });
    expect(ok.status).toBe(200);
    expect(
      (await getAudit(compId)).some((d) => d.includes("altitude limits none → 800–2500 m"))
    ).toBe(true);

    // The goal cannot have altitude limits (§6.2.3).
    const goalLimited = {
      ...xctsk,
      turnpoints: xctsk.turnpoints.map((tp, i) =>
        i === xctsk.turnpoints.length - 1 ? { ...tp, altitudeLimits: { upper: 900 } } : tp
      ),
    };
    const goalRes = await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: goalLimited,
    });
    expect(goalRes.status).toBe(400);

    for (const bad of [{}, { lower: 2500, upper: 800 }, { upper: "high" }, { lower: 1, extra: 2 }]) {
      const res = await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
        xctsk: withLimits(bad),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("xctsk summaries", () => {
  const base = {
    taskType: "CLASSIC",
    turnpoints: [
      { type: "SSS", radius: 1000, waypoint: { name: "S", lat: 0, lon: 0 } },
      { radius: 400, waypoint: { name: "G", lat: 0.1, lon: 0, altSmoothed: 300 } },
    ],
    goal: { type: "CYLINDER" },
  };

  test("an elevated goal is the ESS, so no missing-ESS warning", () => {
    expect(speedSectionTypeWarnings(JSON.stringify(base)).missing_ess).toBe(true);
    const elevated = { ...base, goal: { type: "CYLINDER", finishAltitude: 300 } };
    expect(speedSectionTypeWarnings(JSON.stringify(elevated)).missing_ess).toBe(false);
    // …but only when the goal has an altitude to measure from.
    const noAlt = {
      ...elevated,
      turnpoints: [base.turnpoints[0], { radius: 400, waypoint: { name: "G", lat: 0.1, lon: 0 } }],
    };
    expect(speedSectionTypeWarnings(JSON.stringify(noAlt)).missing_ess).toBe(true);
  });

  test("describes elevated-goal changes", () => {
    expect(
      summarizeXctskChange(JSON.stringify(base), { ...base, goal: { type: "CYLINDER", finishAltitude: 300 } })
    ).toBe("elevated goal off → 300 m above goal");
  });
});
