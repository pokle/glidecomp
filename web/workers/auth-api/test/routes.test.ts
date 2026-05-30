// Tier-1 security-invariant tests for the custom /api/auth/* routes.
// Tiers 2-4 are stubbed as test.todo(...) — see docs/security-review.md and
// PR #151 for the full proposal.
//
// delete-account is covered more thoroughly in delete-account.test.ts;
// here we only assert the auth-gate behaviour for routes that the dedicated
// test files don't yet cover.

import { describe, expect, test } from "vitest";
import { request } from "./helpers";

// ── GET /api/auth/me ─────────────────────────────────────────────────────────

describe("GET /api/auth/me", () => {
  test("returns { user: null } with no cookie", async () => {
    const res = await request("GET", "/api/auth/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body).toEqual({ user: null });
  });

  test("returns { user: null } with a garbage cookie (does not 500)", async () => {
    const res = await request("GET", "/api/auth/me", {
      cookie: "better-auth.session_token=totally-not-a-real-token",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body).toEqual({ user: null });
  });
});

// ── POST /api/auth/set-username (auth gate only; format tests are Tier 2) ───

describe("POST /api/auth/set-username — auth gate", () => {
  test("returns 401 with no session", async () => {
    const res = await request("POST", "/api/auth/set-username", {
      body: { username: "alice" },
    });
    expect(res.status).toBe(401);
  });

  test.todo("rejects usernames outside 3-20 chars");
  test.todo("rejects usernames with leading/trailing hyphen");
  test.todo("rejects usernames with underscore, space, or HTML");
  test.todo("trims whitespace before validating");
  test.todo("409s when another user already owns the username");
  test.todo("allows re-setting own username to the same value (no 409 vs self)");
});

// ── POST /api/auth/dev-login — body validation ──────────────────────────────

describe("POST /api/auth/dev-login — body validation", () => {
  // The vitest config sets BETTER_AUTH_URL=http://localhost:8788 so this
  // route is enabled. The localhost gating itself is unit-tested in
  // is-local-dev.test.ts.

  test("requires a JSON body with name and email", async () => {
    const res = await request("POST", "/api/auth/dev-login", {
      body: { email: "" },
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-JSON body with 400", async () => {
    const res = await request("POST", "/api/auth/dev-login", {
      raw: "not json",
    });
    expect(res.status).toBe(400);
  });
});

// ── Better Auth apiKey plugin (Tier 4 — integration) ────────────────────────

describe("API key plugin", () => {
  test.todo("round-trip: create → /me with x-api-key resolves to the owner");
  test.todo("revoked key returns 401 on the next /me call");
  test.todo(
    "rate limit: 61st request inside 60s window returns 429 (SEC-08)"
  );
});
