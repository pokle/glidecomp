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

  // Regression for #303: task_track, audit_log and task_pilot_status reference
  // "user" WITHOUT ON DELETE CASCADE, so a user who had left any of those rows
  // used to hit `FOREIGN KEY constraint failed`. They must be de-linked (the
  // denormalized name kept), not deleted, so the audit trail survives.
  test("de-links non-cascading references instead of failing", async () => {
    const cookie = await loginAs("delete-audit@test.com");
    const { id: userId } = await getMe(cookie);

    // audit_log is the simplest of the three to reproduce — it needs only a
    // comp row. Seed one audit entry attributed to this user.
    const comp = await env.glidecomp_auth
      .prepare(
        `INSERT INTO comp (name, creation_date, category) VALUES ('Regression Cup', '2026-01-01', 'pg') RETURNING comp_id`
      )
      .first<{ comp_id: number }>();
    await env.glidecomp_auth
      .prepare(
        `INSERT INTO audit_log (comp_id, timestamp, actor_user_id, actor_name, subject_type, description)
         VALUES (?, '2026-01-02T00:00:00Z', ?, 'Audit User', 'comp', 'did a thing')`
      )
      .bind(comp!.comp_id, userId)
      .run();

    const res = await request("POST", "/api/auth/delete-account", { cookie });
    expect(res.status).toBe(200);

    // User row gone…
    const user = await env.glidecomp_auth
      .prepare('SELECT 1 FROM "user" WHERE id = ?')
      .bind(userId)
      .first();
    expect(user).toBeNull();

    // …but the audit entry survives, de-linked, with its name preserved.
    const audit = await env.glidecomp_auth
      .prepare("SELECT actor_user_id, actor_name FROM audit_log WHERE comp_id = ?")
      .bind(comp!.comp_id)
      .first<{ actor_user_id: string | null; actor_name: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.actor_user_id).toBeNull();
    expect(audit!.actor_name).toBe("Audit User");
  });
});
