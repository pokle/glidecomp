import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  authRequest,
  clearCompData,
  createComp,
  createTask,
  request,
  uploadRequest,
} from "./helpers";

/** Minimal valid-looking gzip blob for IGC upload tests. */
function fakeIgcPayload(): Uint8Array {
  // Precomputed gzip of "AXCT001Test\r\nHFDTE010126\r\n" — the minimal
  // content the SEC-04 IGC-shape check requires.
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c,
    0x70, 0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2,
    0x70, 0x73, 0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5,
    0x02, 0x00, 0x19, 0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
  ]);
}

/**
 * Register a pilot in the given comp and return the encoded comp_pilot_id.
 * Uses user-1 as the creating admin; pilot_class defaults to "open".
 */
async function registerPilot(
  compId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: "Alice Lander",
    pilot_class: "open",
    ...overrides,
  });
  const data = (await res.json()) as { comp_pilot_id: string };
  return data.comp_pilot_id;
}

/**
 * Register user-3 (Pilot Three) as a *linked* pilot in the comp so we can
 * test self-service and buddy-marking auth paths.
 */
async function registerLinkedUser3Pilot(compId: string): Promise<string> {
  // Ensure pilot row exists for user-3
  await env.DB.prepare(
    "INSERT OR IGNORE INTO pilot (user_id, name) VALUES (?, ?)"
  )
    .bind("user-3", "Pilot Three")
    .run();
  const res = await authRequest("POST", `/api/comp/${compId}/pilot`, {
    registered_pilot_name: "Pilot Three",
    registered_pilot_email: "pilot3@test.com",
    pilot_class: "open",
  });
  const data = (await res.json()) as { comp_pilot_id: string };
  return data.comp_pilot_id;
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

// ── Fixed vocabulary ────────────────────────────────────────────────────────

describe("fixed pilot status vocabulary", () => {
  test("comp response no longer exposes a configurable pilot_statuses list", async () => {
    const compId = await createComp();
    const res = await authRequest("GET", `/api/comp/${compId}`);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.pilot_statuses).toBeUndefined();
  });

  test("attempting to configure pilot_statuses via PATCH is ignored (field dropped)", async () => {
    const compId = await createComp();
    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com"],
      pilot_statuses: [{ key: "withdrawn", label: "Withdrawn", on_track_upload: "none" }],
    });
    // The unknown field is stripped by the schema; the request still succeeds
    // but no status config is stored (there is no column for it).
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.pilot_statuses).toBeUndefined();
  });
});

// ── PUT pilot status ────────────────────────────────────────────────────────

describe("PUT /api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id", () => {
  test("admin can mark a pilot Absent with the full English label", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "absent", note: "Not at launch" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status_key).toBe("absent");
    expect(data.status_label).toBe("Absent");
    expect(data.note).toBe("Not at launch");

    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE subject_type = 'pilot'"
    ).all<{ description: string }>();
    // Audit uses the full English label, never the TLA.
    expect(
      audit.results.some(
        (r) => r.description.includes("Set status") && r.description.includes("Absent")
      )
    ).toBe(true);
  });

  test("Did Not Fly resolves to its full English label", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "dnf" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status_key).toBe("dnf");
    expect(data.status_label).toBe("Did Not Fly");
  });

  test("changing status replaces the previous one (mutually exclusive)", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "dnf" }
    );
    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "absent" }
    );

    const rows = await env.DB.prepare(
      "SELECT * FROM task_pilot_status WHERE task_id = (SELECT task_id FROM task)"
    ).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status_key).toBe("absent");
  });

  test("rejects a status key outside the fixed set", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);
    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "safely_landed" }
    );
    expect(res.status).toBe(400);
  });

  test("anonymous request is denied", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);
    const res = await request(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { body: { status_key: "absent" } }
    );
    expect(res.status).toBe(401);
  });

  test("self-service: the registered pilot can mark themselves", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerLinkedUser3Pilot(compId);

    // user-3 is the pilot, not an admin
    const res = await request(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      {
        body: { status_key: "dnf", note: "Weather looked bad" },
        user: "user-3",
      }
    );
    expect(res.status).toBe(200);
  });

  test("buddy marking: another registered pilot can mark when open_igc_upload=true", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const targetCompPilotId = await registerLinkedUser3Pilot(compId);

    // Register user-2 as a pilot in the same comp
    await env.DB.prepare(
      "INSERT OR IGNORE INTO pilot (user_id, name) VALUES (?, ?)"
    )
      .bind("user-2", "Admin Two")
      .run();
    await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Admin Two",
      registered_pilot_email: "admin2@test.com",
      pilot_class: "open",
    });

    // open_igc_upload defaults to true
    const res = await request(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${targetCompPilotId}`,
      {
        body: { status_key: "absent" },
        user: "user-2",
      }
    );
    expect(res.status).toBe(200);
  });

  test("buddy marking is denied when open_igc_upload=false", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const targetCompPilotId = await registerLinkedUser3Pilot(compId);

    // Disable open_igc_upload
    await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com"],
      open_igc_upload: false,
    });

    await env.DB.prepare(
      "INSERT OR IGNORE INTO pilot (user_id, name) VALUES (?, ?)"
    )
      .bind("user-2", "Admin Two")
      .run();
    await authRequest("POST", `/api/comp/${compId}/pilot`, {
      registered_pilot_name: "Admin Two",
      registered_pilot_email: "admin2@test.com",
      pilot_class: "open",
    });

    const res = await request(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${targetCompPilotId}`,
      {
        body: { status_key: "absent" },
        user: "user-2",
      }
    );
    expect(res.status).toBe(403);
  });
});

