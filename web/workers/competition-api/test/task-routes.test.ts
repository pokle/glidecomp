import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  request,
  authRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";
import { encodeId } from "../src/sqids";

const ALPHABET = env.SQIDS_ALPHABET;

beforeEach(async () => {
  await clearCompData();
});

// ── POST /api/comp/:comp_id/task ──────────────────────────────────────────

describe("POST /api/comp/:comp_id/task", () => {
  test("creates a task and returns encoded ID", async () => {
    const compId = await createComp({
      pilot_classes: ["open", "sport"],
      default_pilot_class: "open",
    });

    const res = await authRequest("POST", `/api/comp/${compId}/task`, {
      name: "Day 1",
      task_date: "2026-01-15",
      pilot_classes: ["open", "sport"],
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Day 1");
    expect(data.task_date).toBe("2026-01-15");
    expect(data.has_xctsk).toBe(false);
    expect(data.pilot_classes).toEqual(["open", "sport"]);
    expect(typeof data.task_id).toBe("string");
    expect((data.task_id as string).length).toBeGreaterThanOrEqual(4);

    // Verify in D1
    const row = await env.DB.prepare("SELECT * FROM task").first();
    expect(row!.name).toBe("Day 1");

    // Verify task_class entries
    const tc = await env.DB.prepare("SELECT * FROM task_class").all();
    expect(tc.results.length).toBe(2);
  });

  test("rejects pilot classes not in comp", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });

    const res = await authRequest("POST", `/api/comp/${compId}/task`, {
      name: "Bad Task",
      task_date: "2026-01-15",
      pilot_classes: ["open", "novice"],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("novice");
  });

  test("rejects invalid task_date format", async () => {
    const compId = await createComp();

    const res = await authRequest("POST", `/api/comp/${compId}/task`, {
      name: "Bad Date",
      task_date: "January 15",
      pilot_classes: ["open"],
    });
    expect(res.status).toBe(400);
  });

  test("rejects unauthenticated requests", async () => {
    const compId = await createComp();

    const res = await request("POST", `/api/comp/${compId}/task`, {
      body: { name: "No Auth", task_date: "2026-01-15", pilot_classes: ["open"] },
    });
    expect(res.status).toBe(401);
  });

  test("rejects non-admin requests", async () => {
    const compId = await createComp();

    const res = await request("POST", `/api/comp/${compId}/task`, {
      body: { name: "Not Admin", task_date: "2026-01-15", pilot_classes: ["open"] },
      user: "user-2",
    });
    expect(res.status).toBe(403);
  });

  test("enforces 50 tasks per comp limit", async () => {
    const compId = await createComp();

    // Resolve numeric comp_id from DB
    const compRow = await env.DB.prepare("SELECT comp_id FROM comp").first<{ comp_id: number }>();
    const numericCompId = compRow!.comp_id;

    // Insert 50 tasks directly
    for (let i = 0; i < 50; i++) {
      await env.DB.prepare(
        "INSERT INTO task (comp_id, name, task_date, creation_date) VALUES (?, ?, ?, ?)"
      )
        .bind(numericCompId, `Task ${i}`, "2026-01-15", new Date().toISOString())
        .run();
    }

    const res = await authRequest("POST", `/api/comp/${compId}/task`, {
      name: "One Too Many",
      task_date: "2026-01-15",
      pilot_classes: ["open"],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("50");
  });

  test("rejects missing name", async () => {
    const compId = await createComp();

    const res = await authRequest("POST", `/api/comp/${compId}/task`, {
      task_date: "2026-01-15",
      pilot_classes: ["open"],
    });
    expect(res.status).toBe(400);
  });

  test("rejects empty pilot_classes", async () => {
    const compId = await createComp();

    const res = await authRequest("POST", `/api/comp/${compId}/task`, {
      name: "No Classes",
      task_date: "2026-01-15",
      pilot_classes: [],
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/comp/:comp_id/task/:task_id ──────────────────────────────────

describe("GET /api/comp/:comp_id/task/:task_id", () => {
  test("returns task details", async () => {
    const compId = await createComp({
      pilot_classes: ["open", "sport"],
      default_pilot_class: "open",
    });
    const taskId = await createTask(compId, {
      name: "Day 1",
      pilot_classes: ["open", "sport"],
    });

    const res = await authRequest(
      "GET",
      `/api/comp/${compId}/task/${taskId}`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Day 1");
    expect(data.task_id).toBe(taskId);
    expect(data.xctsk).toBeNull();
    expect(data.pilot_classes).toEqual(["open", "sport"]);
    expect(data.track_count).toBe(0);
  });

  test("allows anonymous access to non-test comp task", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}`
    );
    expect(res.status).toBe(200);
  });

  test("hides test comp task from non-admin", async () => {
    const compId = await createComp({ test: true });
    const taskId = await createTask(compId);

    const res = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}`,
      { user: "user-2" }
    );
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent task", async () => {
    const compId = await createComp();
    const fakeTaskId = encodeId(ALPHABET, 99999);

    const res = await authRequest(
      "GET",
      `/api/comp/${compId}/task/${fakeTaskId}`
    );
    expect(res.status).toBe(404);
  });

  test("returns 404 for task in wrong comp", async () => {
    const compId1 = await createComp({ name: "Comp 1" });
    const compId2 = await createComp({ name: "Comp 2" });
    const taskId = await createTask(compId1);

    const res = await authRequest(
      "GET",
      `/api/comp/${compId2}/task/${taskId}`
    );
    expect(res.status).toBe(404);
  });
});

// ── PATCH /api/comp/:comp_id/task/:task_id ────────────────────────────────

describe("PATCH /api/comp/:comp_id/task/:task_id", () => {
  test("updates task name", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { name: "Updated Name" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("Updated Name");
  });

  test("updates task date", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { task_date: "2026-02-20" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { task_date: string };
    expect(data.task_date).toBe("2026-02-20");
  });

  test("updates xctsk data", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const xctsk = {
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [
        {
          type: "SSS",
          radius: 1000,
          waypoint: { name: "Start", lat: -37.0, lon: 144.0 },
        },
      ],
    };

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { xctsk }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { xctsk: unknown };
    expect(data.xctsk).toEqual(xctsk);
  });

  test("clears xctsk with null", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Set xctsk
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: { taskType: "CLASSIC" },
    });

    // Clear it
    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { xctsk: null }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { xctsk: unknown };
    expect(data.xctsk).toBeNull();
  });

  test("updates pilot classes", async () => {
    const compId = await createComp({
      pilot_classes: ["open", "sport", "floater"],
      default_pilot_class: "open",
    });
    const taskId = await createTask(compId, {
      pilot_classes: ["open"],
    });

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { pilot_classes: ["open", "sport"] }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pilot_classes: string[] };
    expect(data.pilot_classes).toEqual(
      expect.arrayContaining(["open", "sport"])
    );
    expect(data.pilot_classes.length).toBe(2);
  });

  test("rejects invalid pilot classes", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });
    const taskId = await createTask(compId);

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { pilot_classes: ["open", "novice"] }
    );
    expect(res.status).toBe(400);
  });

  test("rejects non-admin updates", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await request(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { body: { name: "Hacked" }, user: "user-2" }
    );
    expect(res.status).toBe(403);
  });

  test("rejects unauthenticated updates", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await request(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}`,
      { body: { name: "Hacked" } }
    );
    expect(res.status).toBe(401);
  });
});

// ── DELETE /api/comp/:comp_id/task/:task_id ───────────────────────────────

describe("DELETE /api/comp/:comp_id/task/:task_id", () => {
  test("deletes a task and cascades task_class", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await authRequest(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}`
    );
    expect(res.status).toBe(200);

    // Verify task is gone
    const getRes = await authRequest(
      "GET",
      `/api/comp/${compId}/task/${taskId}`
    );
    expect(getRes.status).toBe(404);

    // Verify task_class rows cascaded
    const tcRow = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM task_class"
    ).first<{ cnt: number }>();
    expect(tcRow!.cnt).toBe(0);
  });

  test("rejects unauthenticated delete", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await request(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}`
    );
    expect(res.status).toBe(401);
  });

  test("rejects non-admin delete", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await request(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}`,
      { user: "user-2" }
    );
    expect(res.status).toBe(403);
  });

  test("returns 404 for non-existent task", async () => {
    const compId = await createComp();
    const fakeTaskId = encodeId(ALPHABET, 99999);

    const res = await authRequest(
      "DELETE",
      `/api/comp/${compId}/task/${fakeTaskId}`
    );
    expect(res.status).toBe(404);
  });
});
