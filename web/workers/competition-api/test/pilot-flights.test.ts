import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  request,
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";
import { decodeId } from "../src/sqids";

const ALPHABET = env.SQIDS_ALPHABET;

/** Precomputed gzip of a minimal valid IGC (see igc-routes.test.ts). */
function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

async function uploadIgc(
  compId: string,
  taskId: string,
  user = "user-1"
): Promise<{ comp_pilot_id: string }> {
  const res = await uploadRequest(
    `/api/comp/${compId}/task/${taskId}/igc`,
    fakeIgcPayload(),
    { user }
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { comp_pilot_id: string };
}

interface FlightEntry {
  comp_id: string;
  comp_name: string;
  task_id: string;
  task_name: string;
  task_date: string;
  pilot_class: string;
  comp_pilot_id: string;
  kind: "track" | "manual";
  recorded_at: string;
  rank: number | null;
  class_size: number | null;
  total_score: number | null;
}

async function getFlights(user = "user-1"): Promise<FlightEntry[]> {
  const res = await request("GET", "/api/comp/pilot/flights", { user });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { flights: FlightEntry[] };
  return data.flights;
}

/** Store a materialized score blob for a task, the way revalidation would. */
async function storeScoreBlob(
  taskId: string,
  classes: Array<{
    pilot_class: string;
    pilots: Array<{ rank: number; comp_pilot_id: string; total_score: number }>;
  }>
): Promise<void> {
  const blob = JSON.stringify({
    task_id: taskId,
    comp_id: "x",
    task_date: "2026-01-15",
    scoring_format: "gap",
    classes,
    computed_at: "2026-01-16T00:00:00Z",
  });
  await env.DB.prepare(
    `INSERT INTO task_scores (
       task_id, response_json, state_key, computed_at,
       engine_version, inputs_rev, computed_rev, revalidating_until
     ) VALUES (?, ?, 'key', '2026-01-16T00:00:00Z', 1, 1, 1, '')
     ON CONFLICT(task_id) DO UPDATE SET response_json = excluded.response_json`
  )
    .bind(decodeId(ALPHABET, taskId), blob)
    .run();
}

beforeEach(async () => {
  await clearCompData();
});

describe("GET /api/comp/pilot/flights", () => {
  test("requires auth", async () => {
    const res = await request("GET", "/api/comp/pilot/flights");
    expect(res.status).toBe(401);
  });

  test("empty for a user with no pilot record", async () => {
    expect(await getFlights("user-3")).toEqual([]);
  });

  test("lists an uploaded track with comp/task info, unscored rank is null", async () => {
    const compId = await createComp({ name: "Corryong Cup" });
    const taskId = await createTask(compId, { name: "Task 1", task_date: "2026-01-15" });
    const { comp_pilot_id } = await uploadIgc(compId, taskId);

    const flights = await getFlights();
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({
      comp_id: compId,
      comp_name: "Corryong Cup",
      task_id: taskId,
      task_name: "Task 1",
      task_date: "2026-01-15",
      pilot_class: "open",
      comp_pilot_id,
      kind: "track",
      rank: null,
      class_size: null,
      total_score: null,
    });
  });

  test("includes rank, class size and score from the materialized blob", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const { comp_pilot_id } = await uploadIgc(compId, taskId);

    await storeScoreBlob(taskId, [
      {
        pilot_class: "open",
        pilots: [
          { rank: 1, comp_pilot_id: "SOMEONE-ELSE", total_score: 990 },
          { rank: 2, comp_pilot_id, total_score: 917 },
          { rank: 3, comp_pilot_id: "A-THIRD-PILOT", total_score: 800 },
        ],
      },
    ]);

    const [flight] = await getFlights();
    expect(flight.rank).toBe(2);
    expect(flight.class_size).toBe(3);
    expect(flight.total_score).toBe(917);
  });

  test("tolerates the empty placeholder task_scores row", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    await uploadIgc(compId, taskId);
    // A bump before first compute leaves response_json = '' — not JSON.
    // (The upload above may already have created the placeholder row.)
    await env.DB.prepare(
      `INSERT INTO task_scores (
         task_id, response_json, state_key, computed_at,
         engine_version, inputs_rev, computed_rev, revalidating_until
       ) VALUES (?, '', '', '', 0, 1, -1, '')
       ON CONFLICT(task_id) DO UPDATE SET response_json = '', computed_rev = -1`
    )
      .bind(decodeId(ALPHABET, taskId))
      .run();

    const [flight] = await getFlights();
    expect(flight.rank).toBeNull();
  });

  test("includes active manual flights, newest task first", async () => {
    const compId = await createComp();
    const task1 = await createTask(compId, { name: "Task 1", task_date: "2026-01-15" });
    const task2 = await createTask(compId, { name: "Task 2", task_date: "2026-01-16" });
    const { comp_pilot_id } = await uploadIgc(compId, task1);

    await env.DB.prepare(
      `INSERT INTO task_manual_flight (
         task_id, comp_pilot_id, last_reached_tp_index, landing_lat, landing_lon,
         made_goal, computed_distance, active, set_by_name, set_at
       ) VALUES (?, ?, 1, -36.4, 148.2, 0, 12000, 1, 'Admin', '2026-01-16T05:00:00Z')`
    )
      .bind(decodeId(ALPHABET, task2), decodeId(ALPHABET, comp_pilot_id))
      .run();

    const flights = await getFlights();
    expect(flights.map((f) => [f.task_name, f.kind])).toEqual([
      ["Task 2", "manual"],
      ["Task 1", "track"],
    ]);
  });

  test("excludes superseded (inactive) tracks", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    await uploadIgc(compId, taskId);
    await env.DB.prepare("UPDATE task_track SET active = 0").run();

    expect(await getFlights()).toEqual([]);
  });

  test("excludes flights in hidden test comps", async () => {
    const compId = await createComp({ name: "Hidden Comp", test: true });
    const taskId = await createTask(compId);
    await uploadIgc(compId, taskId);

    expect(await getFlights()).toEqual([]);
  });

  test("only returns the caller's own flights", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    await uploadIgc(compId, taskId, "user-1");

    expect(await getFlights("user-3")).toEqual([]);
  });
});
