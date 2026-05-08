// Regression tests for SEC-10: the comp-api auth middleware previously
// trusted an `X-Glidecomp-Internal-User` header on every request, which
// (because comp-api is bound to the public route glidecomp.com/api/comp/*)
// allowed any internet client to forge user identity. The fix is to never
// read that header — only resolve identity via auth-api using the inbound
// `cookie` or `x-api-key`.
//
// These tests assert that:
//   1. A request bearing a forged X-Glidecomp-Internal-User is treated as
//      unauthenticated.
//   2. The same request with a real cookie still authenticates correctly
//      (sanity check that the regression doesn't accidentally break auth).
//
// The mock AUTH_API in vitest.config.ts only honours the `cookie` test-user
// pattern, so an attempt to spoof via the internal header should land in
// the unauthenticated branch and return 401 from `requireAuth`.

import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const FORGED_USER = JSON.stringify({
  id: "user-1",
  name: "Test Pilot",
  email: "pilot@test.com",
  image: null,
  username: "testpilot",
});

describe("Auth header trust boundary (SEC-10)", () => {
  test("forged X-Glidecomp-Internal-User does NOT authenticate", async () => {
    // POST /api/comp requires authentication. If the forged header were
    // trusted we'd see 201; since it's ignored we should see 401.
    const res = await SELF.fetch("https://test/api/comp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Glidecomp-Internal-User": FORGED_USER,
      },
      body: JSON.stringify({ name: "Forged Comp", category: "hg" }),
    });
    expect(res.status).toBe(401);
  });

  test("real cookie still authenticates (regression sanity)", async () => {
    const res = await SELF.fetch("https://test/api/comp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "test-user=user-1",
      },
      body: JSON.stringify({ name: "Real Comp", category: "hg" }),
    });
    expect(res.status).toBe(201);
  });

  test("forged header alongside real cookie is ignored (cookie wins)", async () => {
    // The attacker-controlled header must not override or augment the
    // legitimately authenticated user. This passes as long as we ignore
    // the header entirely — the cookie path resolves to user-1.
    const res = await SELF.fetch("https://test/api/comp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "test-user=user-1",
        "X-Glidecomp-Internal-User": JSON.stringify({
          id: "user-2",
          name: "Admin Two",
          email: "admin2@test.com",
          image: null,
          username: "admin2",
        }),
      },
      body: JSON.stringify({ name: "Mixed Comp", category: "hg" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { comp_id: string };

    // Verify the comp was created as user-1, not user-2: GET the audit log
    // and confirm the actor is "Test Pilot" (user-1's name).
    const audit = await SELF.fetch(
      `https://test/api/comp/${body.comp_id}/audit`,
      { headers: { Cookie: "test-user=user-1" } }
    );
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as {
      entries: Array<{ actor_name: string }>;
    };
    expect(auditBody.entries.length).toBeGreaterThan(0);
    expect(auditBody.entries[0].actor_name).toBe("Test Pilot");
  });
});
