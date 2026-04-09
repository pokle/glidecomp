import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  authRequest,
  clearCompData,
  createComp,
  createTask,
  request,
} from "./helpers";

/** Fetch audit entries for a comp (public endpoint). */
async function getAudit(
  compId: string,
  query: Record<string, string> = {}
): Promise<{
  entries: Array<Record<string, unknown>>;
  has_more: boolean;
  next_before: number | null;
}> {
  const qs = new URLSearchParams(query).toString();
  const res = await request(
    "GET",
    `/api/comp/${compId}/audit${qs ? "?" + qs : ""}`
  );
  return (await res.json()) as {
    entries: Array<Record<string, unknown>>;
    has_more: boolean;
    next_before: number | null;
  };
}

describe("audit log write-through", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("comp creation writes an entry", async () => {
    const compId = await createComp({ name: "Bells 2026" });
    const { entries } = await getAudit(compId);
    expect(entries).toHaveLength(1);
    expect(entries[0].subject_type).toBe("comp");
    expect(entries[0].description).toBe('Created competition "Bells 2026"');
    expect(entries[0].actor_name).toBe("Test Pilot");
  });

  test("comp PATCH writes one entry per changed field", async () => {
    const compId = await createComp({ name: "Initial" });
    await authRequest("PATCH", `/api/comp/${compId}`, {
      name: "Renamed",
      close_date: "2026-12-01",
    });
    const { entries } = await getAudit(compId);
    const descs = entries.map((e) => e.description as string);
    // Plus the create entry
    expect(entries.length).toBe(3);
    expect(descs.some((d) => d.includes("Renamed"))).toBe(true);
    expect(descs.some((d) => d.includes("close date"))).toBe(true);
  });

  test("comp PATCH with no actual changes writes nothing", async () => {
    const compId = await createComp({ name: "Bells" });
    await authRequest("PATCH", `/api/comp/${compId}`, { name: "Bells" });
    const { entries } = await getAudit(compId);
    // Only the create entry should be present
    expect(entries).toHaveLength(1);
  });

  test("task create + delete are both audited", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId, { name: "Task 3" });
    await authRequest("DELETE", `/api/comp/${compId}/task/${taskId}`);
    const { entries } = await getAudit(compId);
    const descs = entries.map((e) => e.description as string);
    expect(descs.some((d) => d.includes('Created task "Task 3"'))).toBe(true);
    expect(descs.some((d) => d.includes('Deleted task "Task 3"'))).toBe(true);
  });

  test("task xctsk set + update include details", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const xctsk1 = {
      taskType: "CLASSIC",
      version: 1,
      turnpoints: [
        { type: "TAKEOFF", radius: 400, waypoint: { name: "Launch", lat: -38.1, lon: 144.5 } },
        { type: "SSS", radius: 3000, waypoint: { name: "Start", lat: -38.2, lon: 144.6 } },
        { radius: 1000, waypoint: { name: "TP1", lat: -38.3, lon: 144.7 } },
        { type: "ESS", radius: 400, waypoint: { name: "Goal", lat: -38.4, lon: 144.8 } },
      ],
      sss: { type: "RACE", direction: "EXIT" },
      goal: { type: "CYLINDER" },
    };
    const xctsk2 = {
      ...xctsk1,
      turnpoints: xctsk1.turnpoints.map((tp, i) =>
        i === 2 ? { ...tp, radius: 2000 } : tp
      ),
    };
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: xctsk1,
    });
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      xctsk: xctsk2,
    });
    const { entries } = await getAudit(compId);
    const taskDescs = entries
      .filter((e) => e.subject_type === "task")
      .map((e) => e.description as string);
    // Set entry mentions turnpoint count and goal type
    expect(taskDescs.some((d) => d.includes("Set task route") && d.includes("4 turnpoints"))).toBe(true);
    // Update entry mentions the radius change on TP3
    expect(taskDescs.some((d) => d.includes("Updated task route") && d.includes("radius"))).toBe(true);
  });

  test("pilot create + update + delete are audited", async () => {
    const compId = await createComp({ pilot_classes: ["open", "sport"] });
    const create = await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Alice",
      pilot_class: "open",
    });
    const { comp_pilot_id } = (await create.json()) as {
      comp_pilot_id: string;
    };

    await authRequest("PATCH", `/api/comp/${compId}/pilot/${comp_pilot_id}`, {
      team_name: "Alpha",
      pilot_class: "sport",
    });

    await authRequest(
      "DELETE",
      `/api/comp/${compId}/pilot/${comp_pilot_id}`
    );

    const { entries } = await getAudit(compId);
    const pilotDescs = entries
      .filter((e) => e.subject_type === "pilot")
      .map((e) => e.description as string);

    expect(pilotDescs.some((d) => d.includes('Registered pilot "Alice"'))).toBe(
      true
    );
    expect(
      pilotDescs.some((d) => d.toLowerCase().includes("team"))
    ).toBe(true);
    expect(
      pilotDescs.some((d) => d.toLowerCase().includes("class"))
    ).toBe(true);
    expect(pilotDescs.some((d) => d.includes('Removed pilot "Alice"'))).toBe(
      true
    );
  });

  test("bulk pilot update rolls up when > 5 changes", async () => {
    const compId = await createComp();
    const pilots = Array.from({ length: 8 }, (_, i) => ({
      registered_pilot_name: `Pilot ${i}`,
      pilot_class: "open",
    }));
    await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, { pilots });

    const { entries } = await getAudit(compId);
    const pilotDescs = entries
      .filter((e) => e.subject_type === "pilot")
      .map((e) => e.description as string);
    // Should be a single rollup entry, not 8 individual ones
    expect(pilotDescs).toHaveLength(1);
    expect(pilotDescs[0]).toContain("Bulk pilot update");
    expect(pilotDescs[0]).toContain("8 added");
  });

  test("bulk with 3 rows writes per-row entries (under rollup threshold)", async () => {
    const compId = await createComp();
    await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        { registered_pilot_name: "A", pilot_class: "open" },
        { registered_pilot_name: "B", pilot_class: "open" },
        { registered_pilot_name: "C", pilot_class: "open" },
      ],
    });
    const { entries } = await getAudit(compId);
    const pilotDescs = entries
      .filter((e) => e.subject_type === "pilot")
      .map((e) => e.description as string);
    expect(pilotDescs).toHaveLength(3);
    expect(pilotDescs.every((d) => d.startsWith("Registered pilot"))).toBe(true);
  });
});

