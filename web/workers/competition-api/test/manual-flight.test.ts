import { SELF, env } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  authRequest,
  request,
  clearCompData,
  createComp,
  createTask,
  uploadRequest,
} from "./helpers";

/**
 * A straight west→east task along the equator, so made-good is easy to reason
 * about: SSS(0,0) r1000 · TP1(0,0.1) · TP2(0,0.2) · GOAL(0,0.3). Indices into
 * turnpoints[] are 0..3 (0 = Start/SSS, 3 = Goal).
 */
const TASK_XCTSK = {
  taskType: "CLASSIC",
  version: 1,
  earthModel: "WGS84",
  turnpoints: [
    { type: "SSS", radius: 1000, waypoint: { name: "SSS", lat: 0, lon: 0.0 } },
    { radius: 400, waypoint: { name: "TP1", lat: 0, lon: 0.1 } },
    { radius: 400, waypoint: { name: "TP2", lat: 0, lon: 0.2 } },
    { radius: 400, waypoint: { name: "GOAL", lat: 0, lon: 0.3 } },
  ],
  sss: { type: "RACE", direction: "EXIT" },
  goal: { type: "CYLINDER" },
};

/** Minimal valid gzip IGC blob (passes the upload shape check; parses to 0
 * fixes, so it is a track for reconciliation purposes without needing a real
 * tracklog). */
function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

async function registerPilot(
  compId: string,
  name = "Alice Lander"
): Promise<string> {
  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: name,
    pilot_class: "open",
  });
  const data = (await res.json()) as { comp_pilot_id: string };
  return data.comp_pilot_id;
}

/** Task-id column value for the single task created in a test. */
async function taskDbId(): Promise<number> {
  const row = await env.DB.prepare("SELECT task_id FROM task").first<{
    task_id: number;
  }>();
  return row!.task_id;
}

async function manualRows(): Promise<
  Array<{ active: number; made_goal: number; computed_distance: number; duration_seconds: number | null }>
> {
  const res = await env.DB.prepare(
    "SELECT active, made_goal, computed_distance, duration_seconds FROM task_manual_flight ORDER BY task_manual_flight_id"
  ).all<{ active: number; made_goal: number; computed_distance: number; duration_seconds: number | null }>();
  return res.results;
}

async function statusKey(): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT status_key FROM task_pilot_status LIMIT 1"
  ).first<{ status_key: string }>();
  return row?.status_key ?? null;
}

