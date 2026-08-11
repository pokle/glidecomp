import { describe, expect, test, beforeEach } from "vitest";
import {
  authRequest,
  clearCompData,
  createComp,
  createTask,
  isoDaysFromToday,
  request,
} from "./helpers";

/**
 * This endpoint keys off `new Date()`, not off SAMPLE_TASK_DATE, so every task
 * here is dated RELATIVE to today. A fixture date would pass on the day it was
 * written and silently stop covering anything afterwards.
 */
async function compWithTaskOn(
  dayOffset: number,
  overrides: Record<string, unknown> = {}
) {
  const compId = await createComp(overrides);
  const taskId = await createTask(compId, {
    task_date: isoDaysFromToday(dayOffset),
  });
  return { compId, taskId };
}

async function openNow() {
  const res = await request("GET", "/api/comp/open-now");
  return {
    res,
    body: (await res.json()) as {
      generated_at: string;
      window: { from: string; to: string; today: string };
      comps: {
        comp_id: string;
        name: string;
        suggested_task_id: string;
        tasks: { task_id: string; task_date: string; pilot_classes: string[] }[];
      }[];
    },
  };
}

beforeEach(async () => {
  await clearCompData();
});

describe("GET /api/comp/open-now", () => {
  test("lists a competition flying today, with its tasks", async () => {
    const { compId, taskId } = await compWithTaskOn(0, { name: "Corryong Cup" });

    const { res, body } = await openNow();
    expect(res.status).toBe(200);
    expect(body.comps).toHaveLength(1);
    expect(body.comps[0].comp_id).toBe(compId);
    expect(body.comps[0].name).toBe("Corryong Cup");
    expect(body.comps[0].tasks[0].task_id).toBe(taskId);
    expect(body.comps[0].tasks[0].pilot_classes).toEqual(["open"]);
    // Today's task is the one-click answer.
    expect(body.comps[0].suggested_task_id).toBe(taskId);
  });

  test("is answerable without signing in and is edge-cacheable", async () => {
    await compWithTaskOn(0);
    const { res } = await openNow();
    expect(res.status).toBe(200);
    // The body does not vary by caller, which is what makes one shared cached
    // answer correct.
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  test("keeps a comp inside the two-day window either side of today", async () => {
    await compWithTaskOn(-2, { name: "Just Finished" });
    await compWithTaskOn(2, { name: "Starts Soon" });
    const { body } = await openNow();
    expect(body.comps.map((c) => c.name).sort()).toEqual([
      "Just Finished",
      "Starts Soon",
    ]);
  });

  test("drops a comp whose only task is well outside the window", async () => {
    await compWithTaskOn(10, { name: "Next Month" });
    const { body } = await openNow();
    expect(body.comps).toHaveLength(0);
  });

  test("never lists a hidden test comp", async () => {
    await compWithTaskOn(0, { name: "Scratch", test: true });
    const { body } = await openNow();
    // A submit flow must not be how somebody discovers a hidden comp.
    expect(body.comps).toHaveLength(0);
  });

  test("drops a comp that has closed for submissions", async () => {
    await compWithTaskOn(0, { name: "Closed", close_date: "2020-01-01" });
    const { body } = await openNow();
    expect(body.comps).toHaveLength(0);
  });

  test("drops a comp that asks pilots to sign in", async () => {
    const { compId } = await compWithTaskOn(0, { name: "Signed In Only" });
    await authRequest("PATCH", `/api/comp/${compId}`, {
      open_igc_upload: false,
    });
    const { body } = await openNow();
    expect(body.comps).toHaveLength(0);
  });

  test("puts the comp flying today ahead of the one flying in two days", async () => {
    await compWithTaskOn(2, { name: "Later" });
    await compWithTaskOn(0, { name: "Today" });
    const { body } = await openNow();
    expect(body.comps.map((c) => c.name)).toEqual(["Today", "Later"]);
  });

  test("suggests the most recent task already flown when none is today", async () => {
    const compId = await createComp({ name: "Multi Day" });
    await createTask(compId, { name: "Task 1", task_date: isoDaysFromToday(-2) });
    const yesterday = await createTask(compId, {
      name: "Task 2",
      task_date: isoDaysFromToday(-1),
    });

    const { body } = await openNow();
    // A pilot uploads after landing, so the past beats the future on a tie.
    expect(body.comps[0].suggested_task_id).toBe(yesterday);
  });

  test("lists a comp's tasks most recent first", async () => {
    // A pilot submits after landing, so the task they mean is at the recent
    // end. On day six of a comp, oldest-first makes them read past five days
    // they have already filed to reach the one they want.
    const compId = await createComp({ name: "Multi Day" });
    await createTask(compId, { name: "Task 1", task_date: isoDaysFromToday(-2) });
    await createTask(compId, { name: "Task 2", task_date: isoDaysFromToday(-1) });
    await createTask(compId, { name: "Task 3", task_date: isoDaysFromToday(0) });

    const { body } = await openNow();
    expect(body.comps[0].tasks.map((t) => t.task_date)).toEqual([
      isoDaysFromToday(0),
      isoDaysFromToday(-1),
      isoDaysFromToday(-2),
    ]);
  });

  test("two tasks on one day keep a stable order", async () => {
    // Same date is the ordinary case for a comp flying two classes, and an
    // unstable sort there would reshuffle the list between cached answers.
    const compId = await createComp({ name: "Two Classes" });
    await createTask(compId, { name: "Task 3 (Sports)", task_date: isoDaysFromToday(0) });
    await createTask(compId, { name: "Task 3 (Open)", task_date: isoDaysFromToday(0) });

    const { body } = await openNow();
    expect(body.comps[0].tasks.map((t) => t.name)).toEqual([
      "Task 3 (Open)",
      "Task 3 (Sports)",
    ]);
  });

  test("the suggestion survives the display order being reversed", async () => {
    // The suggestion is derived from the DATES, not from the array's ends.
    // It used to read tasks[tasks.length - 1], which silently meant "oldest"
    // the moment the wire order flipped.
    const compId = await createComp({ name: "Multi Day" });
    await createTask(compId, { name: "Task 1", task_date: isoDaysFromToday(-2) });
    const yesterday = await createTask(compId, {
      name: "Task 2",
      task_date: isoDaysFromToday(-1),
    });

    const { body } = await openNow();
    expect(body.comps[0].suggested_task_id).toBe(yesterday);
    // And it is the one now shown at the top.
    expect(body.comps[0].tasks[0].task_id).toBe(yesterday);
  });

  test("reports the window it used, so a cached answer is diagnosable", async () => {
    await compWithTaskOn(0);
    const { body } = await openNow();
    expect(body.window.today).toBe(isoDaysFromToday(0));
    expect(body.window.from).toBe(isoDaysFromToday(-2));
    expect(body.window.to).toBe(isoDaysFromToday(2));
    expect(typeof body.generated_at).toBe("string");
  });
});
