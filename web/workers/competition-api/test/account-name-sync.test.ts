/**
 * Issue #539 — a display name edited in Settings must reach the ACCOUNT, not
 * just the pilot profile.
 *
 * There are two names in the same database: `pilot.name`, written by
 * `PATCH /api/comp/pilot`, and `"user".name`, which /api/auth/me answers and
 * which the account menu, the static Astro chrome and the audit log's
 * `actor_name` all read. Only sign-up and onboarding ever wrote the second,
 * so the two agreed exactly when anyone would think to check and diverged the
 * moment someone corrected their name — leaving an organiser signing every
 * later entry of a competition's public transparency record with the name
 * they had just fixed.
 *
 * The PATCH now writes both, in that order, so no caller can save one half.
 *
 * The AUTH_API mock (vitest.config.ts) mirrors the real set-name route: it
 * remembers the rename when the request carries `test-account-sync=1`, and
 * answers 500 instead when it carries `test-setname-fail=1`.
 */
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { clearCompData, request } from "./helpers";

/** The account this file renames — see TEST_USERS in vitest.config.ts. */
const USER = "user-rename";
const ORIGINAL_NAME = "Original Name";

/** PATCH the profile as `user-rename`, with whichever mock flags are wanted. */
function patchProfile(
  body: Record<string, unknown>,
  flags: { sync?: boolean; failSetName?: boolean } = {}
): Promise<Response> {
  const cookie = [
    `test-user=${USER}`,
    flags.sync ? "test-account-sync=1" : null,
    flags.failSetName ? "test-setname-fail=1" : null,
  ]
    .filter(Boolean)
    .join("; ");

  return SELF.fetch("https://test/api/comp/pilot", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

/** The pilot profile's own name, as the route reports it. */
async function profileName(): Promise<string | null> {
  const res = await request("GET", "/api/comp/pilot", { user: USER });
  const body = (await res.json()) as { name: string | null };
  return body.name;
}

/** Audit entries for a comp, newest first (the endpoint is public). */
async function auditEntries(
  compId: string
): Promise<Array<Record<string, unknown>>> {
  const res = await request("GET", `/api/comp/${compId}/audit`);
  const body = (await res.json()) as { entries: Array<Record<string, unknown>> };
  return body.entries;
}

async function createCompAs(name: string): Promise<string> {
  const res = await request("POST", "/api/comp", {
    body: { name, category: "hg" },
    user: USER,
  });
  const body = (await res.json()) as { comp_id: string };
  return body.comp_id;
}

describe("PATCH /api/comp/pilot keeps the account's display name in step", () => {
  beforeEach(async () => {
    await clearCompData();
    // Per-test storage isolation wipes the `user` table, and clearCompData
    // only re-seeds the four shared users.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO "user" (id, name, email, username, "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        USER,
        ORIGINAL_NAME,
        "rename@test.com",
        "originalname",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z"
      )
      .run();

    // The mock's rename map outlives a single test, so put the account back
    // to its seeded name — and leave a pilot row holding it too. A no-op hop
    // when the previous test left the two already in step.
    await patchProfile({ name: ORIGINAL_NAME }, { sync: true });
  });

  test("a renamed profile renames the account, and later audit entries say so", async () => {
    const compId = await createCompAs("Rename Cup");

    const res = await patchProfile({ name: "Corrected Name" }, { sync: true });
    expect(res.status).toBe(200);
    expect(await profileName()).toBe("Corrected Name");

    // Any mutation after the rename signs with the new name. This is the
    // symptom the issue is really about: the audit log is a competition's
    // public transparency record.
    await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Rename Cup 2026" },
      user: USER,
    });

    const entries = await auditEntries(compId);
    const renamedComp = entries.find((e) =>
      (e.description as string).includes("Rename Cup 2026")
    );
    expect(renamedComp).toBeDefined();
    expect(renamedComp!.actor_name).toBe("Corrected Name");

    // …and the entries written BEFORE it keep the name they were signed with.
    // actor_name is denormalised on purpose — a rename changes what gets
    // written next, it does not rewrite the past.
    const created = entries.find((e) =>
      (e.description as string).startsWith("Created competition")
    );
    expect(created!.actor_name).toBe(ORIGINAL_NAME);
  });

  test("the same trimmed string lands in both names", async () => {
    const compId = await createCompAs("Padding Cup");

    const res = await patchProfile({ name: "  Padded Name  " }, { sync: true });
    expect(res.status).toBe(200);
    expect(await profileName()).toBe("Padded Name");

    await request("PATCH", `/api/comp/${compId}`, {
      body: { name: "Padding Cup 2026" },
      user: USER,
    });
    const entries = await auditEntries(compId);
    const renamed = entries.find((e) =>
      (e.description as string).includes("Padding Cup 2026")
    );
    expect(renamed!.actor_name).toBe("Padded Name");
  });

  test("a failed account write saves nothing and says so", async () => {
    const res = await patchProfile(
      { name: "Should Not Land" },
      { failSetName: true }
    );
    expect(res.status).toBe(503);

    // The profile is untouched: a half-saved rename is the bug, not the fix.
    expect(await profileName()).toBe(ORIGINAL_NAME);
  });

  test("a whitespace-only name is refused, not stored", async () => {
    // `min(1)` lets "   " through, and it would clear the account's name —
    // which is half of the onboarding gate.
    const res = await patchProfile({ name: "   " }, { sync: true });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "Display name is required",
    });
    expect(await profileName()).toBe(ORIGINAL_NAME);
  });

  test("a save that leaves the name alone never touches the account", async () => {
    // Settings resubmits every field on every save, so an edit to some other
    // field must not be able to fail on an auth-api blip. The forced
    // set-name failure proves the hop is not even attempted.
    const res = await patchProfile(
      { phone: "0400 000 000" },
      { failSetName: true }
    );
    expect(res.status).toBe(200);
    expect(await profileName()).toBe(ORIGINAL_NAME);
  });

  test("resubmitting the name unchanged never touches the account", async () => {
    const res = await patchProfile(
      { name: ORIGINAL_NAME, phone: "0400 111 111" },
      { failSetName: true }
    );
    expect(res.status).toBe(200);
    expect(await profileName()).toBe(ORIGINAL_NAME);
  });
});
