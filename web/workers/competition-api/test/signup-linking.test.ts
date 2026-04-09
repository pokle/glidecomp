import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  authRequest,
  clearCompData,
  createComp,
  createTask,
  request,
  uploadRequest,
} from "./helpers";
import { decodeId } from "../src/sqids";

const ALPHABET = env.SQIDS_ALPHABET;

function fakeIgcPayload(): Uint8Array {
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

/**
 * Create an admin-registered (unlinked) comp_pilot row directly in D1.
 * Returns the comp_pilot_id so tests can verify linking after the fact.
 */
async function seedPreRegistration(
  compId: number,
  fields: {
    name: string;
    email?: string;
    civl_id?: string;
    safa_id?: string;
  }
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO comp_pilot (
      comp_id, pilot_id,
      registered_pilot_name, registered_pilot_email,
      registered_pilot_civl_id, registered_pilot_safa_id,
      pilot_class
    ) VALUES (?, NULL, ?, ?, ?, ?, ?)`
  )
    .bind(
      compId,
      fields.name,
      fields.email ?? null,
      fields.civl_id ?? null,
      fields.safa_id ?? null,
      "open"
    )
    .run();
  return res.meta.last_row_id;
}

/** Decode a sqid-encoded comp/task id back to its numeric form. */
function sqidToNumber(encoded: string): number {
  const id = decodeId(ALPHABET, encoded);
  if (id === null) throw new Error(`Invalid sqid: ${encoded}`);
  return id;
}

describe("8g signup linking via PATCH /api/comp/pilot", () => {
  beforeEach(async () => {
    await clearCompData();
  });
  afterEach(async () => {
    await clearCompData();
  });

  test("PATCH with civl_id links a matching pre-registration", async () => {
    // user-1 (Test Pilot) is the admin; we use them as the seeding actor.
    // The "target" user we're linking is user-2 (Admin Two).
    const compIdEncoded = await createComp({ name: "Bells 2026" });
    const compId = sqidToNumber(compIdEncoded);

    // Admin pre-registers Alice with a CIVL ID (user-2's CIVL)
    const preRegId = await seedPreRegistration(compId, {
      name: "Alice Smith",
      civl_id: "CIVL-42",
    });

    // user-2 signs up and updates their profile with the matching CIVL ID
    const res = await request("PATCH", "/api/comp/pilot", {
      body: { civl_id: "CIVL-42" },
      user: "user-2",
    });
    expect(res.status).toBe(200);

    // The pre-registration should now be linked to user-2's pilot row
    const preReg = await env.DB.prepare(
      "SELECT pilot_id FROM comp_pilot WHERE comp_pilot_id = ?"
    )
      .bind(preRegId)
      .first<{ pilot_id: number | null }>();
    expect(preReg!.pilot_id).not.toBeNull();

    // Verify it's user-2's pilot
    const userPilot = await env.DB.prepare(
      "SELECT pilot_id FROM pilot WHERE user_id = ?"
    )
      .bind("user-2")
      .first<{ pilot_id: number }>();
    expect(preReg!.pilot_id).toBe(userPilot!.pilot_id);
  });

  test("PATCH writes an audit entry for each link", async () => {
    const compIdEncoded = await createComp({ name: "Bells 2026" });
    const compId = sqidToNumber(compIdEncoded);
    await seedPreRegistration(compId, {
      name: "Alice Smith",
      civl_id: "CIVL-99",
    });

    await request("PATCH", "/api/comp/pilot", {
      body: { civl_id: "CIVL-99" },
      user: "user-2",
    });

    const auditRow = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE description LIKE ? ORDER BY audit_id DESC LIMIT 1"
    )
      .bind("%Linked pre-registered pilot%")
      .first<{ description: string }>();
    expect(auditRow).not.toBeNull();
    expect(auditRow!.description).toContain("Alice Smith");
    expect(auditRow!.description).toContain("matched by civl_id");
  });

  test("matches by email via user.email join", async () => {
    const compIdEncoded = await createComp();
    const compId = sqidToNumber(compIdEncoded);

    // user-2's email is admin2@test.com
    const preRegId = await seedPreRegistration(compId, {
      name: "Alice Smith",
      email: "admin2@test.com",
    });

    // Trigger linking by updating the pilot profile (any update will do;
    // we use name so we don't need to supply an ID)
    await request("PATCH", "/api/comp/pilot", {
      body: { name: "Admin Two" },
      user: "user-2",
    });

    const preReg = await env.DB.prepare(
      "SELECT pilot_id FROM comp_pilot WHERE comp_pilot_id = ?"
    )
      .bind(preRegId)
      .first<{ pilot_id: number | null }>();
    expect(preReg!.pilot_id).not.toBeNull();
  });

  test("does NOT link on name-only match (reserved for manual review)", async () => {
    const compIdEncoded = await createComp();
    const compId = sqidToNumber(compIdEncoded);

    // Pre-registration has name only, no IDs, no email
    const preRegId = await seedPreRegistration(compId, {
      name: "Admin Two",
    });

    // user-2's profile update has no CIVL ID
    await request("PATCH", "/api/comp/pilot", {
      body: { name: "Admin Two" },
      user: "user-2",
    });

    const preReg = await env.DB.prepare(
      "SELECT pilot_id FROM comp_pilot WHERE comp_pilot_id = ?"
    )
      .bind(preRegId)
      .first<{ pilot_id: number | null }>();
    expect(preReg!.pilot_id).toBeNull();
  });

  test("does NOT link pre-registrations in closed comps", async () => {
    // Closed comp — close_date yesterday
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const compIdEncoded = await createComp({ close_date: yesterday });
    const compId = sqidToNumber(compIdEncoded);

    const preRegId = await seedPreRegistration(compId, {
      name: "Alice",
      civl_id: "CIVL-CLOSED",
    });

    await request("PATCH", "/api/comp/pilot", {
      body: { civl_id: "CIVL-CLOSED" },
      user: "user-2",
    });

    const preReg = await env.DB.prepare(
      "SELECT pilot_id FROM comp_pilot WHERE comp_pilot_id = ?"
    )
      .bind(preRegId)
      .first<{ pilot_id: number | null }>();
    expect(preReg!.pilot_id).toBeNull();
  });

  test("links across multiple open comps in one pass", async () => {
    // Two separate competitions each with a pre-registration for the same person
    const comp1Encoded = await createComp({ name: "Comp 1" });
    await env.DB.prepare(
      `INSERT INTO comp_admin (comp_id, user_id)
       SELECT comp_id, 'user-2' FROM comp WHERE name = 'Comp 1'`
    ).run();
    const comp1 = (await env.DB.prepare(
      "SELECT comp_id FROM comp WHERE name = 'Comp 1'"
    ).first<{ comp_id: number }>())!.comp_id;
    // Make second comp owned by user-2 too so it's visible
    const comp2Res = await request("POST", "/api/comp", {
      body: { name: "Comp 2", category: "hg" },
      user: "user-2",
    });
    const comp2Data = (await comp2Res.json()) as { comp_id: string };
    const comp2 = (await env.DB.prepare(
      "SELECT comp_id FROM comp WHERE name = 'Comp 2'"
    ).first<{ comp_id: number }>())!.comp_id;
    void comp2Data;

    const preReg1 = await seedPreRegistration(comp1, {
      name: "Alice",
      civl_id: "CIVL-MULTI",
    });
    const preReg2 = await seedPreRegistration(comp2, {
      name: "Alice",
      civl_id: "CIVL-MULTI",
    });

    await request("PATCH", "/api/comp/pilot", {
      body: { civl_id: "CIVL-MULTI" },
      user: "user-3",
    });

    const rows = await env.DB.prepare(
      "SELECT comp_pilot_id, pilot_id FROM comp_pilot WHERE comp_pilot_id IN (?, ?)"
    )
      .bind(preReg1, preReg2)
      .all<{ comp_pilot_id: number; pilot_id: number | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((r) => r.pilot_id !== null)).toBe(true);
  });
});

describe("8g signup linking via IGC upload path", () => {
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

  test("IGC upload claims a pre-registration instead of creating a duplicate", async () => {
    const compIdEncoded = await createComp();
    const compId = sqidToNumber(compIdEncoded);
    const taskId = await createTask(compIdEncoded);

    // Admin pre-registered user-2 by CIVL ID
    const preRegId = await seedPreRegistration(compId, {
      name: "Alice Smith",
      civl_id: "CIVL-IGC",
    });

    // user-2 sets their CIVL ID in profile (happens before upload in typical flow)
    await request("PATCH", "/api/comp/pilot", {
      body: { civl_id: "CIVL-IGC" },
      user: "user-2",
    });

    // Actually — the profile update linking may have already claimed
    // the row. That's fine. Either path should leave exactly one
    // comp_pilot row linked to user-2 in this comp.
    await uploadRequest(
      `/api/comp/${compIdEncoded}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );

    const rows = await env.DB.prepare(
      `SELECT cp.comp_pilot_id, cp.registered_pilot_name FROM comp_pilot cp
       JOIN pilot p ON cp.pilot_id = p.pilot_id
       WHERE p.user_id = ? AND cp.comp_id = ?`
    )
      .bind("user-2", compId)
      .all<{ comp_pilot_id: number; registered_pilot_name: string }>();
    expect(rows.results).toHaveLength(1);
    // It should be the original pre-registration (name "Alice Smith")
    expect(rows.results[0].comp_pilot_id).toBe(preRegId);
    expect(rows.results[0].registered_pilot_name).toBe("Alice Smith");
  });

  test("IGC upload claims on first upload even when profile has no CIVL ID", async () => {
    const compIdEncoded = await createComp();
    const compId = sqidToNumber(compIdEncoded);
    const taskId = await createTask(compIdEncoded);

    // Admin pre-registered user-2 by email (user-2's actual test email)
    const preRegId = await seedPreRegistration(compId, {
      name: "Alice Smith",
      email: "admin2@test.com",
    });

    // user-2 goes directly to upload without touching profile
    const res = await uploadRequest(
      `/api/comp/${compIdEncoded}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );
    expect(res.status).toBe(201);

    // There should still be exactly one comp_pilot row for user-2, and
    // it should be the pre-registration (claimed via email match).
    const rows = await env.DB.prepare(
      `SELECT cp.comp_pilot_id FROM comp_pilot cp
       JOIN pilot p ON cp.pilot_id = p.pilot_id
       WHERE p.user_id = ? AND cp.comp_id = ?`
    )
      .bind("user-2", compId)
      .all<{ comp_pilot_id: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].comp_pilot_id).toBe(preRegId);
  });

  test("audit records on-first-upload linking", async () => {
    const compIdEncoded = await createComp();
    const compId = sqidToNumber(compIdEncoded);
    const taskId = await createTask(compIdEncoded);

    await seedPreRegistration(compId, {
      name: "Alice Smith",
      email: "admin2@test.com",
    });

    await uploadRequest(
      `/api/comp/${compIdEncoded}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-2" }
    );

    const auditRow = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE description LIKE ? LIMIT 1"
    )
      .bind("%Linked pre-registered pilot%on first upload%")
      .first<{ description: string }>();
    expect(auditRow).not.toBeNull();
  });
});

