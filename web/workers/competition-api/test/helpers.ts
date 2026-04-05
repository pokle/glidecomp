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

/** Clear all competition data between tests. */
export async function clearCompData(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM task_track"),
    env.DB.prepare("DELETE FROM task_class"),
    env.DB.prepare("DELETE FROM task"),
    env.DB.prepare("DELETE FROM comp_pilot"),
    env.DB.prepare("DELETE FROM comp_admin"),
    env.DB.prepare("DELETE FROM comp"),
    env.DB.prepare("DELETE FROM pilot"),
  ]);
}
