/**
 * Issue #481 — a transient failure of the auth hop must not be reported as
 * "anonymous".
 *
 * Every request that needs to know who is calling asks auth-api over the
 * AUTH_API service binding. That hop can fail on its own (a 5xx, a dropped
 * call) while the caller's session is perfectly valid, and the old code
 * turned that into `user = null`: indistinguishable from a signed-out
 * visitor, and acted on immediately. The comp GET dropped `is_admin` and the
 * `admins` list, so an admin's page rendered as a visitor's with no admin
 * controls; on a `test` comp the same blip produced a flat 404,
 * "Competition not found". Nothing self-healed, because nothing knew.
 *
 * The mock AUTH_API honours a `test-auth-fail=<key>:<n>` cookie that makes
 * the first n calls answer 500 (see vitest.config.ts). Each test uses its own
 * key so the countdowns don't bleed into each other.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { createComp, request } from "./helpers";

/** Request as `user`, with the first `failures` auth hops forced to 500. */
function flakyRequest(
  method: string,
  path: string,
  { user, failures, key }: { user: string; failures: number; key: string }
): Promise<Response> {
  return SELF.fetch(`https://test${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `test-user=${user}; test-auth-fail=${key}:${failures}`,
    },
  });
}

describe("transient auth-hop failures (issue #481)", () => {
  test("a comp GET keeps its admin view through a flaky auth hop", async () => {
    const compId = await createComp({ name: "Flaky Auth Comp" });

    const res = await flakyRequest("GET", `/api/comp/${compId}`, {
      user: "user-1",
      failures: 2,
      key: "two-blips-admin",
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      is_admin?: boolean;
      admins: Array<{ email: string }>;
    };
    // The creator is this comp's admin. A blip on the way to auth-api must
    // not silently demote them to a visitor.
    expect(body.is_admin).toBe(true);
    expect(body.admins.map((a) => a.email)).toContain("pilot@test.com");
  });

  test("a hidden test comp still resolves for its admin through a blip", async () => {
    // The sharpest version of the bug: `test` comps 404 for non-admins, so a
    // demoted admin doesn't just lose buttons — the comp disappears.
    const compId = await createComp({ name: "Hidden Flaky Comp", test: true });

    const res = await flakyRequest("GET", `/api/comp/${compId}`, {
      user: "user-1",
      failures: 2,
      key: "two-blips",
    });
    expect(res.status).toBe(200);
  });

  test("a mutation is not rejected as unauthenticated over a blip", async () => {
    const compId = await createComp({ name: "Flaky Mutation Comp" });

    const res = await SELF.fetch(`https://test/api/comp/${compId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: "test-user=user-1; test-auth-fail=mutation-blip:1",
      },
      body: JSON.stringify({ name: "Renamed Through A Blip" }),
    });
    expect(res.status).toBe(200);
  });

  test("a genuinely anonymous caller is still anonymous", async () => {
    // The retry must not invent a session: no cookie means no auth hop at
    // all, and requireAuth must still refuse.
    const res = await request("POST", "/api/comp", {
      body: { name: "Anonymous Comp", category: "hg" },
    });
    expect(res.status).toBe(401);
  });

  test("auth-api down past every retry fails loudly, not anonymously", async () => {
    // More forced failures than there are attempts. requireAuth answers 503
    // ("try again") rather than 401, which would tell a signed-in user their
    // session had gone.
    const res = await SELF.fetch("https://test/api/comp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "test-user=user-1; test-auth-fail=all-down:99",
      },
      body: JSON.stringify({ name: "Never Created", category: "hg" }),
    });
    expect(res.status).toBe(503);
  });
});
