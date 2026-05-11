import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { loginAs, request } from "./helpers";

/**
 * Resolve the test user's id from the session cookie by hitting /api/auth/me.
 * Each test creates a fresh user (the dev-login route signs up + signs in),
 * so we have to look up the id rather than hard-coding one.
 */
async function getMe(cookie: string): Promise<{ id: string }> {
  const res = await SELF.fetch("https://test/api/auth/me", {
    headers: { Cookie: cookie },
  });
  const data = (await res.json()) as { user: { id: string } | null };
  if (!data.user) throw new Error("Not authenticated");
  return data.user;
}

describe("POST /api/auth/delete-account R2 cleanup", () => {
  test("rejects unauthenticated request", async () => {
    const res = await request("POST", "/api/auth/delete-account");
    expect(res.status).toBe(401);
  });

  test("deletes every object under u/{userId}/ in R2", async () => {
    const cookie = await loginAs("delete-r2@test.com");
    const { id: userId } = await getMe(cookie);

    // Seed a few objects under the user's prefix and one foreign object to
    // prove the prefix scope is enforced.
    await Promise.all([
      env.R2.put(`u/${userId}/track/aaaa.igc.gz`, "one"),
      env.R2.put(`u/${userId}/track/bbbb.igc.gz`, "two"),
      env.R2.put("u/other-user/track/cccc.igc.gz", "stay"),
      env.R2.put("c/123/t/456/789.igc", "comp data — stay"),
    ]);

    const res = await request("POST", "/api/auth/delete-account", { cookie });
    expect(res.status).toBe(200);

    const remaining = await env.R2.list({ prefix: `u/${userId}/` });
    expect(remaining.objects).toHaveLength(0);

    // Foreign objects untouched.
    expect(await env.R2.get("u/other-user/track/cccc.igc.gz")).not.toBeNull();
    expect(await env.R2.get("c/123/t/456/789.igc")).not.toBeNull();

    // User row gone.
    const user = await env.glidecomp_auth
      .prepare('SELECT 1 FROM "user" WHERE id = ?')
      .bind(userId)
      .first();
    expect(user).toBeNull();
  });

  test("succeeds with no R2 objects (idempotent)", async () => {
    const cookie = await loginAs("delete-empty@test.com");
    const res = await request("POST", "/api/auth/delete-account", { cookie });
    expect(res.status).toBe(200);
  });
});
