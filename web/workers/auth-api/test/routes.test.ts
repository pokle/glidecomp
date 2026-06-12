// Tier-1 security-invariant tests for the custom /api/auth/* routes.
// Tiers 2-4 are stubbed as test.todo(...) — see docs/security-review.md and
// PR #151 for the full proposal.
//
// delete-account is covered more thoroughly in delete-account.test.ts;
// here we only assert the auth-gate behaviour for routes that the dedicated
// test files don't yet cover.

import { describe, expect, test } from "vitest";
import { loginAs, request } from "./helpers";

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

// ── Body limit (SEC-06) ──────────────────────────────────────────────────────

describe("body limit", () => {
  test("oversize body is rejected with 413 before any handler runs", async () => {
    const res = await request("POST", "/api/auth/dev-login", {
      raw: JSON.stringify({ email: "a@b.c", name: "x".repeat(256 * 1024) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Request body too large");
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

// Better Auth's CSRF guard requires a trusted Origin on its POST endpoints;
// the test config's baseURL origin is trusted by default.
const ORIGIN = { Origin: "http://localhost:8788" };

/** Create an API key for the session and return { id, key }. */
async function createApiKey(cookie: string): Promise<{ id: string; key: string }> {
  const res = await request("POST", "/api/auth/api-key/create", {
    cookie,
    body: { name: "test-key" },
    headers: ORIGIN,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; key: string };
}

describe("API key plugin", () => {
  test("round-trip: create → /me with x-api-key resolves to the owner", async () => {
    const email = "apikey-roundtrip@test.com";
    const cookie = await loginAs(email);
    const { key } = await createApiKey(cookie);
    expect(key.startsWith("glc_")).toBe(true);

    const res = await request("GET", "/api/auth/me", {
      headers: { "x-api-key": key },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } | null };
    expect(body.user?.email).toBe(email);
  });

  test("revoked key no longer resolves a user (and does not 500)", async () => {
    const cookie = await loginAs("apikey-revoke@test.com");
    const { id, key } = await createApiKey(cookie);

    const del = await request("POST", "/api/auth/api-key/delete", {
      cookie,
      body: { keyId: id },
      headers: ORIGIN,
    });
    expect(del.status).toBe(200);

    const res = await request("GET", "/api/auth/me", {
      headers: { "x-api-key": key },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body).toEqual({ user: null });
  });

  test(
    "rate limit: 61st request inside 60s window returns 429 with Retry-After (SEC-08)",
    async () => {
      const cookie = await loginAs("apikey-ratelimit@test.com");
      const { key } = await createApiKey(cookie);

      // The plugin window is 60 requests / 60s (auth.ts). Requests 1-60 pass.
      for (let i = 0; i < 60; i++) {
        const res = await request("GET", "/api/auth/me", {
          headers: { "x-api-key": key },
        });
        expect(res.status).toBe(200);
      }

      const res = await request("GET", "/api/auth/me", {
        headers: { "x-api-key": key },
      });
      expect(res.status).toBe(429);
      const retryAfter = Number(res.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      const body = (await res.json()) as { user: unknown };
      expect(body.user).toBeNull();
    },
    60_000
  );
});
