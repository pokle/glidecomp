import { SELF, env } from "cloudflare:test";

/**
 * Clear all auth tables between tests. Better Auth writes to these tables
 * via Kysely, so the test harness must reset them so tests are independent.
 */
export async function clearAuthData(): Promise<void> {
  await env.glidecomp_auth.batch([
    env.glidecomp_auth.prepare('DELETE FROM "session"'),
    env.glidecomp_auth.prepare('DELETE FROM "account"'),
    env.glidecomp_auth.prepare('DELETE FROM "verification"'),
    env.glidecomp_auth.prepare('DELETE FROM "apikey"'),
    env.glidecomp_auth.prepare('DELETE FROM "user"'),
  ]);
}

/**
 * Seed a user row directly (bypassing Better Auth). Useful for tests that need
 * a user to exist but don't need a real session. Returns the user id.
 */
export async function seedUser(
  id: string,
  opts: { name?: string; email?: string; username?: string | null } = {}
): Promise<string> {
  const now = new Date().toISOString();
  await env.glidecomp_auth
    .prepare(
      `INSERT INTO "user" (id, name, email, username, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.name ?? `User ${id}`,
      opts.email ?? `${id}@test.com`,
      opts.username ?? null,
      now,
      now
    )
    .run();
  return id;
}

/**
 * Sign in via /api/auth/dev-login and return the Set-Cookie header value so
 * subsequent requests can authenticate. Relies on BETTER_AUTH_URL being
 * localhost (the vitest config's default).
 */
export async function devSignIn(
  email: string,
  name = "Test User"
): Promise<string> {
  const res = await SELF.fetch("http://localhost:8788/api/auth/dev-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok) {
    throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("dev-login returned no Set-Cookie header");
  }
  // Browsers send only the name=value pairs, not attributes.
  return setCookie
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/** Fetch against the worker. Use http://localhost:8788 to match BETTER_AUTH_URL. */
export function fetchWorker(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return SELF.fetch(`http://localhost:8788${path}`, init);
}