// ── PATCH note inline ───────────────────────────────────────────────────────

describe("PATCH pilot-status (edit note)", () => {
  test("updates note without changing the status key", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "dnf", note: "Sick" }
    );
    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { note: "Sick — withdrew morning of" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status_key).toBe("dnf");
    expect(data.note).toBe("Sick — withdrew morning of");
  });

  test("404 when no status exists to edit", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { note: "whatever" }
    );
    expect(res.status).toBe(404);
  });
});

// ── DELETE pilot status ─────────────────────────────────────────────────────

describe("DELETE pilot-status", () => {
  test("admin can clear a status (back to Present)", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "dnf" }
    );
    const res = await authRequest(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`
    );
    expect(res.status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT * FROM task_pilot_status"
    ).all();
    expect(rows.results).toHaveLength(0);

    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE subject_type = 'pilot'"
    ).all<{ description: string }>();
    expect(
      audit.results.some(
        (r) => r.description.includes("Cleared status") && r.description.includes("Present")
      )
    ).toBe(true);
  });
});

// ── GET pilot status list ───────────────────────────────────────────────────

describe("GET pilot-status", () => {
  test("lists all statuses for a task with full English labels", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const cp1 = await registerPilot(compId, {
      registered_pilot_name: "Alice",
    });
    const cp2 = await registerPilot(compId, {
      registered_pilot_name: "Bob",
    });

    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${cp1}`,
      { status_key: "landed" }
    );
    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${cp2}`,
      { status_key: "dnf", note: "Flu" }
    );

    // Public GET (no auth)
    const res = await request(
      "GET",
      `/api/comp/${compId}/task/${taskId}/pilot-status`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      statuses: Array<Record<string, unknown>>;
    };
    expect(data.statuses).toHaveLength(2);
    const alice = data.statuses.find((s) => s.pilot_name === "Alice")!;
    expect(alice.status_key).toBe("landed");
    expect(alice.status_label).toBe("Landed");
    const bob = data.statuses.find((s) => s.pilot_name === "Bob")!;
    expect(bob.status_key).toBe("dnf");
    expect(bob.status_label).toBe("Did Not Fly");
    expect(bob.note).toBe("Flu");
  });
});

// ── Track upload hook ───────────────────────────────────────────────────────

describe("uploading a track marks the pilot Landed", () => {
  test("a prior Did Not Fly is overridden by Landed on upload", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Register user-3 (linked) then mark as Did Not Fly
    const compPilotId = await registerLinkedUser3Pilot(compId);
    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "dnf", note: "Did not fly" }
    );

    // user-3 now uploads a track for themselves
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-3" }
    );
    expect(res.status).toBe(201);

    // Status is now Landed (note cleared)
    const rows = await env.DB.prepare(
      "SELECT status_key, note FROM task_pilot_status WHERE task_id = (SELECT task_id FROM task)"
    ).all<{ status_key: string; note: string | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status_key).toBe("landed");
    expect(rows.results[0].note).toBeNull();

    // Audit log records the automatic Landed set.
    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log"
    ).all<{ description: string }>();
    expect(
      audit.results.some(
        (r) =>
          r.description.includes('Set status "Landed"') &&
          r.description.includes("track was uploaded")
      )
    ).toBe(true);
  });

  test("a pilot with no prior status becomes Landed on upload", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerLinkedUser3Pilot(compId);

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-3" }
    );
    expect(res.status).toBe(201);

    const rows = await env.DB.prepare(
      "SELECT status_key FROM task_pilot_status WHERE comp_pilot_id = (SELECT comp_pilot_id FROM comp_pilot LIMIT 1)"
    ).all<{ status_key: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status_key).toBe("landed");
    expect(compPilotId).toBeTruthy();
  });
});

// ── Launch validity: a status change is a scoring input ──────────────────────

describe("status changes mark scores stale", () => {
  test("marking a pilot Did Not Fly bumps the task's score inputs", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    // Read the current inputs_rev (may be absent until first bump).
    const before = await env.DB.prepare(
      "SELECT inputs_rev FROM task_scores WHERE task_id = (SELECT task_id FROM task)"
    ).first<{ inputs_rev: number }>();

    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "dnf" }
    );
    expect(res.status).toBe(200);

    const after = await env.DB.prepare(
      "SELECT inputs_rev FROM task_scores WHERE task_id = (SELECT task_id FROM task)"
    ).first<{ inputs_rev: number }>();
    // A placeholder row now exists (inputs bumped) even though the task had
    // never been scored before.
    expect(after).not.toBeNull();
    expect(after!.inputs_rev).toBeGreaterThan(before?.inputs_rev ?? 0);
  });
});