/** Poll the score endpoint until fresh (stale-first serving). */
async function getFreshScores(path: string): Promise<{
  classes: Array<{
    pilot_class: string;
    task_validity: { launch: number };
    pilots: Array<{ pilot_name: string; flown_distance: number; made_goal: boolean; total_score: number }>;
  }>;
}> {
  for (let attempt = 0; ; attempt++) {
    const res = await request("GET", path);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { stale: boolean } & Awaited<ReturnType<typeof getFreshScores>>;
    if (data.stale === false) return data;
    if (attempt >= 50) throw new Error("scores still stale after polling");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeEach(async () => {
  await clearCompData();
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});
afterEach(async () => {
  await clearCompData();
});

// ── PUT: record a manual flight ──────────────────────────────────────────────

describe("PUT manual-flight", () => {
  test("records a land-out and resolves the outcome to Landed", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`,
      { last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15 }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.made_goal).toBe(false);
    expect(data.active).toBe(true);
    expect(data.computed_distance as number).toBeGreaterThan(0);

    // Row is active; outcome is Landed (derived from the evidence).
    const rows = await manualRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(1);
    expect(await statusKey()).toBe("landed");

    // Audit records the made-good.
    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE subject_type = 'track'"
    ).all<{ description: string }>();
    expect(
      audit.results.some(
        (r) => r.description.includes("Recorded manual flight") && r.description.includes("made good")
      )
    ).toBe(true);
  });

  test("in-goal flight carries made_goal + duration and full task distance", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`,
      { last_reached_tp_index: 3, landing_lat: 0, landing_lon: 0.3, duration_seconds: 3600 }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.made_goal).toBe(true);
    expect(data.duration_seconds).toBe(3600);

    const rows = await manualRows();
    expect(rows[0].made_goal).toBe(1);
    // Full optimised task distance is ~33 km along the equator.
    expect(rows[0].computed_distance).toBeGreaterThan(30000);
  });

  test("a second manual flight supersedes the first (retained, one active)", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`, {
      last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.12,
    });
    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`, {
      last_reached_tp_index: 2, landing_lat: 0, landing_lon: 0.22,
    });

    const rows = await manualRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.active === 1)).toHaveLength(1);
  });

  test("rejects an out-of-range last_reached_tp_index", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);
    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`,
      { last_reached_tp_index: 9, landing_lat: 0, landing_lon: 0.15 }
    );
    expect(res.status).toBe(400);
  });

  test("400 when the task has no route", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId); // no xctsk
    const cp = await registerPilot(compId);
    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`,
      { last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15 }
    );
    expect(res.status).toBe(400);
  });

  test("anonymous request is denied", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);
    const res = await request(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`,
      { body: { last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15 } }
    );
    expect(res.status).toBe(401);
  });
});

// ── Evidence is track XOR manual ─────────────────────────────────────────────

describe("evidence reconciliation (track XOR manual)", () => {
  test("recording a manual flight supersedes an active track", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    // Admin uploads a track on behalf → active track, Landed.
    const up = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${cp}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    expect(up.status).toBe(201);
    let track = await env.DB.prepare(
      "SELECT active FROM task_track LIMIT 1"
    ).first<{ active: number }>();
    expect(track!.active).toBe(1);

    // Now record a manual flight → track deactivated, manual active.
    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`,
      { last_reached_tp_index: 2, landing_lat: 0, landing_lon: 0.22 }
    );
    expect(res.status).toBe(200);

    track = await env.DB.prepare("SELECT active FROM task_track LIMIT 1").first<{
      active: number;
    }>();
    expect(track!.active).toBe(0);
    const rows = await manualRows();
    expect(rows.filter((r) => r.active === 1)).toHaveLength(1);
    expect(await statusKey()).toBe("landed");
  });

  test("uploading a track supersedes an active manual flight", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`, {
      last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15,
    });

    const up = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${cp}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    expect(up.status).toBe(201);

    const rows = await manualRows();
    expect(rows.filter((r) => r.active === 1)).toHaveLength(0);
    const track = await env.DB.prepare(
      "SELECT active FROM task_track LIMIT 1"
    ).first<{ active: number }>();
    expect(track!.active).toBe(1);
    expect(await statusKey()).toBe("landed");
  });
});

// ── The DNF-over-a-record bug fix ────────────────────────────────────────────

describe("setting DNF supersedes evidence (bug fix)", () => {
  test("marking DNF deactivates a track so it is no longer scored", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${cp}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );

    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${cp}`,
      { status_key: "dnf" }
    );

    const track = await env.DB.prepare(
      "SELECT active FROM task_track LIMIT 1"
    ).first<{ active: number }>();
    // The track row is retained but deactivated — no longer scored.
    expect(track!.active).toBe(0);
    expect(await statusKey()).toBe("dnf");
  });

  test("marking DNF deactivates a manual flight", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`, {
      last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15,
    });
    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/pilot-status/${cp}`, {
      status_key: "dnf",
    });

    const rows = await manualRows();
    expect(rows.filter((r) => r.active === 1)).toHaveLength(0);
    expect(await statusKey()).toBe("dnf");
  });

  test("admins can no longer hand-pick Landed", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);
    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${cp}`,
      { status_key: "landed" }
    );
    expect(res.status).toBe(400);
  });
});

// ── Restore ──────────────────────────────────────────────────────────────────

describe("restore superseded evidence", () => {
  test("a manual flight superseded by DNF can be restored", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    const put = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`,
      { last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15 }
    );
    const created = (await put.json()) as { task_manual_flight_id: string };

    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/pilot-status/${cp}`, {
      status_key: "dnf",
    });
    expect((await manualRows()).filter((r) => r.active === 1)).toHaveLength(0);

    const restore = await authRequest(
      "POST",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}/restore/${created.task_manual_flight_id}`
    );
    expect(restore.status).toBe(200);
    expect((await manualRows()).filter((r) => r.active === 1)).toHaveLength(1);
    expect(await statusKey()).toBe("landed");
  });

  test("a track superseded by DNF can be restored", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${cp}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/pilot-status/${cp}`, {
      status_key: "dnf",
    });

    const restore = await authRequest(
      "POST",
      `/api/comp/${compId}/task/${taskId}/igc/${cp}/restore`
    );
    expect(restore.status).toBe(200);
    const track = await env.DB.prepare(
      "SELECT active FROM task_track LIMIT 1"
    ).first<{ active: number }>();
    expect(track!.active).toBe(1);
    expect(await statusKey()).toBe("landed");
  });
});

// ── DELETE ───────────────────────────────────────────────────────────────────

describe("DELETE manual-flight", () => {
  test("supersedes the active manual flight and returns the pilot to Present", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId);

    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`, {
      last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.15,
    });
    const del = await authRequest(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`
    );
    expect(del.status).toBe(200);

    expect((await manualRows()).filter((r) => r.active === 1)).toHaveLength(0);
    // No active evidence and no absent/dnf row → Present.
    expect(await statusKey()).toBeNull();
  });
});

// ── Read endpoints ───────────────────────────────────────────────────────────

describe("GET manual-flight list + history", () => {
  test("list returns active flights; history returns active + superseded", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK });
    const cp = await registerPilot(compId, "Historied");

    // Two reports for the same pilot → second supersedes the first.
    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`, {
      last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.12,
    });
    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}`, {
      last_reached_tp_index: 2, landing_lat: 0, landing_lon: 0.22,
    });

    // Public list shows only the one active flight.
    const listRes = await request("GET", `/api/comp/${compId}/task/${taskId}/manual-flight`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { manual_flights: Array<Record<string, unknown>> };
    expect(list.manual_flights).toHaveLength(1);
    expect(list.manual_flights[0].active).toBe(true);
    expect(list.manual_flights[0].pilot_name).toBe("Historied");

    // History shows both, newest first.
    const histRes = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}/manual-flight/${cp}/history`
    );
    const hist = (await histRes.json()) as { manual_flights: Array<Record<string, unknown>> };
    expect(hist.manual_flights).toHaveLength(2);
    expect(hist.manual_flights[0].active).toBe(true);
    expect(hist.manual_flights[1].active).toBe(false);
  });
});

