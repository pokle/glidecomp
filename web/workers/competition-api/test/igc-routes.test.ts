import { SELF, env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import {
  request,
  authRequest,
  uploadRequest,
  createComp,
  createTask,
  clearCompData,
} from "./helpers";
import { encodeId } from "../src/sqids";

const ALPHABET = env.SQIDS_ALPHABET;

/** Create a fake gzip-compressed IGC payload. */
function fakeIgcPayload(): Uint8Array {
  // A minimal gzip blob (not a valid IGC, but sufficient for upload tests)
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

/** Shorthand: upload IGC as user-1 */
function uploadIgc(compId: string, taskId: string, user = "user-1") {
  return uploadRequest(`/api/comp/${compId}/task/${taskId}/igc`, fakeIgcPayload(), { user });
}

beforeEach(async () => {
  await clearCompData();
  // Clean up R2
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

// ── POST /api/comp/:comp_id/task/:task_id/igc ────────────────────────────

describe("POST .../igc (upload)", () => {
  test("uploads IGC and auto-registers pilot", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const payload = fakeIgcPayload();

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      payload,
      { user: "user-1" }
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.replaced).toBe(false);
    expect(typeof data.task_track_id).toBe("string");
    expect(typeof data.comp_pilot_id).toBe("string");

    // Verify pilot was auto-created
    const pilot = await env.DB.prepare("SELECT * FROM pilot WHERE user_id = ?")
      .bind("user-1")
      .first();
    expect(pilot).not.toBeNull();
    expect(pilot!.name).toBe("Test Pilot");

    // Verify comp_pilot was auto-created
    const cp = await env.DB.prepare("SELECT * FROM comp_pilot WHERE pilot_id = ?")
      .bind(pilot!.pilot_id)
      .first();
    expect(cp).not.toBeNull();
    expect(cp!.pilot_class).toBe("open");

    // Verify task_track was created
    const tt = await env.DB.prepare("SELECT * FROM task_track").first();
    expect(tt).not.toBeNull();
    expect(tt!.file_size).toBe(payload.byteLength);

    // Verify R2 object exists
    const r2Obj = await env.R2.get(tt!.igc_filename as string);
    expect(r2Obj).not.toBeNull();
  });

  test("re-upload replaces track but preserves penalties", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // First upload
    const res1 = await uploadIgc(compId, taskId);
    expect(res1.status).toBe(201);

    // Set penalty on the track
    const tt = await env.DB.prepare("SELECT task_track_id FROM task_track").first<{ task_track_id: number }>();
    await env.DB.prepare(
      "UPDATE task_track SET penalty_points = 50, penalty_reason = 'Airspace' WHERE task_track_id = ?"
    )
      .bind(tt!.task_track_id)
      .run();

    // Re-upload
    const res2 = await uploadIgc(compId, taskId);
    expect(res2.status).toBe(200);
    const data = (await res2.json()) as Record<string, unknown>;
    expect(data.replaced).toBe(true);

    // Verify penalty was preserved
    const updated = await env.DB.prepare("SELECT penalty_points, penalty_reason FROM task_track").first();
    expect(updated!.penalty_points).toBe(50);
    expect(updated!.penalty_reason).toBe("Airspace");
  });

  test("rejects upload when comp is closed", async () => {
    const compId = await createComp({ close_date: "2020-01-01T00:00:00Z" });
    const taskId = await createTask(compId);

    const res = await uploadIgc(compId, taskId);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("closed");
  });

  test("rejects unauthenticated upload", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      fakeIgcPayload()
    );
    expect(res.status).toBe(401);
  });

  test("rejects empty body", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc`,
      new Uint8Array(0),
      { user: "user-1" }
    );
    expect(res.status).toBe(400);
  });

  test("enforces 250 pilots per task limit", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Get numeric IDs
    const compRow = await env.DB.prepare("SELECT comp_id FROM comp").first<{ comp_id: number }>();
    const taskRow = await env.DB.prepare("SELECT task_id FROM task").first<{ task_id: number }>();

    // Insert 250 fake pilots + comp_pilots + task_tracks directly
    for (let i = 0; i < 250; i++) {
      const userId = `fake-user-${i}`;
      await env.DB.prepare(
        `INSERT OR REPLACE INTO "user" (id, name, email, "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?)`
      ).bind(userId, `Pilot ${i}`, `pilot${i}@test.com`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();

      await env.DB.prepare(
        "INSERT INTO pilot (user_id, name) VALUES (?, ?)"
      ).bind(userId, `Pilot ${i}`).run();

      const pilotRow = await env.DB.prepare("SELECT pilot_id FROM pilot WHERE user_id = ?")
        .bind(userId).first<{ pilot_id: number }>();

      await env.DB.prepare(
        "INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class) VALUES (?, ?, ?, ?)"
      ).bind(compRow!.comp_id, pilotRow!.pilot_id, `Pilot ${i}`, "open").run();

      const cpRow = await env.DB.prepare(
        "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ? AND pilot_id = ?"
      ).bind(compRow!.comp_id, pilotRow!.pilot_id).first<{ comp_pilot_id: number }>();

      await env.DB.prepare(
        "INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size) VALUES (?, ?, ?, ?, ?)"
      ).bind(taskRow!.task_id, cpRow!.comp_pilot_id, `fake-${i}.igc`, "2026-01-15T00:00:00Z", 100).run();
    }

    // Now try to upload as user-1 (new pilot, 251st)
    const res = await uploadIgc(compId, taskId);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("250");
  });
});