describe("GET /api/comp/:comp_id/audit", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("returns entries newest first", async () => {
    const compId = await createComp();
    await createTask(compId, { name: "Task A" });
    await createTask(compId, { name: "Task B" });

    const { entries } = await getAudit(compId);
    // Latest created first; 3 entries (comp + 2 tasks)
    expect(entries).toHaveLength(3);
    expect(entries[0].description).toContain("Task B");
    expect(entries[1].description).toContain("Task A");
    expect(entries[2].description).toContain("Created competition");
  });

  test("supports pagination via limit + before cursor", async () => {
    const compId = await createComp();
    // 6 tasks + 1 comp create = 7 entries total
    for (let i = 0; i < 6; i++) {
      await createTask(compId, { name: `Task ${i}` });
    }

    const page1 = await getAudit(compId, { limit: "5" });
    expect(page1.entries).toHaveLength(5);
    expect(page1.has_more).toBe(true);
    expect(page1.next_before).not.toBeNull();
    // First page is newest: Task 5, 4, 3, 2, 1
    expect(page1.entries[0].description).toContain("Task 5");

    const page2 = await getAudit(compId, {
      limit: "5",
      before: String(page1.next_before),
    });
    // 2 remaining: Task 0 + comp creation
    expect(page2.entries).toHaveLength(2);
    expect(page2.has_more).toBe(false);
    expect(page2.entries[0].description).toContain("Task 0");
    expect(page2.entries[1].description).toContain("Created competition");
  });

  test("filters by subject_type", async () => {
    const compId = await createComp();
    await createTask(compId);
    await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Alice",
      pilot_class: "open",
    });

    const tasksOnly = await getAudit(compId, { subject_type: "task" });
    expect(tasksOnly.entries.every((e) => e.subject_type === "task")).toBe(true);

    const pilotsOnly = await getAudit(compId, { subject_type: "pilot" });
    expect(pilotsOnly.entries.every((e) => e.subject_type === "pilot")).toBe(true);
  });

  test("public for non-test comps, hidden for test comps without admin auth", async () => {
    const publicComp = await createComp({ name: "Public" });
    const testComp = await createComp({ name: "Test Private", test: true });

    // Unauthenticated: public OK, test returns 404
    const pubRes = await request("GET", `/api/comp/${publicComp}/audit`);
    expect(pubRes.status).toBe(200);
    const testRes = await request("GET", `/api/comp/${testComp}/audit`);
    expect(testRes.status).toBe(404);

    // Admin can see test comp audit
    const testAdminRes = await authRequest(
      "GET",
      `/api/comp/${testComp}/audit`
    );
    expect(testAdminRes.status).toBe(200);
  });

  test("rejects invalid query params", async () => {
    const compId = await createComp();
    const res = await request(
      "GET",
      `/api/comp/${compId}/audit?limit=999999`
    );
    expect(res.status).toBe(400);
  });
});
