import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { request, clearCompData } from "./helpers";

/**
 * Minimal gzipped bytes for an IGC body. The competition-api uses
 * validateAndDecompressIgc which only requires gzip magic + a valid gzip
 * stream — content can be empty.
 */
function gzipEmpty(): Uint8Array {
  // gzip of empty payload generated once and inlined to avoid pulling node:zlib
  // into the worker test fixture.
  return new Uint8Array([
    0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

/**
 * Gzip a text payload via DecompressionStream's inverse. The Workers runtime
 * exposes CompressionStream so we don't need a polyfill.
 */
async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(
    new CompressionStream("gzip")
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a possibly-gzipped Response body and return the decoded text. The
 * vitest workers harness doesn't transparently decompress like a real browser
 * does, so we always check Content-Encoding and pipe through a
 * DecompressionStream when needed.
 */
async function readBodyText(res: Response): Promise<string> {
  const ce = res.headers.get("Content-Encoding");
  if (ce && ce.toLowerCase().includes("gzip") && res.body) {
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return res.text();
}

async function uploadTrack(
  body: Uint8Array,
  user: string = "user-1",
  filename?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "gzip",
  };
  if (filename) headers["x-filename"] = filename;
  if (user) headers["Cookie"] = `test-user=${user}`;
  return SELF.fetch("https://test/api/user/tracks", {
    method: "POST",
    headers,
    body,
  });
}

const SAMPLE_XCTSK = {
  taskType: "CLASSIC",
  version: 1,
  earthModel: "WGS84" as const,
  turnpoints: [
    { type: "TAKEOFF" as const, radius: 400, waypoint: { name: "TAKEOFF", lat: 36.4, lon: 148.1 } },
    { type: "SSS" as const, radius: 5000, waypoint: { name: "Eskdale", lat: 36.5, lon: 148.2 } },
    { type: "ESS" as const, radius: 1000, waypoint: { name: "Goal", lat: 36.6, lon: 148.3 } },
  ],
  sss: { type: "RACE" as const, direction: "EXIT" as const },
  goal: { type: "LINE" as const },
};

async function setUsername(userId: string, username: string): Promise<void> {
  await env.DB.prepare('UPDATE "user" SET username = ? WHERE id = ?')
    .bind(username, userId)
    .run();
}

beforeEach(async () => {
  await clearCompData();
  // Clear user-file tables — the user row reseed in clearCompData doesn't
  // cascade because INSERT OR REPLACE preserves the user id.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_annotation"),
    env.DB.prepare("DELETE FROM user_track"),
    env.DB.prepare("DELETE FROM user_task"),
  ]);
  // Clear R2.
  const listed = await env.R2.list();
  if (listed.objects.length > 0) {
    await Promise.all(listed.objects.map((o) => env.R2.delete(o.key)));
  }
});

// ── Tracks ──────────────────────────────────────────────────────────────────

describe("POST /api/user/tracks", () => {
  test("requires authentication", async () => {
    const res = await SELF.fetch("https://test/api/user/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" },
      body: gzipEmpty(),
    });
    expect(res.status).toBe(401);
  });

  test("uploads, computes hash, returns metadata", async () => {
    const body = await gzipText("AXCT track contents");
    const res = await uploadTrack(body, "user-1", "flight.igc");
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.track_id).toBe("string");
    expect((data.track_id as string).length).toBe(64);
    expect(data.filename).toBe("flight.igc");
    expect(data.file_size).toBe(body.byteLength);

    // R2 + D1 wrote
    const row = await env.DB.prepare(
      `SELECT r2_key FROM user_track WHERE user_id = ? AND track_id = ?`
    )
      .bind("user-1", data.track_id)
      .first<{ r2_key: string }>();
    expect(row).not.toBeNull();
    expect(row!.r2_key).toBe(`u/user-1/track/${data.track_id}.igc.gz`);
    const obj = await env.R2.get(row!.r2_key);
    expect(obj).not.toBeNull();
  });

  test("re-upload of identical content is idempotent (replaced=true)", async () => {
    const body = await gzipText("same bytes");
    const first = await uploadTrack(body, "user-1");
    expect(first.status).toBe(201);
    const second = await uploadTrack(body, "user-1");
    expect(second.status).toBe(200);
    const data = (await second.json()) as { replaced: boolean };
    expect(data.replaced).toBe(true);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM user_track WHERE user_id = ?"
    )
      .bind("user-1")
      .first<{ cnt: number }>();
    expect(row!.cnt).toBe(1);
  });

  test("rejects non-gzip bodies", async () => {
    const res = await SELF.fetch("https://test/api/user/tracks", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "gzip",
        "Cookie": "test-user=user-1",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(res.status).toBe(400);
  });

  test("enforces 200 MB per-user storage cap", async () => {
    // Seed the DB with rows that sum to right at the cap so any new upload
    // pushes us over. Cheaper than streaming 200 MB through the harness.
    const CAP = 200 * 1024 * 1024;
    await env.DB.prepare(
      `INSERT INTO user_track
        (user_id, track_id, r2_key, filename, display_name, pilot, glider,
         flight_date, file_size, stored_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
    )
      .bind(
        "user-1",
        "a".repeat(64),
        "u/user-1/track/seed.igc.gz",
        "seed.igc",
        "seed",
        CAP,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z"
      )
      .run();

    // Any new upload — even tiny — pushes the running total past the cap.
    const body = await gzipText("x".repeat(4096));
    const res = await uploadTrack(body, "user-1", "over.igc");
    expect(res.status).toBe(400);
    const data = (await res.json()) as { quota?: { kind: string } };
    expect(data.quota?.kind).toBe("bytes");
  });
});

describe("GET /api/user/tracks", () => {
  test("returns 401 for anonymous", async () => {
    const res = await request("GET", "/api/user/tracks");
    expect(res.status).toBe(401);
  });

  test("lists caller's tracks only", async () => {
    await uploadTrack(await gzipText("user-1 file"), "user-1", "u1.igc");
    await uploadTrack(await gzipText("user-2 file"), "user-2", "u2.igc");

    const res = await request("GET", "/api/user/tracks", { user: "user-1" });
    expect(res.status).toBe(200);
    const { tracks } = (await res.json()) as { tracks: { filename: string }[] };
    expect(tracks).toHaveLength(1);
    expect(tracks[0].filename).toBe("u1.igc");
  });
});

describe("GET /api/user/tracks/:track_id", () => {
  test("returns 400 on malformed id", async () => {
    const res = await request("GET", "/api/user/tracks/not-a-hash", {
      user: "user-1",
    });
    expect(res.status).toBe(400);
  });

  test("returns the original gzip body and exposes filename header", async () => {
    const original = "AXCT real track\nB001";
    const body = await gzipText(original);
    const upload = await uploadTrack(body, "user-1", "flight.igc");
    const { track_id } = (await upload.json()) as { track_id: string };

    const res = await SELF.fetch(
      `https://test/api/user/tracks/${track_id}`,
      { headers: { Cookie: "test-user=user-1" } }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Filename")).toBe("flight.igc");
    const text = await readBodyText(res);
    expect(text).toBe(original);
  });

  test("non-owner cannot fetch", async () => {
    const upload = await uploadTrack(await gzipText("u1"), "user-1");
    const { track_id } = (await upload.json()) as { track_id: string };
    const res = await request(
      "GET",
      `/api/user/tracks/${track_id}`,
      { user: "user-2" }
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/user/tracks/:track_id", () => {
  test("deletes D1 row and R2 object; cascades annotations", async () => {
    const upload = await uploadTrack(await gzipText("hello"), "user-1");
    const { track_id } = (await upload.json()) as { track_id: string };
    // Add an annotation.
    await env.DB.prepare(
      `INSERT INTO user_annotation
        (user_id, track_id, stroke_id, color, width, points, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind("user-1", track_id, "stroke-1", "#ff0000", 3, "[[1,2],[3,4]]", 12345)
      .run();

    const del = await request(
      "DELETE",
      `/api/user/tracks/${track_id}`,
      { user: "user-1" }
    );
    expect(del.status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT 1 FROM user_track WHERE user_id = ? AND track_id = ?`
    )
      .bind("user-1", track_id)
      .first();
    expect(row).toBeNull();

    const ann = await env.DB.prepare(
      `SELECT 1 FROM user_annotation WHERE user_id = ? AND track_id = ?`
    )
      .bind("user-1", track_id)
      .first();
    expect(ann).toBeNull();

    const obj = await env.R2.get(`u/user-1/track/${track_id}.igc.gz`);
    expect(obj).toBeNull();
  });
});

// ── Tasks ───────────────────────────────────────────────────────────────────

describe("POST /api/user/tasks", () => {
  test("requires authentication", async () => {
    const res = await request("POST", "/api/user/tasks", {
      body: { task_code: "abc", xctsk: SAMPLE_XCTSK },
    });
    expect(res.status).toBe(401);
  });

  test("validates task_code shape", async () => {
    const res = await request("POST", "/api/user/tasks", {
      body: { task_code: "INVALID UPPER!", xctsk: SAMPLE_XCTSK },
      user: "user-1",
    });
    expect(res.status).toBe(400);
  });

  test("upserts task; second POST is replaced=true", async () => {
    const first = await request("POST", "/api/user/tasks", {
      body: { task_code: "alpha", xctsk: SAMPLE_XCTSK },
      user: "user-1",
    });
    expect(first.status).toBe(201);

    const second = await request("POST", "/api/user/tasks", {
      body: { task_code: "alpha", xctsk: SAMPLE_XCTSK },
      user: "user-1",
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { replaced: boolean }).replaced).toBe(true);

    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM user_task WHERE user_id = 'user-1'"
    ).first<{ cnt: number }>();
    expect(row!.cnt).toBe(1);
  });
});

describe("GET /api/user/tasks/:task_code", () => {
  test("returns task JSON", async () => {
    await request("POST", "/api/user/tasks", {
      body: { task_code: "beta", xctsk: SAMPLE_XCTSK },
      user: "user-1",
    });
    const res = await request("GET", "/api/user/tasks/beta", { user: "user-1" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { xctsk: { taskType: string } };
    expect(data.xctsk.taskType).toBe("CLASSIC");
  });

  test("non-owner gets 404", async () => {
    await request("POST", "/api/user/tasks", {
      body: { task_code: "beta", xctsk: SAMPLE_XCTSK },
      user: "user-1",
    });
    const res = await request("GET", "/api/user/tasks/beta", { user: "user-2" });
    expect(res.status).toBe(404);
  });
});

// ── Annotations ─────────────────────────────────────────────────────────────

describe("annotation endpoints", () => {
  async function setupTrack(user = "user-1"): Promise<string> {
    const res = await uploadTrack(await gzipText(`for-${user}`), user, "f.igc");
    return ((await res.json()) as { track_id: string }).track_id;
  }

  test("PUT validates track ownership", async () => {
    const trackId = await setupTrack("user-1");
    const res = await request(
      "PUT",
      `/api/user/tracks/${trackId}/annotations/abc`,
      {
        body: { color: "#f00", width: 3, points: [[0, 0], [1, 1]], timestamp: 1 },
        user: "user-2", // not the owner
      }
    );
    expect(res.status).toBe(404);
  });

  test("PUT then GET roundtrips strokes", async () => {
    const trackId = await setupTrack("user-1");
    const put = await request(
      "PUT",
      `/api/user/tracks/${trackId}/annotations/stroke-a`,
      {
        body: {
          color: "#e03131",
          width: 3,
          points: [
            [148.1, 36.4],
            [148.2, 36.5],
          ],
          timestamp: 1000,
        },
        user: "user-1",
      }
    );
    expect(put.status).toBe(200);

    const get = await request(
      "GET",
      `/api/user/tracks/${trackId}/annotations`,
      { user: "user-1" }
    );
    const data = (await get.json()) as {
      annotations: { stroke_id: string; points: number[][] }[];
    };
    expect(data.annotations).toHaveLength(1);
    expect(data.annotations[0].stroke_id).toBe("stroke-a");
    expect(data.annotations[0].points[0]).toEqual([148.1, 36.4]);
  });
});

// ── Public-by-link ──────────────────────────────────────────────────────────

describe("public /api/u/:username/...", () => {
  test("downloads a track when username + track_id match", async () => {
    await setUsername("user-1", "alice");
    const upload = await uploadTrack(
      await gzipText("public flight"),
      "user-1",
      "alice-flight.igc"
    );
    const { track_id } = (await upload.json()) as { track_id: string };

    // Anonymous fetch (no Cookie).
    const res = await SELF.fetch(
      `https://test/api/u/alice/track/${track_id}`
    );
    expect(res.status).toBe(200);
    const text = await readBodyText(res);
    expect(text).toBe("public flight");
  });

  test("unknown username → 404", async () => {
    const res = await SELF.fetch(
      "https://test/api/u/no-such-user/track/" + "a".repeat(64)
    );
    expect(res.status).toBe(404);
  });

  test("no list endpoint exists for /api/u/:username/tracks", async () => {
    await setUsername("user-1", "alice");
    await uploadTrack(await gzipText("a"), "user-1");
    const res = await SELF.fetch("https://test/api/u/alice/tracks");
    expect(res.status).toBe(404);
  });

  test("annotations are readable by anyone", async () => {
    await setUsername("user-1", "alice");
    const upload = await uploadTrack(await gzipText("with strokes"), "user-1");
    const { track_id } = (await upload.json()) as { track_id: string };
    await request(
      "PUT",
      `/api/user/tracks/${track_id}/annotations/s1`,
      {
        body: { color: "#000", width: 2, points: [[0, 0], [1, 1]], timestamp: 0 },
        user: "user-1",
      }
    );
    const res = await SELF.fetch(
      `https://test/api/u/alice/track/${track_id}/annotations`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { annotations: unknown[] };
    expect(data.annotations).toHaveLength(1);
  });
});
