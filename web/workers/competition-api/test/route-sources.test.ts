import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authRequest, clearCompData, createComp, createTask, request } from "./helpers";
import { nearestDistance, orderCandidates } from "../src/route-sources";

/** A three-point route starting at (lat, lon). */
function routeAt(lat: number, lon: number, name = "Launch") {
  return {
    taskType: "CLASSIC",
    version: 1,
    turnpoints: [
      { type: "TAKEOFF", radius: 400, waypoint: { name, lat, lon } },
      { type: "SSS", radius: 3000, waypoint: { name: "Start", lat: lat + 0.05, lon } },
      { radius: 400, waypoint: { name: "Goal", lat: lat + 0.2, lon: lon + 0.2 } },
    ],
  };
}

// Three sites: Corryong (VIC), Manilla (NSW, ~650 km north), Bright (VIC,
// ~70 km south-west of Corryong).
const CORRYONG = { lat: -36.19, lon: 147.97 };
const MANILLA = { lat: -30.72, lon: 150.66 };
const BRIGHT = { lat: -36.73, lon: 146.96 };

interface Source {
  comp_name: string;
  task_name: string;
  this_comp: boolean;
  turnpoints: string[];
  distance_m: number | null;
}

async function sources(compId: string, taskId: string, q?: string, user = "user-1") {
  const res = await request(
    "GET",
    `/api/comp/${compId}/task/${taskId}/route-sources${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    { user }
  );
  return res;
}

async function sourceList(compId: string, taskId: string, q?: string) {
  const res = await sources(compId, taskId, q);
  expect(res.status).toBe(200);
  return (await res.json()) as { reference: string; more: boolean; routes: Source[] };
}

describe("ordering routes by distance", () => {
  test("measures to the NEAREST reference point, exactly", () => {
    const measure = nearestDistance([CORRYONG, MANILLA])!;
    // Bright is nearer Corryong than Manilla.
    const toBright = measure(BRIGHT);
    expect(toBright).toBeGreaterThan(80_000);
    expect(toBright).toBeLessThan(120_000);
    expect(measure(CORRYONG)).toBe(0);
  });

  test("no reference points means no distances, and newest first", () => {
    expect(nearestDistance([])).toBeNull();
    const ordered = orderCandidates(
      [
        { task_id: 1, task_date: "2024-01-05", start: CORRYONG },
        { task_id: 2, task_date: "2026-01-05", start: MANILLA },
      ],
      []
    );
    expect(ordered.map((c) => c.task_id)).toEqual([2, 1]);
    expect(ordered.every((c) => c.distance_m === null)).toBe(true);
  });

  test("nearest first; within a kilometre, newest first; no start last", () => {
    const ordered = orderCandidates(
      [
        { task_id: 1, task_date: "2020-01-05", start: CORRYONG },
        { task_id: 2, task_date: "2026-01-05", start: MANILLA },
        { task_id: 3, task_date: "2025-01-05", start: { lat: CORRYONG.lat + 0.001, lon: CORRYONG.lon } },
        { task_id: 4, task_date: "2026-02-01", start: null },
        { task_id: 5, task_date: "2019-01-05", start: BRIGHT },
      ],
      [CORRYONG]
    );
    expect(ordered.map((c) => c.task_id)).toEqual([3, 1, 5, 2, 4]);
  });
});

describe("GET /api/comp/:comp_id/task/:task_id/route-sources", () => {
  beforeEach(clearCompData);
  afterEach(clearCompData);

  test("sorts other comps' routes nearest to this comp's waypoints first", async () => {
    const manilla = await createComp({ name: "Manilla Open" });
    await createTask(manilla, { name: "Manilla T1", task_date: "2026-03-01", xctsk: routeAt(MANILLA.lat, MANILLA.lon, "MANILA") });
    const bright = await createComp({ name: "Bright Open" });
    await createTask(bright, { name: "Bright T1", task_date: "2025-01-01", xctsk: routeAt(BRIGHT.lat, BRIGHT.lon, "MYSTIC") });
    const last = await createComp({ name: "Corryong Cup 2026" });
    await createTask(last, { name: "Task 1", task_date: "2024-01-05", xctsk: routeAt(CORRYONG.lat, CORRYONG.lon, "ELLIOT") });

    const here = await createComp({ name: "Corryong Cup 2027" });
    await authRequest("PUT", `/api/comp/${here}/waypoints`, {
      waypoints: [
        { code: "ELLIOT", name: "Mt Elliot", latitude: CORRYONG.lat, longitude: CORRYONG.lon, radius: 400 },
      ],
    });
    const task = await createTask(here, { name: "Task 1" });

    const list = await sourceList(here, task);
    expect(list.reference).toBe("waypoints");
    expect(list.routes.map((r) => r.task_name)).toEqual(["Task 1", "Bright T1", "Manilla T1"]);
    expect(list.routes[0]).toMatchObject({
      comp_name: "Corryong Cup 2026",
      this_comp: false,
      turnpoints: ["ELLIOT", "Start", "Goal"],
      distance_m: 0,
    });
    expect(list.routes[2].distance_m).toBeGreaterThan(500_000);
  });

  test("uses this comp's routes when it has no waypoints, and offers them too", async () => {
    const manilla = await createComp({ name: "Manilla Open" });
    await createTask(manilla, { name: "Manilla T1", task_date: "2026-03-01", xctsk: routeAt(MANILLA.lat, MANILLA.lon) });
    const here = await createComp({ name: "Bright Open" });
    await createTask(here, { name: "Monday", xctsk: routeAt(BRIGHT.lat, BRIGHT.lon) });
    const tuesday = await createTask(here, { name: "Tuesday" });

    const list = await sourceList(here, tuesday);
    expect(list.reference).toBe("routes");
    expect(list.routes.map((r) => [r.task_name, r.this_comp])).toEqual([
      ["Monday", true],
      ["Manilla T1", false],
    ]);
  });

  test("anything goes, newest first, when the comp knows no place yet", async () => {
    const a = await createComp({ name: "Older" });
    await createTask(a, { name: "Old", task_date: "2024-01-01", xctsk: routeAt(CORRYONG.lat, CORRYONG.lon) });
    const b = await createComp({ name: "Newer" });
    await createTask(b, { name: "New", task_date: "2026-01-01", xctsk: routeAt(MANILLA.lat, MANILLA.lon) });
    const here = await createComp({ name: "Fresh" });
    const task = await createTask(here);

    const list = await sourceList(here, task);
    expect(list.reference).toBe("none");
    expect(list.routes.map((r) => [r.task_name, r.distance_m])).toEqual([
      ["New", null],
      ["Old", null],
    ]);
  });

  test("never offers the task itself, or a task with no route", async () => {
    const here = await createComp();
    const task = await createTask(here, { name: "Self", xctsk: routeAt(CORRYONG.lat, CORRYONG.lon) });
    await createTask(here, { name: "No route" });
    const list = await sourceList(here, task);
    expect(list.routes).toEqual([]);
    // Its own saved route still says where the comp is.
    expect(list.reference).toBe("routes");
  });

  test("narrows by words in the comp or task name", async () => {
    const a = await createComp({ name: "Corryong Cup 2026" });
    await createTask(a, { name: "Task 1", xctsk: routeAt(CORRYONG.lat, CORRYONG.lon) });
    const b = await createComp({ name: "Manilla Open" });
    await createTask(b, { name: "Task 1", xctsk: routeAt(MANILLA.lat, MANILLA.lon) });
    const here = await createComp();
    const task = await createTask(here);

    expect((await sourceList(here, task, "manilla")).routes.map((r) => r.comp_name)).toEqual([
      "Manilla Open",
    ]);
    expect((await sourceList(here, task, "cup task")).routes.map((r) => r.comp_name)).toEqual([
      "Corryong Cup 2026",
    ]);
    // A LIKE wildcard is a character to look for, not a wildcard.
    expect((await sourceList(here, task, "%")).routes).toEqual([]);
  });

  test("offers a hidden comp's routes to its organisers only", async () => {
    const hidden = await createComp({ name: "Secret Comp", test: true });
    await createTask(hidden, { name: "Secret task", xctsk: routeAt(CORRYONG.lat, CORRYONG.lon) });

    const mine = await createComp();
    const myTask = await createTask(mine);
    expect((await sourceList(mine, myTask)).routes.map((r) => r.comp_name)).toEqual(["Secret Comp"]);

    // user-2 organises a comp of their own, and must not learn of the hidden one.
    const theirs = (await (
      await request("POST", "/api/comp", { body: { name: "Theirs", category: "hg", test: false }, user: "user-2" })
    ).json()) as { comp_id: string };
    const theirTask = (await (
      await request("POST", `/api/comp/${theirs.comp_id}/task`, {
        body: { name: "T", task_date: "2026-01-05", pilot_classes: ["open"] },
        user: "user-2",
      })
    ).json()) as { task_id: string };
    const res = await sources(theirs.comp_id, theirTask.task_id, undefined, "user-2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { routes: Source[] };
    expect(body.routes.map((r) => r.comp_name)).not.toContain("Secret Comp");
  });

  test("is for the comp's organisers", async () => {
    const here = await createComp();
    const task = await createTask(here);
    expect((await sources(here, task, undefined, "user-2")).status).toBe(403);
  });

  test("404s a task of another comp", async () => {
    const here = await createComp();
    const other = await createComp();
    const task = await createTask(other);
    expect((await sources(here, task)).status).toBe(404);
  });
});