// ── Scoring ──────────────────────────────────────────────────────────────────

describe("manual flights feed scoring", () => {
  test("manual-flight pilots are scored as numFlying with made-good distance", async () => {
    const compId = await createComp({ category: "pg" });
    const taskId = await createTask(compId, { xctsk: TASK_XCTSK, pilot_classes: ["open"] });
    const goalPilot = await registerPilot(compId, "Goalie");
    const landPilot = await registerPilot(compId, "Lander");

    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${goalPilot}`, {
      last_reached_tp_index: 3, landing_lat: 0, landing_lon: 0.3, duration_seconds: 3600,
    });
    await authRequest("PUT", `/api/comp/${compId}/task/${taskId}/manual-flight/${landPilot}`, {
      last_reached_tp_index: 1, landing_lat: 0, landing_lon: 0.13,
    });

    const data = await getFreshScores(`/api/comp/${compId}/task/${taskId}/score`);
    const open = data.classes.find((c) => c.pilot_class === "open")!;
    expect(open.pilots).toHaveLength(2);
    // Launch validity is positive → the field was counted as flying.
    expect(open.task_validity.launch).toBeGreaterThan(0);

    const goalie = open.pilots.find((p) => p.pilot_name === "Goalie")!;
    const lander = open.pilots.find((p) => p.pilot_name === "Lander")!;
    expect(goalie.made_goal).toBe(true);
    expect(goalie.flown_distance).toBeGreaterThan(lander.flown_distance);
    expect(lander.flown_distance).toBeGreaterThan(0);
    expect(goalie.total_score).toBeGreaterThan(lander.total_score);
  });
});
