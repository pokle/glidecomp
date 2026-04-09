import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { env } from "cloudflare:test";
import {
  authRequest,
  clearCompData,
  createComp,
  request,
} from "./helpers";

// Shorthand used by many test rows
const basicPilot = (overrides: Record<string, unknown> = {}) => ({
  registered_pilot_name: "Alice Smith",
  pilot_class: "open",
  ...overrides,
});

describe("POST /api/comp/:comp_id/pilot (single create)", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("creates an unlinked pilot with minimal fields", async () => {
    const compId = await createComp({ pilot_classes: ["open", "sport"] });
    const res = await authRequest("POST", `/api/comp/${compId}/pilot`, basicPilot());
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Alice Smith");
    expect(data.pilot_class).toBe("open");
    expect(data.linked).toBe(false);
    expect(data.linked_email).toBeNull();
    expect(data.comp_pilot_id).toBeDefined();
  });

  test("creates a pilot with all 7 sporting body IDs", async () => {
    const compId = await createComp();
    const res = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({
        registered_pilot_civl_id: "C-1",
        registered_pilot_safa_id: "S-1",
        registered_pilot_ushpa_id: "U-1",
        registered_pilot_bhpa_id: "B-1",
        registered_pilot_dhv_id: "D-1",
        registered_pilot_ffvl_id: "F-1",
        registered_pilot_fai_id: "FA-1",
      })
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.civl_id).toBe("C-1");
    expect(data.safa_id).toBe("S-1");
    expect(data.fai_id).toBe("FA-1");
  });

  test("links to an existing pilot by CIVL ID", async () => {
    await env.DB.prepare(
      "INSERT INTO pilot (user_id, name, civl_id) VALUES (?, ?, ?)"
    )
      .bind("user-3", "Carol Wu", "C-42")
      .run();

    const compId = await createComp();
    const res = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({
        registered_pilot_name: "Carol Wu",
        registered_pilot_civl_id: "C-42",
      })
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.linked).toBe(true);
    expect(data.linked_email).toBe("pilot3@test.com");
  });

  test("does not auto-link on name-only match (admin resolves manually)", async () => {
    await env.DB.prepare("INSERT INTO pilot (user_id, name) VALUES (?, ?)")
      .bind("user-3", "Carol Wu")
      .run();

    const compId = await createComp();
    const res = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({ registered_pilot_name: "Carol Wu" })
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.linked).toBe(false);
  });

  test("rejects invalid pilot_class", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });
    const res = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({ pilot_class: "floater" })
    );
    expect(res.status).toBe(400);
  });

  test("rejects duplicate registration of the same linked pilot", async () => {
    await env.DB.prepare(
      "INSERT INTO pilot (user_id, name, civl_id) VALUES (?, ?, ?)"
    )
      .bind("user-3", "Carol Wu", "C-42")
      .run();

    const compId = await createComp();
    await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({
        registered_pilot_name: "Carol Wu",
        registered_pilot_civl_id: "C-42",
      })
    );
    const res = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({
        registered_pilot_name: "Carol Wu",
        registered_pilot_civl_id: "C-42",
      })
    );
    expect(res.status).toBe(409);
  });

  test("requires admin auth", async () => {
    const compId = await createComp();
    const res = await request("POST", `/api/comp/${compId}/pilot`, {
      body: basicPilot(),
      user: "user-3",
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/comp/:comp_id/pilot/:comp_pilot_id", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("updates team and class without touching other fields", async () => {
    const compId = await createComp({ pilot_classes: ["open", "sport"] });
    const create = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({
        registered_pilot_civl_id: "C-1",
        team_name: "Alpha",
      })
    );
    const { comp_pilot_id } = (await create.json()) as { comp_pilot_id: string };

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/pilot/${comp_pilot_id}`,
      { team_name: "Bravo", pilot_class: "sport" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.team_name).toBe("Bravo");
    expect(data.pilot_class).toBe("sport");
    expect(data.civl_id).toBe("C-1"); // unchanged
  });

  test("re-runs resolver when identity fields change", async () => {
    // Seed a linkable target pilot
    await env.DB.prepare(
      "INSERT INTO pilot (user_id, name, civl_id) VALUES (?, ?, ?)"
    )
      .bind("user-3", "Carol Wu", "C-42")
      .run();

    const compId = await createComp();
    // Create an unlinked pilot
    const create = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({ registered_pilot_name: "Carol Wu" })
    );
    const { comp_pilot_id } = (await create.json()) as { comp_pilot_id: string };

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/pilot/${comp_pilot_id}`,
      { registered_pilot_civl_id: "C-42" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.linked).toBe(true);
  });

  test("returns 404 for nonexistent comp_pilot_id", async () => {
    const compId = await createComp();
    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/pilot/zzzz`,
      { team_name: "X" }
    );
    // 400 because sqids decode fails for a random string
    expect([400, 404]).toContain(res.status);
  });
});

describe("DELETE /api/comp/:comp_id/pilot/:comp_pilot_id", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("deletes the pilot", async () => {
    const compId = await createComp();
    const create = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot()
    );
    const { comp_pilot_id } = (await create.json()) as { comp_pilot_id: string };

    const res = await authRequest(
      "DELETE",
      `/api/comp/${compId}/pilot/${comp_pilot_id}`
    );
    expect(res.status).toBe(200);

    const list = await authRequest("GET", `/api/comp/${compId}/pilot`);
    const data = (await list.json()) as { pilots: unknown[] };
    expect(data.pilots).toHaveLength(0);
  });
});

describe("GET /api/comp/:comp_id/pilot", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("returns full records with all IDs and link status", async () => {
    const compId = await createComp();
    await authRequest(
      "POST",
      `/api/comp/${compId}/pilot`,
      basicPilot({
        registered_pilot_civl_id: "C-1",
        registered_pilot_safa_id: "S-1",
        registered_pilot_glider: "Moyes RX",
        driver_contact: "John +61400000000",
        team_name: "Alpha",
      })
    );

    const res = await authRequest("GET", `/api/comp/${compId}/pilot`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      pilots: Array<Record<string, unknown>>;
    };
    expect(data.pilots).toHaveLength(1);
    const p = data.pilots[0];
    expect(p.name).toBe("Alice Smith");
    expect(p.civl_id).toBe("C-1");
    expect(p.safa_id).toBe("S-1");
    expect(p.glider).toBe("Moyes RX");
    expect(p.driver_contact).toBe("John +61400000000");
    expect(p.team_name).toBe("Alpha");
    expect(p.linked).toBe(false);
  });
});

describe("POST /api/comp/:comp_id/pilot/bulk", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("creates multiple new pilots in one request", async () => {
    const compId = await createComp({ pilot_classes: ["open", "sport"] });
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        basicPilot({ registered_pilot_name: "Alice" }),
        basicPilot({ registered_pilot_name: "Bob", pilot_class: "sport" }),
        basicPilot({ registered_pilot_name: "Carol" }),
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      pilots: unknown[];
      deleted: number;
      total: number;
    };
    expect(data.pilots).toHaveLength(3);
    expect(data.deleted).toBe(0);
    expect(data.total).toBe(3);
  });

  test("idempotent re-import — re-posting the same set is a no-op", async () => {
    const compId = await createComp();
    const first = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot/bulk`,
      {
        pilots: [
          basicPilot({ registered_pilot_name: "Alice" }),
          basicPilot({ registered_pilot_name: "Bob" }),
        ],
      }
    );
    const firstData = (await first.json()) as {
      pilots: Array<{ comp_pilot_id: string; name: string }>;
    };

    // Replay: include the comp_pilot_ids and the same field values
    const second = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot/bulk`,
      {
        pilots: firstData.pilots.map((p) =>
          basicPilot({
            comp_pilot_id: p.comp_pilot_id,
            registered_pilot_name: p.name,
          })
        ),
      }
    );
    expect(second.status).toBe(200);
    const secondData = (await second.json()) as {
      pilots: unknown[];
      deleted: number;
    };
    expect(secondData.pilots).toHaveLength(2);
    expect(secondData.deleted).toBe(0);
  });

  test("deletes rows not present in payload", async () => {
    const compId = await createComp();
    const first = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot/bulk`,
      {
        pilots: [
          basicPilot({ registered_pilot_name: "Alice" }),
          basicPilot({ registered_pilot_name: "Bob" }),
          basicPilot({ registered_pilot_name: "Carol" }),
        ],
      }
    );
    const firstData = (await first.json()) as {
      pilots: Array<{ comp_pilot_id: string; name: string }>;
    };

    // Re-post with only Alice — Bob and Carol should be deleted
    const alice = firstData.pilots.find((p) => p.name === "Alice")!;
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        basicPilot({
          comp_pilot_id: alice.comp_pilot_id,
          registered_pilot_name: alice.name,
        }),
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      pilots: unknown[];
      deleted: number;
    };
    expect(data.pilots).toHaveLength(1);
    expect(data.deleted).toBe(2);
  });

  test("updates existing rows by comp_pilot_id", async () => {
    const compId = await createComp();
    const first = await authRequest(
      "POST",
      `/api/comp/${compId}/pilot/bulk`,
      {
        pilots: [basicPilot({ registered_pilot_name: "Alice" })],
      }
    );
    const firstData = (await first.json()) as {
      pilots: Array<{ comp_pilot_id: string }>;
    };
    const id = firstData.pilots[0].comp_pilot_id;

    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        basicPilot({
          comp_pilot_id: id,
          registered_pilot_name: "Alice Updated",
          team_name: "Alpha",
        }),
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      pilots: Array<Record<string, unknown>>;
    };
    expect(data.pilots[0].name).toBe("Alice Updated");
    expect(data.pilots[0].team_name).toBe("Alpha");
  });

  test("rejects invalid pilot_class with per-row errors", async () => {
    const compId = await createComp({ pilot_classes: ["open"] });
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        basicPilot({ registered_pilot_name: "Alice" }),
        basicPilot({ registered_pilot_name: "Bob", pilot_class: "floater" }),
      ],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      errors: Array<{ index: number; error: string }>;
    };
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].index).toBe(1);
    expect(data.errors[0].error).toContain("floater");

    // Nothing was written — atomic
    const list = await authRequest("GET", `/api/comp/${compId}/pilot`);
    const listData = (await list.json()) as { pilots: unknown[] };
    expect(listData.pilots).toHaveLength(0);
  });

  test("rejects payload with two rows resolving to the same pilot", async () => {
    await env.DB.prepare(
      "INSERT INTO pilot (user_id, name, civl_id) VALUES (?, ?, ?)"
    )
      .bind("user-3", "Carol Wu", "C-42")
      .run();

    const compId = await createComp();
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: [
        basicPilot({
          registered_pilot_name: "Carol Wu",
          registered_pilot_civl_id: "C-42",
        }),
        basicPilot({
          registered_pilot_name: "Carol W.",
          registered_pilot_civl_id: "C-42",
        }),
      ],
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as {
      errors: Array<{ index: number; error: string }>;
    };
    expect(data.errors.length).toBeGreaterThan(0);
  });

  test("rejects > 250 rows via Zod", async () => {
    const compId = await createComp();
    const rows = Array.from({ length: 251 }, (_, i) =>
      basicPilot({ registered_pilot_name: `Pilot ${i}` })
    );
    const res = await authRequest("POST", `/api/comp/${compId}/pilot/bulk`, {
      pilots: rows,
    });
    expect(res.status).toBe(400);
  });

  test("requires admin auth", async () => {
    const compId = await createComp();
    const res = await request("POST", `/api/comp/${compId}/pilot/bulk`, {
      body: { pilots: [] },
      user: "user-3",
    });
    expect(res.status).toBe(403);
  });
});
