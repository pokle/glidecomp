import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { request, authRequest, createComp, clearCompData } from "./helpers";
import { encodeId } from "../src/sqids";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

beforeEach(async () => {
  await clearCompData();
});

// ── POST /api/comp ──────────────────────────────────────────────────────────

describe("POST /api/comp", () => {
  test("creates a competition and returns encoded ID", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bells 2026",
      category: "hg",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Bells 2026");
    expect(data.category).toBe("hg");
    expect(typeof data.comp_id).toBe("string");
    expect((data.comp_id as string).length).toBeGreaterThanOrEqual(4);
    expect(data.pilot_classes).toEqual(["open"]);
    expect(data.default_pilot_class).toBe("open");

    // Verify in D1 directly
    const row = await env.DB.prepare("SELECT * FROM comp").first();
    expect(row!.name).toBe("Bells 2026");
  });

  test("creates with custom pilot classes", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "PG Open",
      category: "pg",
      pilot_classes: ["open", "sport", "floater"],
      default_pilot_class: "sport",
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.pilot_classes).toEqual(["open", "sport", "floater"]);
    expect(data.default_pilot_class).toBe("sport");
  });

  test("creates with GAP parameters", async () => {
    const gapParams = {
      nominalLaunch: 0.96,
      nominalDistance: 70000,
      nominalGoal: 0.2,
      nominalTime: 5400,
      minimumDistance: 5000,
      scoring: "HG",
      useLeading: true,
      useArrival: true,
    };
    const res = await authRequest("POST", "/api/comp", {
      name: "GAP Comp",
      category: "hg",
      gap_params: gapParams,
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.gap_params).toEqual(gapParams);
  });

  test("caller becomes first admin", async () => {
    const compId = await createComp();

    const row = await env.DB.prepare(
      "SELECT user_id FROM comp_admin"
    ).first();
    expect(row!.user_id).toBe("user-1");
  });

  test("rejects if default_pilot_class not in pilot_classes", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bad Comp",
      category: "hg",
      pilot_classes: ["open"],
      default_pilot_class: "novice",
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("default_pilot_class");
  });

  test("rejects unauthenticated requests", async () => {
    const res = await request("POST", "/api/comp", {
      body: { name: "No Auth", category: "hg" },
    });
    expect(res.status).toBe(401);
  });

  test("validates name is required", async () => {
    const res = await authRequest("POST", "/api/comp", { category: "hg" });
    expect(res.status).toBe(400);
  });

  test("validates category enum", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Bad Cat",
      category: "invalid",
    });
    expect(res.status).toBe(400);
  });

  test("rejects name exceeding 128 chars", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "x".repeat(200),
      category: "hg",
    });
    expect(res.status).toBe(400);
  });

  test("rejects duplicate pilot classes", async () => {
    const res = await authRequest("POST", "/api/comp", {
      name: "Dup Classes",
      category: "hg",
      pilot_classes: ["open", "open"],
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/comp ───────────────────────────────────────────────────────────

describe("GET /api/comp", () => {
  test("returns empty list when no comps exist", async () => {
    const res = await authRequest("GET", "/api/comp");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { comps: unknown[] };
    expect(data.comps).toEqual([]);
  });

  test("returns admin comps for authenticated user", async () => {
    await createComp({ name: "My Comp" });

    const res = await authRequest("GET", "/api/comp");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      comps: Array<{ name: string; is_admin: boolean }>;
    };
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].name).toBe("My Comp");
    expect(data.comps[0].is_admin).toBe(true);
  });

  test("returns public (non-test) comps for anonymous users", async () => {
    await createComp({ name: "Public Comp" });

    const res = await request("GET", "/api/comp");
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      comps: Array<{ name: string; is_admin: boolean }>;
    };
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].name).toBe("Public Comp");
    expect(data.comps[0].is_admin).toBe(false);
  });

  test("hides test comps from anonymous users", async () => {
    await createComp({ name: "Secret", test: true });

    const res = await request("GET", "/api/comp");
    const data = (await res.json()) as { comps: unknown[] };
    expect(data.comps.length).toBe(0);
  });

  test("shows test comps to their admin", async () => {
    await createComp({ name: "Secret", test: true });

    const res = await authRequest("GET", "/api/comp");
    const data = (await res.json()) as {
      comps: Array<{ name: string; test: boolean }>;
    };
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].test).toBe(true);
  });
});

// ── GET /api/comp/:comp_id ──────────────────────────────────────────────────

