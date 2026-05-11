import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { loginAs, request } from "./helpers";

const SAMPLE_PREFS = {
  units: { speed: "mph", altitude: "ft", distance: "mi", climbRate: "ft/min" },
  thresholds: { thermal: { minDuration: 60 } },
  mapProvider: "leaflet",
};

const SAMPLE_THEME = {
  name: "Test Theme",
  author: "Tester",
  version: 1,
  colors: {
    background: "#000",
    foreground: "#fff",
    primary: "#f00",
  },
  radius: "0.5rem",
  buttonRadius: "0.25rem",
  fonts: {
    heading: { family: "Roboto", weight: 700, size: "2rem" },
    body: { family: "Roboto", weight: 400, size: "1rem" },
    button: { family: "Roboto", weight: 500, size: "1rem" },
    caption: { family: "Roboto", weight: 400, size: "0.875rem" },
    nav: { family: "Roboto", weight: 500, size: "1rem" },
  },
};

// ── GET /api/auth/preferences ───────────────────────────────────────────────

describe("GET /api/auth/preferences", () => {
  test("rejects unauthenticated request with 401", async () => {
    const res = await request("GET", "/api/auth/preferences");
    expect(res.status).toBe(401);
  });

  test("returns empty defaults when no row exists", async () => {
    const cookie = await loginAs("alice@test.com", "Alice");
    const res = await request("GET", "/api/auth/preferences", { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      prefs: {},
      theme: null,
      updated_at: null,
    });
  });
});

// ── PUT /api/auth/preferences — auth + validation ───────────────────────────

describe("PUT /api/auth/preferences validation", () => {
  test("rejects unauthenticated request with 401", async () => {
    const res = await request("PUT", "/api/auth/preferences", {
      body: { prefs: {} },
    });
    expect(res.status).toBe(401);
  });

  test("rejects empty body with 400", async () => {
    const cookie = await loginAs("val-empty@test.com");
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      raw: "",
    });
    expect(res.status).toBe(400);
  });

  test("rejects body with neither prefs nor theme", async () => {
    const cookie = await loginAs("val-neither@test.com");
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { other: "field" },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/prefs.*theme/);
  });

  test("rejects malformed JSON", async () => {
    const cookie = await loginAs("val-malformed@test.com");
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      raw: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-object body", async () => {
    const cookie = await loginAs("val-array@test.com");
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      raw: "[1,2,3]",
    });
    expect(res.status).toBe(400);
  });

  test("rejects prefs that is not an object", async () => {
    const cookie = await loginAs("val-prefs-string@test.com");
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: "string-not-object" },
    });
    expect(res.status).toBe(400);
  });

  test("rejects theme that is not an object or null", async () => {
    const cookie = await loginAs("val-theme-num@test.com");
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { theme: 42 },
    });
    expect(res.status).toBe(400);
  });

  test("rejects oversized body with 413", async () => {
    const cookie = await loginAs("val-oversized@test.com");
    // Build a prefs blob > 64KB
    const huge = "x".repeat(70 * 1024);
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: { padding: huge } },
    });
    expect(res.status).toBe(413);
  });
});

// ── PUT /api/auth/preferences — write/read roundtrips ───────────────────────