// ── GET /api/comp/:comp_id/task/:task_id/igc ─────────────────────────────

describe("GET .../igc (list tracks)", () => {
  test("lists tracks with pilot info", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Upload a track
    await uploadIgc(compId, taskId);

    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/igc`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { tracks: Array<Record<string, unknown>> };
    expect(data.tracks.length).toBe(1);
    expect(data.tracks[0].pilot_name).toBe("Test Pilot");
    expect(data.tracks[0].pilot_class).toBe("open");
    expect(data.tracks[0].penalty_points).toBe(0);
  });

  test("allows anonymous access to non-test comp tracks", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/igc`);
    expect(res.status).toBe(200);
  });

  test("hides test comp tracks from non-admin", async () => {
    const compId = await createComp({ test: true });
    const taskId = await createTask(compId);

    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/igc`, {
      user: "user-2",
    });
    expect(res.status).toBe(404);
  });
});

// ── PATCH .../igc/:comp_pilot_id (penalty) ───────────────────────────────

describe("PATCH .../igc/:comp_pilot_id (penalty)", () => {
  test("admin can set penalty", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const uploadRes = await uploadIgc(compId, taskId);
    const uploadData = (await uploadRes.json()) as { comp_pilot_id: string };

    const res = await authRequest(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${uploadData.comp_pilot_id}`,
      { penalty_points: 25, penalty_reason: "Low save" }
    );
    expect(res.status).toBe(200);

    // Verify in DB
    const tt = await env.DB.prepare("SELECT penalty_points, penalty_reason FROM task_track").first();
    expect(tt!.penalty_points).toBe(25);
    expect(tt!.penalty_reason).toBe("Low save");
  });

  test("non-admin cannot set penalty", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const uploadRes = await uploadIgc(compId, taskId);
    const uploadData = (await uploadRes.json()) as { comp_pilot_id: string };

    const res = await request(
      "PATCH",
      `/api/comp/${compId}/task/${taskId}/igc/${uploadData.comp_pilot_id}`,
      { body: { penalty_points: 25 }, user: "user-2" }
    );
    expect(res.status).toBe(403);
  });
});

// ── DELETE .../igc/:comp_pilot_id ────────────────────────────────────────

describe("DELETE .../igc/:comp_pilot_id", () => {
  test("admin can delete a track", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const uploadRes = await uploadIgc(compId, taskId);
    const uploadData = (await uploadRes.json()) as { comp_pilot_id: string };

    const res = await authRequest(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}/igc/${uploadData.comp_pilot_id}`
    );
    expect(res.status).toBe(200);

    // Verify gone from D1
    const tt = await env.DB.prepare("SELECT COUNT(*) as cnt FROM task_track").first<{ cnt: number }>();
    expect(tt!.cnt).toBe(0);
  });

  test("non-admin cannot delete a track", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    const uploadRes = await uploadIgc(compId, taskId);
    const uploadData = (await uploadRes.json()) as { comp_pilot_id: string };

    const res = await request(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}/igc/${uploadData.comp_pilot_id}`,
      { user: "user-2" }
    );
    expect(res.status).toBe(403);
  });

  test("returns 404 for non-existent track", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const fakeCompPilotId = encodeId(ALPHABET, 99999);

    const res = await authRequest(
      "DELETE",
      `/api/comp/${compId}/task/${taskId}/igc/${fakeCompPilotId}`
    );
    expect(res.status).toBe(404);
  });
});

// ── POST .../igc/:comp_pilot_id (admin upload on behalf) ─────────────────

