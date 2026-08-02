import { SELF, env } from "cloudflare:test";

/**
 * Make a request to the worker with optional auth.
 *
 * @param method  HTTP method
 * @param path    URL path (e.g. "/api/comp")
 * @param options.body   JSON body (will be stringified)
 * @param options.user   User ID for auth cookie ("user-1", "user-2"), or null/undefined for anonymous
 */
export async function request(
  method: string,
  path: string,
  options: { body?: unknown; user?: string | null } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.user) {
    headers["Cookie"] = `test-user=${options.user}`;
  }

  return SELF.fetch(`https://test${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

/** Shorthand for authenticated requests as user-1 (the default test user). */
export function authRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return request(method, path, { body, user: "user-1" });
}

/** Create a comp and return its encoded ID. */
export async function createComp(
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const res = await authRequest("POST", "/api/comp", {
    name: "Test Comp",
    category: "hg",
    ...overrides,
  });
  const data = (await res.json()) as { comp_id: string };
  return data.comp_id;
}

/**
 * The day the bundled sample tracks were actually flown — Corryong Cup 2026
 * task 1, which vitest.config.ts loads as SAMPLE_IGC_FILES/SAMPLE_TASK_XCTSK.
 *
 * The default MUST match those tracks' HFDTE. Since track-quality.ts, the task
 * date is a scoring input: a task dated ten days off its own tracklogs is
 * exactly the fault the data-quality checks exist to catch, and every scoring
 * test would score a field of withheld pilots at zero.
 */
export const SAMPLE_TASK_DATE = "2026-01-05";

/** Create a task in a comp and return its encoded ID. */
export async function createTask(
  compId: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const res = await authRequest("POST", `/api/comp/${compId}/task`, {
    name: "Test Task",
    task_date: SAMPLE_TASK_DATE,
    pilot_classes: ["open"],
    ...overrides,
  });
  const data = (await res.json()) as { task_id: string };
  return data.task_id;
}

/**
 * Upload binary data to a path with optional auth.
 * Used for IGC uploads where Content-Type is not JSON.
 */
export async function uploadRequest(
  path: string,
  body: ArrayBuffer | Uint8Array,
  options: { user?: string | null } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.user) {
    headers["Cookie"] = `test-user=${options.user}`;
  }
  return SELF.fetch(`https://test${path}`, {
    method: "POST",
    headers,
    body,
  });
}

/** Clear all competition data between tests. */
export async function clearCompData(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_log"),
    env.DB.prepare("DELETE FROM task_track"),
    env.DB.prepare("DELETE FROM task_class"),
    env.DB.prepare("DELETE FROM task"),
    env.DB.prepare("DELETE FROM comp_pilot"),
    env.DB.prepare("DELETE FROM comp_admin"),
    env.DB.prepare("DELETE FROM comp_waypoints"),
    env.DB.prepare("DELETE FROM comp"),
    env.DB.prepare("DELETE FROM pilot"),
    // The search index (migration 0026) mostly cascades away with its comps,
    // but the reindex queue is keyed by text and does not — left behind, it
    // makes the next test's first mutation do somebody else's work.
    env.DB.prepare("DELETE FROM search_doc"),
    env.DB.prepare("DELETE FROM search_dirty"),
    // Re-seed test users: the Cloudflare vitest pool uses per-test storage
    // isolation, which wipes the `user` table between tests. apply-migrations
    // only seeds at file-load time. INSERT OR REPLACE keeps rows idempotent.
    env.DB.prepare(
      `INSERT OR REPLACE INTO "user" (id, name, email, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)`
    ).bind("user-1", "Test Pilot", "pilot@test.com", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      `INSERT OR REPLACE INTO "user" (id, name, email, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)`
    ).bind("user-2", "Admin Two", "admin2@test.com", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    env.DB.prepare(
      `INSERT OR REPLACE INTO "user" (id, name, email, username, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      "user-3",
      "Pilot Three",
      "pilot3@test.com",
      "pilot3",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z"
    ),
    // Email is on the hardcoded super-admin allowlist (see src/super-admin.ts).
    env.DB.prepare(
      `INSERT OR REPLACE INTO "user" (id, name, email, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?)`
    ).bind("user-super", "Super Admin", "tushar.pokle@gmail.com", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
  ]);
}