describe("PUT /api/auth/preferences roundtrips", () => {
  test("PUT prefs then GET reflects the saved value", async () => {
    const cookie = await loginAs("carol@test.com");
    const putRes = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: SAMPLE_PREFS },
    });
    expect(putRes.status).toBe(200);
    const putData = (await putRes.json()) as { updated_at: string };
    expect(typeof putData.updated_at).toBe("string");

    const getRes = await request("GET", "/api/auth/preferences", { cookie });
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as {
      prefs: unknown;
      theme: unknown;
      updated_at: string;
    };
    expect(data.prefs).toEqual(SAMPLE_PREFS);
    expect(data.theme).toBeNull();
    expect(data.updated_at).toBe(putData.updated_at);
  });

  test("PUT theme then GET reflects the saved theme", async () => {
    const cookie = await loginAs("dave@test.com");
    const putRes = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { theme: SAMPLE_THEME },
    });
    expect(putRes.status).toBe(200);

    const getRes = await request("GET", "/api/auth/preferences", { cookie });
    const data = (await getRes.json()) as { prefs: unknown; theme: unknown };
    expect(data.prefs).toEqual({});
    expect(data.theme).toEqual(SAMPLE_THEME);
  });

  test("PUT prefs and theme together saves both", async () => {
    const cookie = await loginAs("eve@test.com");
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: SAMPLE_PREFS, theme: SAMPLE_THEME },
    });
    const getRes = await request("GET", "/api/auth/preferences", { cookie });
    const data = (await getRes.json()) as { prefs: unknown; theme: unknown };
    expect(data.prefs).toEqual(SAMPLE_PREFS);
    expect(data.theme).toEqual(SAMPLE_THEME);
  });

  test("partial update: PUT prefs only does not clobber theme", async () => {
    const cookie = await loginAs("frank@test.com");
    // First save both
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: SAMPLE_PREFS, theme: SAMPLE_THEME },
    });
    // Then update only prefs
    const newPrefs = { ...SAMPLE_PREFS, mapProvider: "mapbox" };
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: newPrefs },
    });
    const getRes = await request("GET", "/api/auth/preferences", { cookie });
    const data = (await getRes.json()) as { prefs: unknown; theme: unknown };
    expect(data.prefs).toEqual(newPrefs);
    expect(data.theme).toEqual(SAMPLE_THEME);
  });

  test("partial update: PUT theme only does not clobber prefs", async () => {
    const cookie = await loginAs("grace@test.com");
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: SAMPLE_PREFS, theme: SAMPLE_THEME },
    });
    const newTheme = { ...SAMPLE_THEME, name: "Renamed" };
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { theme: newTheme },
    });
    const getRes = await request("GET", "/api/auth/preferences", { cookie });
    const data = (await getRes.json()) as { prefs: unknown; theme: unknown };
    expect(data.prefs).toEqual(SAMPLE_PREFS);
    expect(data.theme).toEqual(newTheme);
  });

  test("PUT theme=null clears the saved theme", async () => {
    const cookie = await loginAs("henry@test.com");
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: SAMPLE_PREFS, theme: SAMPLE_THEME },
    });
    const putRes = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { theme: null },
    });
    expect(putRes.status).toBe(200);

    const getRes = await request("GET", "/api/auth/preferences", { cookie });
    const data = (await getRes.json()) as { prefs: unknown; theme: unknown };
    expect(data.prefs).toEqual(SAMPLE_PREFS);
    expect(data.theme).toBeNull();
  });

  test("updated_at advances on subsequent writes", async () => {
    const cookie = await loginAs("ida@test.com");
    const r1 = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: SAMPLE_PREFS },
    });
    const t1 = ((await r1.json()) as { updated_at: string }).updated_at;
    // Sleep 5ms so the second Date.now()-derived ISO string is strictly later.
    // ISO 8601 with millisecond precision sorts lexicographically the same as
    // chronologically, so plain string > works for the assertion.
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: { ...SAMPLE_PREFS, mapProvider: "mapbox" } },
    });
    const t2 = ((await r2.json()) as { updated_at: string }).updated_at;
    expect(t2 > t1).toBe(true);
  });

  test("concurrent PUTs (prefs and theme) do not lose each other's update", async () => {
    const cookie = await loginAs("concurrent@test.com");
    // Seed an empty row so both PUTs hit the ON CONFLICT branch (where the
    // race used to live). Without this, one might INSERT and one UPDATE.
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: {}, theme: null },
    });

    // Fire both PUTs without awaiting between them — each updates only its
    // own field. Pre-fix this could lose one update (read-modify-write race).
    const [r1, r2] = await Promise.all([
      request("PUT", "/api/auth/preferences", {
        cookie,
        body: { prefs: SAMPLE_PREFS },
      }),
      request("PUT", "/api/auth/preferences", {
        cookie,
        body: { theme: SAMPLE_THEME },
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const get = await request("GET", "/api/auth/preferences", { cookie });
    const data = (await get.json()) as { prefs: unknown; theme: unknown };
    expect(data.prefs).toEqual(SAMPLE_PREFS);
    expect(data.theme).toEqual(SAMPLE_THEME);
  });

  test("body of exactly 64KB is accepted (boundary)", async () => {
    const cookie = await loginAs("boundary@test.com");
    // The route caps total body at 64 * 1024 chars — measure the wrapper's
    // overhead and pad the prefs payload to land exactly at the cap.
    const overhead = JSON.stringify({ prefs: { padding: "" } }).length;
    const padding = "x".repeat(64 * 1024 - overhead);
    const res = await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: { padding } },
    });
    expect(res.status).toBe(200);
  });

  test("two users do not see each other's preferences", async () => {
    const cookieA = await loginAs("user-a@test.com", "User A");
    const cookieB = await loginAs("user-b@test.com", "User B");

    await request("PUT", "/api/auth/preferences", {
      cookie: cookieA,
      body: { prefs: { owner: "A" } },
    });
    await request("PUT", "/api/auth/preferences", {
      cookie: cookieB,
      body: { prefs: { owner: "B" } },
    });

    const getA = await request("GET", "/api/auth/preferences", {
      cookie: cookieA,
    });
    const getB = await request("GET", "/api/auth/preferences", {
      cookie: cookieB,
    });
    expect(((await getA.json()) as { prefs: unknown }).prefs).toEqual({
      owner: "A",
    });
    expect(((await getB.json()) as { prefs: unknown }).prefs).toEqual({
      owner: "B",
    });
  });
});

// ── CASCADE on user delete ──────────────────────────────────────────────────

describe("CASCADE behaviour", () => {
  test("deleting the user row removes that user's preferences row", async () => {
    const email = "cascade-target@test.com";
    const cookie = await loginAs(email);
    await request("PUT", "/api/auth/preferences", {
      cookie,
      body: { prefs: SAMPLE_PREFS, theme: SAMPLE_THEME },
    });

    // Look up the user_id and confirm a prefs row exists for it.
    const userRow = await env.glidecomp_auth
      .prepare('SELECT id FROM "user" WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();
    expect(userRow).not.toBeNull();
    const userId = userRow!.id;

    const before = await env.glidecomp_auth
      .prepare("SELECT user_id FROM user_preferences WHERE user_id = ?")
      .bind(userId)
      .first();
    expect(before).not.toBeNull();

    // Delete the user (mimics what /api/auth/delete-account does)
    await env.glidecomp_auth
      .prepare('DELETE FROM "user" WHERE id = ?')
      .bind(userId)
      .run();

    // Preferences row for this user should be gone via CASCADE
    const after = await env.glidecomp_auth
      .prepare("SELECT user_id FROM user_preferences WHERE user_id = ?")
      .bind(userId)
      .first();
    expect(after).toBeNull();
  });
});
