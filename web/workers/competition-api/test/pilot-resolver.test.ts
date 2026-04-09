import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolvePilotId } from "../src/pilot-resolver";
import { clearCompData } from "./helpers";

/**
 * Seed a pilot row linked to an existing test user, with optional ID columns.
 * Returns the new pilot_id.
 */
async function seedPilot(
  userId: string,
  name: string,
  ids: Partial<{
    civl_id: string;
    safa_id: string;
    ushpa_id: string;
    bhpa_id: string;
    dhv_id: string;
    ffvl_id: string;
    fai_id: string;
  }> = {}
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO pilot (user_id, name, civl_id, safa_id, ushpa_id, bhpa_id, dhv_id, ffvl_id, fai_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      userId,
      name,
      ids.civl_id ?? null,
      ids.safa_id ?? null,
      ids.ushpa_id ?? null,
      ids.bhpa_id ?? null,
      ids.dhv_id ?? null,
      ids.ffvl_id ?? null,
      ids.fai_id ?? null
    )
    .run();
  return res.meta.last_row_id;
}

describe("resolvePilotId", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("returns null with no fields", async () => {
    const res = await resolvePilotId(env.DB, {});
    expect(res.pilot_id).toBeNull();
    expect(res.matched_by).toBeNull();
    expect(res.nameOnlyCandidates).toEqual([]);
  });

  test("matches by CIVL ID (highest priority)", async () => {
    const pilotId = await seedPilot("user-1", "Alice", { civl_id: "12345" });
    const res = await resolvePilotId(env.DB, { civl_id: "12345" });
    expect(res.pilot_id).toBe(pilotId);
    expect(res.matched_by).toBe("civl_id");
  });

  test("matches by SAFA ID when CIVL not given", async () => {
    const pilotId = await seedPilot("user-1", "Alice", { safa_id: "SA-42" });
    const res = await resolvePilotId(env.DB, { safa_id: "SA-42" });
    expect(res.pilot_id).toBe(pilotId);
    expect(res.matched_by).toBe("safa_id");
  });

  test("matches by other sporting body IDs", async () => {
    const ushpa = await seedPilot("user-1", "Alice", { ushpa_id: "U-1" });
    const bhpa = await seedPilot("user-2", "Bob", { bhpa_id: "B-2" });
    const dhv = await seedPilot("user-3", "Carl", { dhv_id: "D-3" });

    expect((await resolvePilotId(env.DB, { ushpa_id: "U-1" })).pilot_id).toBe(ushpa);
    expect((await resolvePilotId(env.DB, { bhpa_id: "B-2" })).pilot_id).toBe(bhpa);
    expect((await resolvePilotId(env.DB, { dhv_id: "D-3" })).pilot_id).toBe(dhv);
  });

  test("CIVL ID wins even when other IDs are also provided", async () => {
    const civlPilot = await seedPilot("user-1", "Alice", { civl_id: "C-1" });
    await seedPilot("user-2", "Bob", { safa_id: "S-2" });

    // Admin-entered row claims CIVL "C-1" and SAFA "S-2" — CIVL wins.
    const res = await resolvePilotId(env.DB, { civl_id: "C-1", safa_id: "S-2" });
    expect(res.pilot_id).toBe(civlPilot);
    expect(res.matched_by).toBe("civl_id");
  });

  test("matches by email via user table join", async () => {
    const pilotId = await seedPilot("user-1", "Alice");
    const res = await resolvePilotId(env.DB, { email: "pilot@test.com" });
    expect(res.pilot_id).toBe(pilotId);
    expect(res.matched_by).toBe("email");
  });

  test("email match only when no ID match", async () => {
    const civlPilot = await seedPilot("user-1", "Alice", { civl_id: "C-1" });
    await seedPilot("user-2", "Bob");
    const res = await resolvePilotId(env.DB, {
      civl_id: "C-1",
      email: "admin2@test.com", // matches user-2
    });
    // Civl takes priority
    expect(res.pilot_id).toBe(civlPilot);
    expect(res.matched_by).toBe("civl_id");
  });

  test("name-only match returns candidates but pilot_id null", async () => {
    const pilotId = await seedPilot("user-1", "Alice Smith");
    const res = await resolvePilotId(env.DB, { name: "Alice Smith" });
    expect(res.pilot_id).toBeNull();
    expect(res.matched_by).toBeNull();
    expect(res.nameOnlyCandidates).toEqual([pilotId]);
  });

  test("name match is case insensitive", async () => {
    const pilotId = await seedPilot("user-1", "Alice Smith");
    const res = await resolvePilotId(env.DB, { name: "alice smith" });
    expect(res.nameOnlyCandidates).toEqual([pilotId]);
  });

  test("name-only with multiple candidates returns all", async () => {
    const a = await seedPilot("user-1", "Bob Jones");
    const b = await seedPilot("user-2", "Bob Jones");
    const res = await resolvePilotId(env.DB, { name: "Bob Jones" });
    expect(res.pilot_id).toBeNull();
    expect(res.nameOnlyCandidates.sort()).toEqual([a, b].sort());
  });

  test("no match at all returns empty", async () => {
    await seedPilot("user-1", "Alice", { civl_id: "C-1" });
    const res = await resolvePilotId(env.DB, {
      civl_id: "NOT-A-MATCH",
      email: "nobody@nowhere.com",
      name: "Ghost Pilot",
    });
    expect(res.pilot_id).toBeNull();
    expect(res.matched_by).toBeNull();
    expect(res.nameOnlyCandidates).toEqual([]);
  });

  test("empty-string fields are treated as missing", async () => {
    const pilotId = await seedPilot("user-1", "Alice", { civl_id: "C-1" });
    const res = await resolvePilotId(env.DB, {
      civl_id: "   ",
      safa_id: "",
      name: "Alice",
    });
    // CIVL and SAFA fields are blank → fall through to name
    expect(res.pilot_id).toBeNull();
    expect(res.nameOnlyCandidates).toEqual([pilotId]);
  });

  test("ignores unlinked comp_pilot rows (only pilot table is searched)", async () => {
    // Create a comp_pilot with registered_pilot_civl_id but no pilot row with that ID
    // The resolver only consults the pilot table, so this should not match.
    const compRes = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, category) VALUES (?, ?, ?)`
    )
      .bind("Test", "2026-01-01", "hg")
      .run();
    await env.DB.prepare(
      `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, registered_pilot_civl_id, pilot_class)
       VALUES (?, NULL, ?, ?, ?)`
    )
      .bind(compRes.meta.last_row_id, "Ghost", "GHOST-1", "open")
      .run();

    const res = await resolvePilotId(env.DB, { civl_id: "GHOST-1" });
    expect(res.pilot_id).toBeNull();
  });
});

describe("migration 0005: schema", () => {
  test("pilot table has flat sporting body ID columns", async () => {
    // Inserting all 7 columns should succeed
    await env.DB.prepare(
      `INSERT INTO pilot (user_id, name, civl_id, safa_id, ushpa_id, bhpa_id, dhv_id, ffvl_id, fai_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind("user-1", "Alice", "C", "S", "U", "B", "D", "F", "FA")
      .run();

    const row = await env.DB.prepare(
      "SELECT civl_id, safa_id, ushpa_id, bhpa_id, dhv_id, ffvl_id, fai_id FROM pilot WHERE user_id = ?"
    )
      .bind("user-1")
      .first();
    expect(row).toMatchObject({
      civl_id: "C",
      safa_id: "S",
      ushpa_id: "U",
      bhpa_id: "B",
      dhv_id: "D",
      ffvl_id: "F",
      fai_id: "FA",
    });

    await clearCompData();
  });

  test("pilot.sporting_body_ids column no longer exists", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(pilot)").all<{
      name: string;
    }>();
    const columnNames = result.results.map((r) => r.name);
    expect(columnNames).not.toContain("sporting_body_ids");
    expect(columnNames).toContain("civl_id");
    expect(columnNames).toContain("safa_id");
  });

  test("comp_pilot allows multiple unlinked rows per comp (pilot_id IS NULL)", async () => {
    const compRes = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, category) VALUES (?, ?, ?)`
    )
      .bind("Test", "2026-01-01", "hg")
      .run();
    const compId = compRes.meta.last_row_id;

    // Two unlinked rows in the same comp should succeed
    await env.DB.prepare(
      `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class)
       VALUES (?, NULL, ?, ?)`
    )
      .bind(compId, "Alice", "open")
      .run();
    await env.DB.prepare(
      `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class)
       VALUES (?, NULL, ?, ?)`
    )
      .bind(compId, "Bob", "open")
      .run();

    const count = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM comp_pilot WHERE comp_id = ?"
    )
      .bind(compId)
      .first<{ cnt: number }>();
    expect(count?.cnt).toBe(2);

    await clearCompData();
  });

  test("comp_pilot rejects duplicate linked rows (partial unique index)", async () => {
    const compRes = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, category) VALUES (?, ?, ?)`
    )
      .bind("Test", "2026-01-01", "hg")
      .run();
    const compId = compRes.meta.last_row_id;

    const pilotRes = await env.DB.prepare(
      `INSERT INTO pilot (user_id, name) VALUES (?, ?)`
    )
      .bind("user-1", "Alice")
      .run();
    const pilotId = pilotRes.meta.last_row_id;

    await env.DB.prepare(
      `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class)
       VALUES (?, ?, ?, ?)`
    )
      .bind(compId, pilotId, "Alice", "open")
      .run();

    // Second insert with same (comp, pilot) should fail
    await expect(
      env.DB.prepare(
        `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class)
         VALUES (?, ?, ?, ?)`
      )
        .bind(compId, pilotId, "Alice", "open")
        .run()
    ).rejects.toThrow();

    await clearCompData();
  });

  test("comp has open_igc_upload column defaulting to 1", async () => {
    const compRes = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, category) VALUES (?, ?, ?)`
    )
      .bind("Test", "2026-01-01", "hg")
      .run();

    const row = await env.DB.prepare(
      "SELECT open_igc_upload FROM comp WHERE comp_id = ?"
    )
      .bind(compRes.meta.last_row_id)
      .first<{ open_igc_upload: number }>();
    expect(row?.open_igc_upload).toBe(1);

    await clearCompData();
  });

  test("task_track has uploaded_by_user_id and uploaded_by_name columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(task_track)").all<{
      name: string;
    }>();
    const columnNames = result.results.map((r) => r.name);
    expect(columnNames).toContain("uploaded_by_user_id");
    expect(columnNames).toContain("uploaded_by_name");
  });

  test("audit_log table exists with expected columns", async () => {
    const result = await env.DB.prepare("PRAGMA table_info(audit_log)").all<{
      name: string;
    }>();
    const columnNames = result.results.map((r) => r.name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "audit_id",
        "comp_id",
        "timestamp",
        "actor_user_id",
        "actor_name",
        "subject_type",
        "subject_id",
        "subject_name",
        "description",
      ])
    );
  });

  test("audit_log can be inserted and queried by comp_id", async () => {
    const compRes = await env.DB.prepare(
      `INSERT INTO comp (name, creation_date, category) VALUES (?, ?, ?)`
    )
      .bind("Test", "2026-01-01", "hg")
      .run();
    const compId = compRes.meta.last_row_id;

    await env.DB.prepare(
      `INSERT INTO audit_log (comp_id, timestamp, actor_user_id, actor_name, subject_type, subject_id, subject_name, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        compId,
        "2026-04-08T10:00:00Z",
        "user-1",
        "Test Pilot",
        "task",
        1,
        "Task 1",
        "Created task Task 1"
      )
      .run();

    const rows = await env.DB.prepare(
      "SELECT * FROM audit_log WHERE comp_id = ? ORDER BY timestamp DESC"
    )
      .bind(compId)
      .all<Record<string, unknown>>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].description).toBe("Created task Task 1");
    expect(rows.results[0].actor_name).toBe("Test Pilot");

    await clearCompData();
  });
});