describe("GET /api/comp/:comp_id", () => {
  test("returns comp details with tasks, admins, pilot count", async () => {
    const compId = await createComp({ name: "Detail Comp", category: "pg" });

    const res = await authRequest("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.name).toBe("Detail Comp");
    expect(data.comp_id).toBe(compId);
    expect(Array.isArray(data.admins)).toBe(true);
    expect(
      (data.admins as Array<{ email: string }>)[0].email
    ).toBe("pilot@test.com");
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(data.pilot_count).toBe(0);
    expect(Array.isArray(data.class_coverage_warnings)).toBe(true);
  });

  test("returns 404 for non-existent comp", async () => {
    const fakeId = encodeId(ALPHABET, 99999);
    const res = await authRequest("GET", `/api/comp/${fakeId}`);
    expect(res.status).toBe(404);
  });

  test("returns 400 for invalid sqid", async () => {
    const res = await authRequest("GET", "/api/comp/!!!!");
    expect(res.status).toBe(400);
  });

  test("hides test comp from non-admin", async () => {
    const compId = await createComp({ name: "Secret", test: true });

    // user-2 is not an admin
    const res = await request("GET", `/api/comp/${compId}`, {
      user: "user-2",
    });
    expect(res.status).toBe(404);
  });

  test("shows test comp to its admin", async () => {
    const compId = await createComp({ name: "Secret", test: true });

    const res = await authRequest("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
  });

  test("allows anonymous access to non-test comp", async () => {
    const compId = await createComp({ name: "Public" });

    const res = await request("GET", `/api/comp/${compId}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("Public");
  });
});

// ── PATCH /api/comp/:comp_id ────────────────────────────────────────────────

describe("PATCH /api/comp/:comp_id", () => {
  test("updates comp name", async () => {
    const compId = await createComp({ name: "Original" });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      name: "Updated",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { name: string };
    expect(data.name).toBe("Updated");

    // Verify in D1
    const row = await env.DB.prepare("SELECT name FROM comp").first();
    expect(row!.name).toBe("Updated");
  });

  test("updates category", async () => {
    const compId = await createComp({ category: "hg" });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      category: "pg",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { category: string };
    expect(data.category).toBe("pg");
  });

  test("updates pilot classes", async () => {
    const compId = await createComp();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      pilot_classes: ["open", "sport"],
      default_pilot_class: "sport",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      pilot_classes: string[];
      default_pilot_class: string;
    };
    expect(data.pilot_classes).toEqual(["open", "sport"]);
    expect(data.default_pilot_class).toBe("sport");
  });

  test("rejects non-admin updates", async () => {
    const compId = await createComp();

    const res = await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Hacked" },
      user: "user-2",
    });
    expect(res.status).toBe(403);
  });

  test("rejects unauthenticated updates", async () => {
    const compId = await createComp();

    const res = await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Hacked" },
    });
    expect(res.status).toBe(401);
  });

  test("updates admin list via emails", async () => {
    const compId = await createComp();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["pilot@test.com", "admin2@test.com"],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      admins: Array<{ email: string }>;
    };
    expect(data.admins.length).toBe(2);
    const emails = data.admins.map((a) => a.email).sort();
    expect(emails).toEqual(["admin2@test.com", "pilot@test.com"]);

    // Verify in D1
    const rows = await env.DB.prepare(
      "SELECT user_id FROM comp_admin ORDER BY user_id"
    ).all();
    expect(rows.results.length).toBe(2);
  });

  test("rejects admin_emails with no registered users", async () => {
    const compId = await createComp();

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      admin_emails: ["nobody@test.com"],
    });
    expect(res.status).toBe(500); // updateAdmins throws
  });

  test("rejects inconsistent default_pilot_class", async () => {
    const compId = await createComp({
      pilot_classes: ["open", "sport"],
      default_pilot_class: "open",
    });

    const res = await authRequest("PATCH", `/api/comp/${compId}`, {
      default_pilot_class: "floater",
    });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/comp/:comp_id ───────────────────────────────────────────────

describe("DELETE /api/comp/:comp_id", () => {
  test("deletes a comp and cascades", async () => {
    const compId = await createComp({ name: "Doomed" });

    const res = await authRequest("DELETE", `/api/comp/${compId}`);
    expect(res.status).toBe(200);

    // Verify comp is gone
    const getRes = await authRequest("GET", `/api/comp/${compId}`);
    expect(getRes.status).toBe(404);

    // Verify in D1 directly
    const row = await env.DB.prepare("SELECT COUNT(*) as cnt FROM comp").first<{ cnt: number }>();
    expect(row!.cnt).toBe(0);

    // Verify admin rows cascaded
    const adminRow = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM comp_admin"
    ).first<{ cnt: number }>();
    expect(adminRow!.cnt).toBe(0);
  });

  test("rejects unauthenticated delete", async () => {
    const compId = await createComp();

    const res = await request("DELETE", `/api/comp/${compId}`);
    expect(res.status).toBe(401);
  });

  test("rejects non-admin delete", async () => {
    const compId = await createComp();

    const res = await request("DELETE", `/api/comp/${compId}`, {
      user: "user-2",
    });
    expect(res.status).toBe(403);

    // Comp still exists
    const row = await env.DB.prepare("SELECT COUNT(*) as cnt FROM comp").first<{ cnt: number }>();
    expect(row!.cnt).toBe(1);
  });
});
