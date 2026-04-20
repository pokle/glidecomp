// Tier-1 security-invariant tests for the custom /api/auth/* routes.
// Tiers 2-4 are stubbed as test.todo(...) — see docs/security-review.md and
// the PR that adds this harness for the proposed expansions.

import { describe, expect, test, beforeEach } from "vitest";
import { clearAuthData, fetchWorker } from "./helpers";

beforeEach(async () => {
  await clearAuthData();
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────

describe("GET /api/auth/me", () => {
  test("returns { user: null } with no cookie", async () => {
    const res = await fetchWorker("/api/auth/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body).toEqual({ user: null });
  });

  test("returns { user: null } with a garbage cookie (does not 500)", async () => {
    const res = await fetchWorker("/api/auth/me", {
      headers: { Cookie: "better-auth.session_token=totally-not-a-real-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body).toEqual({ user: null });
  });

  test.todo(
    "returns the signed-in user when given a valid session cookie from dev-login"
  );
});

// ── POST /api/auth/set-username (auth gate only; format tests are Tier 2) ───

describe("POST /api/auth/set-username — auth gate", () => {
  test("returns 401 with no session", async () => {
    const res = await fetchWorker("/api/auth/set-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice" }),
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

// ── POST /api/auth/delete-account (auth gate only) ──────────────────────────

describe("POST /api/auth/delete-account — auth gate", () => {
  test("returns 401 with no session", async () => {
    const res = await fetchWorker("/api/auth/delete-account", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test.todo("removes the user row and cascades session + account rows");
  test.todo("succeeds even when Google token revocation fetch fails");
  test.todo("also removes API keys owned by the deleted user");
});

// ── POST /api/auth/dev-login — only enabled in localhost mode ──────────────

describe("POST /api/auth/dev-login — localhost gating (SEC-07)", () => {
  // The vitest config sets BETTER_AUTH_URL=http://localhost:8788 so this route
  // is enabled. The matching "404 in production" test lives in
  // dev-login-prod.test.ts, which overrides BETTER_AUTH_URL per-test.

  test("requires a JSON body with name and email", async () => {
    const res = await fetchWorker("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects non-JSON body with 400", async () => {
    const res = await fetchWorker("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("creates a user and returns a session cookie on success", async () => {
    const res = await fetchWorker("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice", email: "alice@test.com" }),
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get("set-cookie")).toBeTruthy();
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
