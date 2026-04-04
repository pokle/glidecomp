import { describe, expect, test, beforeEach } from "bun:test";
import app from "../src/index";
import { encodeId, decodeId } from "../src/sqids";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

// Minimal mock types matching what the worker uses
type MockUser = { id: string; name: string; email: string; image: null; username: string | null };

const testUser: MockUser = {
  id: "user-1",
  name: "Test Pilot",
  email: "pilot@test.com",
  image: null,
  username: "testpilot",
};

const testUser2: MockUser = {
  id: "user-2",
  name: "Admin Two",
  email: "admin2@test.com",
  image: null,
  username: "admin2",
};

/**
 * Create a mock env with an in-memory D1-like database.
 * We use wrangler's unstable_dev or test the app directly via Hono's test client.
 * For unit tests, we mock the D1 and AUTH_API bindings.
 */
function createMockEnv(currentUser: MockUser | null = testUser) {
  // In-memory state for mock D1
  const tables: Record<string, Record<string, unknown>[]> = {
    user: [
      { id: "user-1", name: "Test Pilot", email: "pilot@test.com", username: "testpilot" },
      { id: "user-2", name: "Admin Two", email: "admin2@test.com", username: "admin2" },
    ],
    comp: [],
    comp_admin: [],
    pilot: [],
    comp_pilot: [],
    task: [],
    task_class: [],
    task_track: [],
  };

  let autoIncrements: Record<string, number> = {
    comp: 0,
    pilot: 0,
    comp_pilot: 0,
    task: 0,
    task_track: 0,
  };

  // Very simple SQL mock — handles the specific queries used in the routes
  function mockPrepare(sql: string) {
    return {
      _sql: sql,
      _bindings: [] as unknown[],
      bind(...args: unknown[]) {
        this._bindings = args;
        return this;
      },
      async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
        const results = await this.all();
        const row = results.results[0];
        if (!row) return null;
        if (col) return (row as Record<string, unknown>)[col] as T;
        return row as T;
      },
      async all<T = Record<string, unknown>>() {
        const result = executeSql(sql, this._bindings);
        return { results: result.rows as T[], success: true, meta: result.meta };
      },
      async run() {
        const result = executeSql(sql, this._bindings);
        return { success: true, meta: result.meta };
      },
    };
  }

  function executeSql(sql: string, bindings: unknown[]): { rows: Record<string, unknown>[]; meta: { last_row_id: number } } {
    const trimmed = sql.trim().replace(/\s+/g, " ");
    let meta = { last_row_id: 0 };

    // INSERT INTO comp (...)
    if (trimmed.startsWith("INSERT INTO comp (")) {
      autoIncrements.comp++;
      const id = autoIncrements.comp;
      tables.comp.push({
        comp_id: id,
        name: bindings[0],
        creation_date: bindings[1],
        close_date: bindings[2],
        category: bindings[3],
        test: bindings[4],
        pilot_classes: bindings[5],
        default_pilot_class: bindings[6],
        gap_params: bindings[7],
      });
      return { rows: [], meta: { last_row_id: id } };
    }

    // INSERT INTO comp_admin
    if (trimmed.startsWith("INSERT INTO comp_admin")) {
      tables.comp_admin.push({ comp_id: bindings[0], user_id: bindings[1] });
      return { rows: [], meta };
    }

    // SELECT COUNT(*) as cnt FROM comp_admin WHERE user_id
    if (trimmed.includes("COUNT(*)") && trimmed.includes("comp_admin") && trimmed.includes("user_id")) {
      const cnt = tables.comp_admin.filter((r) => r.user_id === bindings[0]).length;
      return { rows: [{ cnt }], meta };
    }

    // SELECT ... FROM comp WHERE test = 0 AND creation_date >= ?
    if (trimmed.includes("FROM comp") && trimmed.includes("test = 0")) {
      const rows = tables.comp.filter((r) => !(r.test as number) && (r.creation_date as string) >= (bindings[0] as string));
      return { rows, meta };
    }

    // SELECT ... FROM comp c JOIN comp_admin ca ... WHERE ca.user_id = ?
    if (trimmed.includes("FROM comp c") && trimmed.includes("JOIN comp_admin ca")) {
      const adminCompIds = tables.comp_admin
        .filter((r) => r.user_id === bindings[0])
        .map((r) => r.comp_id);
      const rows = tables.comp.filter((r) => adminCompIds.includes(r.comp_id));
      return { rows, meta };
    }

    // SELECT ... FROM comp WHERE comp_id = ?
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM comp WHERE comp_id")) {
      const rows = tables.comp.filter((r) => r.comp_id === bindings[0]);
      return { rows, meta };
    }

    // SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?
    if (trimmed.includes("SELECT 1 FROM comp_admin")) {
      const rows = tables.comp_admin.filter(
        (r) => r.comp_id === bindings[0] && r.user_id === bindings[1]
      );
      return { rows: rows.length > 0 ? [{ "1": 1 }] : [], meta };
    }

    // SELECT u.email, u.name FROM comp_admin ca JOIN "user" u
    if (trimmed.includes("comp_admin ca") && trimmed.includes('JOIN "user" u')) {
      const adminRows = tables.comp_admin.filter((r) => r.comp_id === bindings[0]);
      const rows = adminRows.map((a) => {
        const user = tables.user.find((u) => u.id === a.user_id);
        return user ? { email: user.email, name: user.name } : null;
      }).filter(Boolean) as Record<string, unknown>[];
      return { rows, meta };
    }

    // SELECT ... FROM task t WHERE t.comp_id = ?
    if (trimmed.includes("FROM task t WHERE")) {
      const rows = tables.task.filter((r) => r.comp_id === bindings[0]);
      return { rows, meta };
    }

    // SELECT task_id, pilot_class FROM task_class WHERE task_id IN
    if (trimmed.includes("FROM task_class WHERE task_id IN")) {
      const rows = tables.task_class.filter((r) =>
        bindings.includes(r.task_id)
      );
      return { rows, meta };
    }

    // SELECT COUNT(*) as cnt FROM comp_pilot WHERE comp_id = ?
    if (trimmed.includes("COUNT(*)") && trimmed.includes("comp_pilot")) {
      const cnt = tables.comp_pilot.filter((r) => r.comp_id === bindings[0]).length;
      return { rows: [{ cnt }], meta };
    }

    // UPDATE comp SET ...
    if (trimmed.startsWith("UPDATE comp SET")) {
      const compId = bindings[bindings.length - 1];
      const comp = tables.comp.find((r) => r.comp_id === compId);
      if (comp) {
        // Parse which fields are being updated from the SQL
        const setPart = trimmed.match(/SET (.+) WHERE/)?.[1] ?? "";
        const fields = setPart.split(",").map((f) => f.trim().split(" = ")[0]);
        fields.forEach((field, i) => {
          (comp as Record<string, unknown>)[field] = bindings[i];
        });
      }
      return { rows: [], meta };
    }

    // DELETE FROM comp_admin WHERE comp_id = ?
    if (trimmed.startsWith("DELETE FROM comp_admin WHERE comp_id")) {
      tables.comp_admin = tables.comp_admin.filter((r) => r.comp_id !== bindings[0]);
      return { rows: [], meta };
    }

    // DELETE FROM comp WHERE comp_id = ?
    if (trimmed.startsWith("DELETE FROM comp WHERE")) {
      const cid = bindings[0];
      tables.comp = tables.comp.filter((r) => r.comp_id !== cid);
      tables.comp_admin = tables.comp_admin.filter((r) => r.comp_id !== cid);
      tables.task = tables.task.filter((r) => r.comp_id !== cid);
      return { rows: [], meta };
    }

    // SELECT id, email FROM "user" WHERE email IN (...)
    if (trimmed.includes('FROM "user" WHERE email IN')) {
      const rows = tables.user.filter((u) => bindings.includes(u.email));
      return { rows, meta };
    }

    // SELECT pilot_classes, default_pilot_class FROM comp (PATCH consistency check — 2 columns only)
    if (trimmed.includes("SELECT pilot_classes, default_pilot_class FROM comp")) {
      const rows = tables.comp.filter((r) => r.comp_id === bindings[0]);
      return { rows, meta };
    }

    return { rows: [], meta };
  }

  // Mock batch for admin management
  const mockBatch = async (stmts: ReturnType<typeof mockPrepare>[]) => {
    return Promise.all(stmts.map((s) => s.run()));
  };

  const mockDb = {
    prepare: mockPrepare,
    batch: mockBatch,
  } as unknown as D1Database;

  // Mock AUTH_API service binding
  const mockAuthApi = {
    fetch: async () => {
      return new Response(JSON.stringify({ user: currentUser }), {
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;

  return {
    DB: mockDb,
    AUTH_API: mockAuthApi,
    SQIDS_ALPHABET: ALPHABET,
  };
}

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  env?: ReturnType<typeof createMockEnv>
) {
  const e = env ?? createMockEnv();
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return app.fetch(new Request(`http://localhost${path}`, init), e);
}

describe("POST /api/comp", () => {
  test("creates a competition and returns encoded ID", async () => {
    const res = await makeRequest("POST", "/api/comp", {
      name: "Test Comp",
      category: "hg",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as Record<string, unknown>;
    expect(data.name).toBe("Test Comp");
    expect(data.category).toBe("hg");
    expect(typeof data.comp_id).toBe("string");
    expect((data.comp_id as string).length).toBeGreaterThanOrEqual(4);
    expect(data.pilot_classes).toEqual(["open"]);
    expect(data.default_pilot_class).toBe("open");
  });

  test("creates with custom pilot classes", async () => {
    const res = await makeRequest("POST", "/api/comp", {
      name: "PG Open",
      category: "pg",
      pilot_classes: ["open", "sport", "floater"],
      default_pilot_class: "sport",
    });
    expect(res.status).toBe(201);
    const data = await res.json() as Record<string, unknown>;
    expect(data.pilot_classes).toEqual(["open", "sport", "floater"]);
    expect(data.default_pilot_class).toBe("sport");
  });

  test("rejects if default_pilot_class not in pilot_classes", async () => {
    const res = await makeRequest("POST", "/api/comp", {
      name: "Bad Comp",
      category: "hg",
      pilot_classes: ["open"],
      default_pilot_class: "novice",
    });
    expect(res.status).toBe(400);
  });

  test("rejects unauthenticated requests", async () => {
    const env = createMockEnv(null);
    const res = await makeRequest("POST", "/api/comp", { name: "No Auth", category: "hg" }, env);
    expect(res.status).toBe(401);
  });

  test("validates name is required", async () => {
    const res = await makeRequest("POST", "/api/comp", { category: "hg" });
    expect(res.status).toBe(400);
  });

  test("validates category enum", async () => {
    const res = await makeRequest("POST", "/api/comp", {
      name: "Bad Cat",
      category: "invalid",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/comp", () => {
  test("returns empty list when no comps exist", async () => {
    const res = await makeRequest("GET", "/api/comp");
    expect(res.status).toBe(200);
    const data = await res.json() as { comps: unknown[] };
    expect(data.comps).toEqual([]);
  });

  test("returns created comps for authenticated user", async () => {
    const env = createMockEnv();
    // Create a comp first
    await makeRequest("POST", "/api/comp", { name: "Listed Comp", category: "hg" }, env);
    const res = await makeRequest("GET", "/api/comp", undefined, env);
    expect(res.status).toBe(200);
    const data = await res.json() as { comps: Array<{ name: string; is_admin: boolean }> };
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].name).toBe("Listed Comp");
    expect(data.comps[0].is_admin).toBe(true);
  });
});

describe("GET /api/comp/:comp_id", () => {
  test("returns comp details with encoded IDs", async () => {
    const env = createMockEnv();
    const createRes = await makeRequest("POST", "/api/comp", { name: "Detail Comp", category: "pg" }, env);
    const { comp_id } = await createRes.json() as { comp_id: string };

    const res = await makeRequest("GET", `/api/comp/${comp_id}`, undefined, env);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.name).toBe("Detail Comp");
    expect(data.comp_id).toBe(comp_id);
    expect(Array.isArray(data.admins)).toBe(true);
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(typeof data.pilot_count).toBe("number");
  });

  test("returns 404 for non-existent comp", async () => {
    const env = createMockEnv();
    const fakeId = encodeId(ALPHABET, 99999);
    const res = await makeRequest("GET", `/api/comp/${fakeId}`, undefined, env);
    expect(res.status).toBe(404);
  });

  test("returns 400 for invalid sqid", async () => {
    const env = createMockEnv();
    const res = await makeRequest("GET", "/api/comp/!!!!", undefined, env);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/comp/:comp_id", () => {
  test("updates comp name", async () => {
    const env = createMockEnv();
    const createRes = await makeRequest("POST", "/api/comp", { name: "Original", category: "hg" }, env);
    const { comp_id } = await createRes.json() as { comp_id: string };

    const res = await makeRequest("PATCH", `/api/comp/${comp_id}`, { name: "Updated" }, env);
    expect(res.status).toBe(200);
    const data = await res.json() as { name: string };
    expect(data.name).toBe("Updated");
  });

  test("rejects non-admin updates", async () => {
    const env = createMockEnv();
    const createRes = await makeRequest("POST", "/api/comp", { name: "Locked", category: "hg" }, env);
    const { comp_id } = await createRes.json() as { comp_id: string };

    // User 2 is not admin
    const env2 = createMockEnv(testUser2);
    // Copy the DB state
    (env2 as unknown as Record<string, unknown>).DB = env.DB;
    const res = await makeRequest("PATCH", `/api/comp/${comp_id}`, { name: "Hacked" }, env2);
    expect(res.status).toBe(403);
  });

  test("updates admin list via emails", async () => {
    const env = createMockEnv();
    const createRes = await makeRequest("POST", "/api/comp", { name: "Admin Test", category: "hg" }, env);
    const { comp_id } = await createRes.json() as { comp_id: string };

    const res = await makeRequest(
      "PATCH",
      `/api/comp/${comp_id}`,
      { admin_emails: ["pilot@test.com", "admin2@test.com"] },
      env
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { admins: Array<{ email: string }> };
    expect(data.admins.length).toBe(2);
  });
});

describe("DELETE /api/comp/:comp_id", () => {
  test("deletes a comp", async () => {
    const env = createMockEnv();
    const createRes = await makeRequest("POST", "/api/comp", { name: "Doomed", category: "hg" }, env);
    const { comp_id } = await createRes.json() as { comp_id: string };

    const res = await makeRequest("DELETE", `/api/comp/${comp_id}`, undefined, env);
    expect(res.status).toBe(200);

    // Verify it's gone
    const getRes = await makeRequest("GET", `/api/comp/${comp_id}`, undefined, env);
    expect(getRes.status).toBe(404);
  });

  test("rejects unauthenticated delete", async () => {
    const env = createMockEnv();
    const createRes = await makeRequest("POST", "/api/comp", { name: "Safe", category: "hg" }, env);
    const { comp_id } = await createRes.json() as { comp_id: string };

    const env2 = createMockEnv(null);
    (env2 as unknown as Record<string, unknown>).DB = env.DB;
    const res = await makeRequest("DELETE", `/api/comp/${comp_id}`, undefined, env2);
    expect(res.status).toBe(401);
  });
});
