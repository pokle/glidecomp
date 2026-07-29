import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { authRequest, clearCompData, createComp, createTask, request } from "./helpers";
import { decodeId } from "../src/sqids";
import { likePattern, searchTokens } from "../src/routes/lookup";

const ALPHABET = env.SQIDS_ALPHABET;
const num = (sqid: string) => decodeId(ALPHABET, sqid)!;

interface LookupBody {
  comps: Array<{ comp_id: string; name: string; category: string }>;
  tasks: Array<{ comp_id: string; task_id: string; name: string; comp_name: string }>;
  pilots: Array<{
    comp_id: string;
    task_id: string;
    task_name: string;
    comp_pilot_id: string;
    name: string;
  }>;
}

async function lookup(
  query: Record<string, string>,
  user?: string | null
): Promise<LookupBody> {
  const qs = new URLSearchParams(query).toString();
  const res = await request("GET", `/api/comp/lookup?${qs}`, { user });
  expect(res.status).toBe(200);
  return (await res.json()) as LookupBody;
}

/** Give a registered pilot a result on a task, so they are linkable. */
async function giveManualFlight(taskId: string, compPilotId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO task_manual_flight
       (task_id, comp_pilot_id, last_reached_tp_index, landing_lat, landing_lon,
        made_goal, computed_distance, active, set_by_name, set_at)
     VALUES (?, ?, 0, -36.2, 147.9, 0, 12000, 1, 'test', '2026-01-05T00:00:00Z')`
  )
    .bind(num(taskId), num(compPilotId))
    .run();
}

async function registerPilot(compId: string, name: string): Promise<string> {
  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: name,
    pilot_class: "open",
  });
  const data = (await res.json()) as { comp_pilot_id: string };
  return data.comp_pilot_id;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM task_manual_flight").run();
  await clearCompData();
});

describe("searchTokens", () => {
  test("reads the same words out of a slug and out of typed text", () => {
    expect(searchTokens("corryong-cup-2026")).toEqual(["corryong", "cup", "2026"]);
    expect(searchTokens("Corryong Cup 2026")).toEqual(["corryong", "cup", "2026"]);
  });

  test("drops single letters, keeps single digits", () => {
    // "a" narrows nothing; the "1" is what tells Task 1 from Task 2.
    expect(searchTokens("a b task")).toEqual(["task"]);
    expect(searchTokens("task-1-open")).toEqual(["task", "1", "open"]);
  });

  test("caps the number of words, so one query can't fan out", () => {
    expect(searchTokens("a1 b2 c3 d4 e5 f6 g7 h8")).toHaveLength(5);
  });

  test("nothing searchable yields no search", () => {
    expect(searchTokens(undefined)).toEqual([]);
    expect(searchTokens("!!! ??? ---")).toEqual([]);
  });

  test("a LIKE wildcard never survives into a token", () => {
    expect(searchTokens("cor%ong")).toEqual(["cor", "ong"]);
    expect(searchTokens("%")).toEqual([]);
    expect(searchTokens("_")).toEqual([]);
  });
});

describe("likePattern", () => {
  test("escapes the wildcards, so a token only ever matches itself", () => {
    expect(likePattern("corryong")).toBe("%corryong%");
    expect(likePattern("a%b")).toBe("%a\\%b%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });
});

describe("GET /api/comp/lookup", () => {
  test("does not collide with GET /api/comp/:comp_id", async () => {
    const res = await request("GET", "/api/comp/lookup?comp_q=nothing");
    // Not the "Invalid comp_id" 400 that a sqid-decoding route would give.
    expect(res.status).toBe(200);
  });

  test("finds a comp by the words in its slug", async () => {
    await createComp({ name: "Corryong Cup 2026" });
    const body = await lookup({ comp_q: "corryong-cup-2026" });
    expect(body.comps.map((c) => c.name)).toEqual(["Corryong Cup 2026"]);
  });

  test("every word must match, so a near-miss name is not offered", async () => {
    await createComp({ name: "Corryong Cup 2026" });
    expect((await lookup({ comp_q: "forbes-flatlands-2026" })).comps).toEqual([]);
  });

  test("rebuilds a dead pilot URL: new ids for the same names", async () => {
    const compId = await createComp({ name: "Corryong Cup 2026" });
    const taskId = await createTask(compId, { name: "Task 1 (Open)" });
    const pilotId = await registerPilot(compId, "Harrison Rowntree");
    await giveManualFlight(taskId, pilotId);

    // The ids from the dead URL are stale; only the slugs still mean anything.
    const body = await lookup({
      comp: "zzzz",
      comp_q: "corryong-cup-2026",
      task_q: "task-1-open",
      pilot_q: "harrison-rowntree",
    });

    expect(body.comps[0].comp_id).toBe(compId);
    expect(body.tasks[0].task_id).toBe(taskId);
    expect(body.pilots[0]).toMatchObject({
      comp_id: compId,
      task_id: taskId,
      comp_pilot_id: pilotId,
      name: "Harrison Rowntree",
      task_name: "Task 1 (Open)",
    });
  });

  test("a comp id that still resolves anchors the search to that comp", async () => {
    const wanted = await createComp({ name: "Corryong Cup 2026" });
    await createTask(wanted, { name: "Task 1 (Open)" });
    const other = await createComp({ name: "Corryong Cup 2020" });
    await createTask(other, { name: "Task 1 (Open)" });

    // Both comps have a "Task 1 (Open)"; the anchor decides which one is meant.
    const body = await lookup({ comp: wanted, comp_q: "corryong", task_q: "task-1-open" });
    expect(body.comps.map((c) => c.comp_id)).toEqual([wanted]);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].comp_id).toBe(wanted);
  });

  test("a pilot with no result anywhere is not a link", async () => {
    const compId = await createComp({ name: "Corryong Cup 2026" });
    await createTask(compId, { name: "Task 1 (Open)" });
    await registerPilot(compId, "Never Flew");
    expect((await lookup({ comp: compId, pilot_q: "never-flew" })).pilots).toEqual([]);
  });

  test("prefers the pilot's result on the task the dead URL named", async () => {
    const compId = await createComp({ name: "Corryong Cup 2026" });
    const t1 = await createTask(compId, { name: "Task 1 (Open)" });
    const t2 = await createTask(compId, { name: "Task 2 (Open)", task_date: "2026-01-06" });
    const pilotId = await registerPilot(compId, "Harrison Rowntree");
    await giveManualFlight(t1, pilotId);
    await giveManualFlight(t2, pilotId);

    const body = await lookup({
      comp: compId,
      task_q: "task-1-open",
      pilot_q: "harrison-rowntree",
    });
    expect(body.pilots).toHaveLength(1);
    expect(body.pilots[0].task_id).toBe(t1);
  });

  test("a hidden test comp stays hidden from anonymous visitors", async () => {
    const compId = await createComp({ name: "Secret Comp", test: true });
    const taskId = await createTask(compId, { name: "Task 1 (Open)" });
    const pilotId = await registerPilot(compId, "Harrison Rowntree");
    await giveManualFlight(taskId, pilotId);

    const anon = await lookup({ comp_q: "secret", task_q: "task-1", pilot_q: "harrison" });
    expect(anon).toEqual({ comps: [], tasks: [], pilots: [] });

    // …and is not reachable by anchoring on its id either.
    expect((await lookup({ comp: compId })).comps).toEqual([]);

    // Its admin still finds it.
    const asAdmin = await lookup({ comp_q: "secret" }, "user-1");
    expect(asAdmin.comps.map((c) => c.name)).toEqual(["Secret Comp"]);
  });

  test("a super admin sees every test comp", async () => {
    const compId = await createComp({ name: "Secret Comp", test: true });
    expect((await lookup({ comp: compId }, "user-super")).comps).toHaveLength(1);
  });

  test("a LIKE wildcard in the query buys nothing", async () => {
    await createComp({ name: "Corryong Cup 2026" });
    await createComp({ name: "Forbes Flatlands 2026" });
    // A bare "%" would match every comp in the database if it were a wildcard.
    expect((await lookup({ comp_q: "%%" })).comps).toEqual([]);
    // And embedded, it is a separator like any other punctuation — the query
    // matches exactly what its words match, no more.
    expect((await lookup({ comp_q: "corryong%2026" })).comps.map((c) => c.name)).toEqual(
      (await lookup({ comp_q: "corryong 2026" })).comps.map((c) => c.name)
    );
    expect((await lookup({ comp_q: "corryong%zzz" })).comps).toEqual([]);
  });

  test("asking for nothing searches nothing", async () => {
    await createComp({ name: "Corryong Cup 2026" });
    expect(await lookup({})).toEqual({ comps: [], tasks: [], pilots: [] });
  });

  test("caps how many competitions one query can return", async () => {
    for (let i = 0; i < 8; i++) await createComp({ name: `Alpine Open ${2020 + i}` });
    expect((await lookup({ comp_q: "alpine-open" })).comps.length).toBeLessThanOrEqual(5);
  });

  test("anonymous answers are shareable; a signed-in one is not", async () => {
    const anon = await request("GET", "/api/comp/lookup?comp_q=corryong");
    expect(anon.headers.get("Cache-Control")).toContain("public");
    const signedIn = await request("GET", "/api/comp/lookup?comp_q=corryong", {
      user: "user-1",
    });
    expect(signedIn.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
