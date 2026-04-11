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
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
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

// ── Default comp config ─────────────────────────────────────────────────────

describe("comp default pilot_statuses", () => {
  test("new comp exposes the default safely_landed + dnf statuses", async () => {
    const compId = await createComp();
    const res = await authRequest("GET", `/api/comp/${compId}`);
    const data = (await res.json()) as {
      pilot_statuses: Array<{ key: string; label: string; on_track_upload: string }>;
    };
    expect(data.pilot_statuses).toEqual([
      { key: "safely_landed", label: "Safely landed", on_track_upload: "none" },
      { key: "dnf", label: "DNF", on_track_upload: "clear" },
    ]);
  });
});

// ── PATCH comp settings: pilot_statuses ─────────────────────────────────────

describe("PATCH /api/comp/:comp_id (pilot_statuses)", () => {
  test("admin can replace the status set", async () => {
    const compId = await createComp();
    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com"],
      pilot_statuses: [
        { key: "landed_ok", label: "Landed OK", on_track_upload: "none" },
        { key: "dnf", label: "Did Not Fly", on_track_upload: "clear" },
        { key: "withdrawn", label: "Withdrawn", on_track_upload: "none" },
      ],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pilot_statuses: unknown[] };
    expect(data.pilot_statuses).toHaveLength(3);

    // Audit entries: 1 add ("landed_ok"), 1 update ("dnf" label), 1 add ("withdrawn"), 1 remove ("safely_landed")
    const rows = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE comp_id = (SELECT comp_id FROM comp) AND subject_type = 'comp'"
    ).all<{ description: string }>();
    const descriptions = rows.results.map((r) => r.description);
    expect(descriptions.some((d) => d.includes("Added pilot status") && d.includes("landed_ok"))).toBe(true);
    expect(descriptions.some((d) => d.includes("Updated pilot status") && d.includes("dnf"))).toBe(true);
    expect(descriptions.some((d) => d.includes("Added pilot status") && d.includes("withdrawn"))).toBe(true);
    expect(descriptions.some((d) => d.includes("Removed pilot status") && d.includes("safely_landed"))).toBe(true);
  });

  test("rejects duplicate status keys", async () => {
    const compId = await createComp();
    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com"],
      pilot_statuses: [
        { key: "dup", label: "A", on_track_upload: "none" },
        { key: "dup", label: "B", on_track_upload: "clear" },
      ],
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid on_track_upload value", async () => {
    const compId = await createComp();
    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com"],
      pilot_statuses: [{ key: "x", label: "X", on_track_upload: "bogus" }],
    });
    expect(res.status).toBe(400);
  });
});

// ── PUT pilot status ────────────────────────────────────────────────────────

describe("PUT /api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id", () => {
  test("admin can set a status for a pilot", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);

    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "safely_landed", note: "Radioed in from LZ3" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status_key).toBe("safely_landed");
    expect(data.status_label).toBe("Safely landed");
    expect(data.note).toBe("Radioed in from LZ3");

    // Audit entry should describe the set
    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE subject_type = 'pilot'"
    ).all<{ description: string }>();
    expect(audit.results.some((r) => r.description.includes("Set status") && r.description.includes("Safely landed"))).toBe(true);
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
      { status_key: "safely_landed" }
    );

    const rows = await env.DB.prepare(
      "SELECT * FROM task_pilot_status WHERE task_id = (SELECT task_id FROM task)"
    ).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status_key).toBe("safely_landed");
  });

  test("rejects unknown status_key", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const compPilotId = await registerPilot(compId);
    const res = await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "bogus_key" }
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
      { body: { status_key: "safely_landed" } }
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
        body: { status_key: "safely_landed", note: "I'm safe" },
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
        body: { status_key: "safely_landed" },
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
        body: { status_key: "safely_landed" },
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
  test("admin can clear a status", async () => {
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
  });
});

// ── GET pilot status list ───────────────────────────────────────────────────

describe("GET pilot-status", () => {
  test("lists all statuses for a task with labels resolved", async () => {
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
      { status_key: "safely_landed" }
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
    expect(alice.status_key).toBe("safely_landed");
    expect(alice.status_label).toBe("Safely landed");
    const bob = data.statuses.find((s) => s.pilot_name === "Bob")!;
    expect(bob.status_key).toBe("dnf");
    expect(bob.status_label).toBe("DNF");
    expect(bob.note).toBe("Flu");
  });
});

// ── Track upload hook ───────────────────────────────────────────────────────

describe("track upload clears DNF status", () => {
  test("default config: DNF is cleared when a track is uploaded", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Register user-3 (linked) then mark as DNF
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

    // DNF should be gone
    const rows = await env.DB.prepare(
      "SELECT * FROM task_pilot_status WHERE task_id = (SELECT task_id FROM task)"
    ).all();
    expect(rows.results).toHaveLength(0);

    // Audit log should mention the automatic clear
    const audit = await env.DB.prepare(
      "SELECT description FROM audit_log"
    ).all<{ description: string }>();
    expect(
      audit.results.some(
        (r) =>
          r.description.includes("Cleared status") &&
          r.description.includes("DNF") &&
          r.description.includes("track was uploaded")
      )
    ).toBe(true);
  });

  test("safely_landed is preserved when a track is uploaded", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const compPilotId = await registerLinkedUser3Pilot(compId);
    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "safely_landed" }
    );

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-3" }
    );
    expect(res.status).toBe(201);

    const rows = await env.DB.prepare(
      "SELECT status_key FROM task_pilot_status"
    ).all<{ status_key: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].status_key).toBe("safely_landed");
  });

  test("custom clear-on-upload status is also cleared", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Reconfigure with a custom status that clears on upload
    await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com"],
      pilot_statuses: [
        { key: "dnf", label: "DNF", on_track_upload: "clear" },
        { key: "forgot_tracker", label: "Forgot tracker", on_track_upload: "clear" },
      ],
    });

    const compPilotId = await registerLinkedUser3Pilot(compId);
    await authRequest(
      "PUT",
      `/api/comp/${compId}/task/${taskId}/pilot-status/${compPilotId}`,
      { status_key: "forgot_tracker" }
    );

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload(),
      { user: "user-3" }
    );
    expect(res.status).toBe(201);

    const rows = await env.DB.prepare(
      "SELECT * FROM task_pilot_status"
    ).all();
    expect(rows.results).toHaveLength(0);
  });
});