describe("POST .../igc/:comp_pilot_id (admin upload on behalf)", () => {
  test("admin can upload for a registered pilot", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // First, upload as user-1 to auto-register them
    await uploadIgc(compId, taskId);

    // Get the comp_pilot_id
    const cp = await env.DB.prepare("SELECT comp_pilot_id FROM comp_pilot").first<{ comp_pilot_id: number }>();
    const cpEncoded = encodeId(ALPHABET, cp!.comp_pilot_id);

    // Delete the existing track so we can test a fresh admin upload
    await env.DB.prepare("DELETE FROM task_track").run();

    // Admin uploads on behalf
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${cpEncoded}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.replaced).toBe(false);
    expect(data.comp_pilot_id).toBe(cpEncoded);
  });

  test("admin upload replaces existing track preserving penalties", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Upload as user-1 to auto-register
    await uploadIgc(compId, taskId);

    // Set penalty
    const tt = await env.DB.prepare("SELECT task_track_id FROM task_track").first<{ task_track_id: number }>();
    await env.DB.prepare(
      "UPDATE task_track SET penalty_points = 30, penalty_reason = 'Late start' WHERE task_track_id = ?"
    ).bind(tt!.task_track_id).run();

    // Get comp_pilot_id
    const cp = await env.DB.prepare("SELECT comp_pilot_id FROM comp_pilot").first<{ comp_pilot_id: number }>();
    const cpEncoded = encodeId(ALPHABET, cp!.comp_pilot_id);

    // Admin re-uploads on behalf
    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${cpEncoded}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.replaced).toBe(true);

    // Verify penalty preserved
    const updated = await env.DB.prepare("SELECT penalty_points, penalty_reason FROM task_track").first();
    expect(updated!.penalty_points).toBe(30);
    expect(updated!.penalty_reason).toBe("Late start");
  });

  test("non-admin cannot upload on behalf", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Register user-1 as a pilot
    await uploadIgc(compId, taskId);
    const cp = await env.DB.prepare("SELECT comp_pilot_id FROM comp_pilot").first<{ comp_pilot_id: number }>();
    const cpEncoded = encodeId(ALPHABET, cp!.comp_pilot_id);

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${cpEncoded}`,
      fakeIgcPayload(),
      { user: "user-2" }
    );
    expect(res.status).toBe(403);
  });

  test("returns 404 for non-existent comp_pilot", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);
    const fakeId = encodeId(ALPHABET, 99999);

    const res = await uploadRequest(
      `/api/comp/${compId}/task/${taskId}/igc/${fakeId}`,
      fakeIgcPayload(),
      { user: "user-1" }
    );
    expect(res.status).toBe(404);
  });
});

// ── GET /api/comp/:comp_id/pilot (pilot list) ───────────────────────────

describe("GET /api/comp/:comp_id/pilot", () => {
  test("lists registered pilots", async () => {
    const compId = await createComp();
    const taskId = await createTask(compId);

    // Upload to auto-register
    await uploadIgc(compId, taskId);

    const res = await request("GET", `/api/comp/${compId}/pilot`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pilots: Array<Record<string, unknown>> };
    expect(data.pilots.length).toBe(1);
    expect(data.pilots[0].name).toBe("Test Pilot");
    expect(data.pilots[0].pilot_class).toBe("open");
  });

  test("returns empty list for comp with no pilots", async () => {
    const compId = await createComp();

    const res = await request("GET", `/api/comp/${compId}/pilot`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { pilots: unknown[] };
    expect(data.pilots.length).toBe(0);
  });

  test("hides test comp pilots from non-admin", async () => {
    const compId = await createComp({ test: true });

    const res = await request("GET", `/api/comp/${compId}/pilot`, {
      user: "user-2",
    });
    expect(res.status).toBe(404);
  });
});

// ── Pilot profile routes ─────────────────────────────────────────────────

describe("GET /api/comp/pilot", () => {
  test("returns default profile for user without pilot row", async () => {
    const res = await authRequest("GET", "/api/comp/pilot");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Test Pilot");
    expect(data.civl_id).toBeNull();
    expect(data.glider).toBeNull();
  });

  test("returns existing pilot profile", async () => {
    await env.DB.prepare(
      "INSERT INTO pilot (user_id, name, glider) VALUES (?, ?, ?)"
    ).bind("user-1", "Test Pilot", "Moyes Litespeed").run();

    const res = await authRequest("GET", "/api/comp/pilot");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Test Pilot");
    expect(data.glider).toBe("Moyes Litespeed");
  });

  test("requires authentication", async () => {
    const res = await request("GET", "/api/comp/pilot");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/comp/pilot", () => {
  test("creates and updates pilot profile", async () => {
    const res = await authRequest("PATCH", "/api/comp/pilot", {
      name: "Updated Name",
      glider: "Moyes Litespeed RX3.5",
      civl_id: "12345",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Updated Name");
    expect(data.glider).toBe("Moyes Litespeed RX3.5");
    expect(data.civl_id).toBe("12345");

    // Verify in DB
    const pilot = await env.DB.prepare("SELECT * FROM pilot WHERE user_id = ?")
      .bind("user-1")
      .first();
    expect(pilot).not.toBeNull();
    expect(pilot!.name).toBe("Updated Name");
  });

  test("updates sporting_body_ids as JSON", async () => {
    const res = await authRequest("PATCH", "/api/comp/pilot", {
      sporting_body_ids: { SAFA: "12345", CIVL: "67890" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.sporting_body_ids).toEqual({ SAFA: "12345", CIVL: "67890" });
  });

  test("requires authentication", async () => {
    const res = await request("PATCH", "/api/comp/pilot", {
      body: { name: "Hacked" },
    });
    expect(res.status).toBe(401);
  });
});
