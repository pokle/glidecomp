import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import {
  resetSessionKeyCache,
  verifySessionCookie,
} from "@glidecomp/worker-kit/session-cookie";
import { applySetCookies, loginAs, request } from "./helpers";

/**
 * The session cookie cache, end to end: auth-api signs a `session_data` JWT
 * with the jwt plugin's private key, and the verifier competition-api and the
 * SSR Function use (@glidecomp/worker-kit/session-cookie) accepts it with
 * nothing but the published public key.
 *
 * The verifier is exercised against THIS worker's real cookies and real
 * /api/auth/jwks, so a Better Auth upgrade that changed the cookie's shape
 * fails here rather than silently sending every request back to D1.
 */

const fetchJwks = () => SELF.fetch("https://test/api/auth/jwks");

function cookieValue(cookie: string, name: string): string | undefined {
  for (const pair of cookie.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function decodeSegment(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

function encodeSegment(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

beforeEach(() => resetSessionKeyCache());

describe("session cookie cache", () => {
  test("sign-in sets a session_data JWT signed by a key published at /jwks", async () => {
    const cookie = await loginAs("cache-1@test.local", "Cache One");
    const jwt = cookieValue(cookie, "better-auth.session_data");
    expect(jwt).toBeTruthy();

    const header = decodeSegment(jwt!.split(".")[0]);
    expect(header.typ).toBe("better-auth.session-cache+jwt");
    expect(header.alg).toBe("EdDSA");

    const jwks = (await (await fetchJwks()).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(jwks.keys.map((k) => k.kid)).toContain(header.kid);
    // Public halves only — the private key never leaves auth-api.
    for (const key of jwks.keys) expect(key).not.toHaveProperty("d");
  });

  test("the worker-kit verifier accepts it with the public key alone", async () => {
    const cookie = await loginAs("cache-2@test.local", "Cache Two");
    const user = await verifySessionCookie(cookie, fetchJwks);
    expect(user).toMatchObject({ email: "cache-2@test.local", name: "Cache Two" });
    expect(typeof user?.id).toBe("string");
  });

  test("/me answers from the cookie without reading D1", async () => {
    const cookie = await loginAs("cache-3@test.local", "Cache Three");
    // Remove the session behind the browser's back. Only a cached answer can
    // still name the user — which is also the revocation lag this trades for.
    await env.glidecomp_auth
      .prepare('DELETE FROM "session" WHERE "userId" = (SELECT id FROM "user" WHERE email = ?)')
      .bind("cache-3@test.local")
      .run();

    const cached = await request("GET", "/api/auth/me", { cookie });
    expect(((await cached.json()) as { user: { email: string } | null }).user?.email).toBe(
      "cache-3@test.local"
    );

    // Without the cache cookie, /me goes to D1 and finds nothing.
    const tokenOnly = cookie
      .split("; ")
      .filter((p) => !p.startsWith("better-auth.session_data"))
      .join("; ");
    const fresh = await request("GET", "/api/auth/me", { cookie: tokenOnly });
    expect(((await fresh.json()) as { user: unknown }).user).toBeNull();
  });

  test("/me re-issues the cache cookie when it had to read D1", async () => {
    const cookie = await loginAs("cache-4@test.local");
    const tokenOnly = cookie
      .split("; ")
      .filter((p) => !p.startsWith("better-auth.session_data"))
      .join("; ");
    const res = await request("GET", "/api/auth/me", { cookie: tokenOnly });
    const refreshed = applySetCookies(tokenOnly, res);
    expect(cookieValue(refreshed, "better-auth.session_data")).toBeTruthy();
    expect(await verifySessionCookie(refreshed, fetchJwks)).toMatchObject({
      email: "cache-4@test.local",
    });
  });

  test("the verifier refuses a cache cookie that does not match its session_token", async () => {
    const a = await loginAs("cache-5a@test.local");
    const b = await loginAs("cache-5b@test.local");
    // A's session token beside B's (validly signed) cached session.
    const mixed = [
      `better-auth.session_token=${cookieValue(a, "better-auth.session_token")}`,
      `better-auth.session_data=${cookieValue(b, "better-auth.session_data")}`,
    ].join("; ");
    expect(await verifySessionCookie(mixed, fetchJwks)).toBeUndefined();
  });

  test("the verifier refuses a tampered payload", async () => {
    const cookie = await loginAs("cache-6@test.local", "Honest");
    const jwt = cookieValue(cookie, "better-auth.session_data")!;
    const [h, p, sig] = jwt.split(".");
    const payload = decodeSegment(p) as { user: { name: string } };
    payload.user.name = "Forged";
    const forged = cookie.replace(jwt, [h, encodeSegment(payload), sig].join("."));
    expect(await verifySessionCookie(forged, fetchJwks)).toBeUndefined();
  });

  test("the verifier refuses a token signed with the secret instead (alg confusion)", async () => {
    const cookie = await loginAs("cache-7@test.local");
    const jwt = cookieValue(cookie, "better-auth.session_data")!;
    const [h, p] = jwt.split(".");
    const header = decodeSegment(h);
    const forged = [encodeSegment({ ...header, alg: "HS256" }), p, "AAAA"].join(".");
    expect(
      await verifySessionCookie(cookie.replace(jwt, forged), fetchJwks)
    ).toBeUndefined();
  });

  test("a missing session_token means no cached answer", async () => {
    const cookie = await loginAs("cache-8@test.local");
    const dataOnly = cookie
      .split("; ")
      .filter((p) => p.startsWith("better-auth.session_data"))
      .join("; ");
    expect(await verifySessionCookie(dataOnly, fetchJwks)).toBeUndefined();
  });

  test("/api/auth/token is not served", async () => {
    const cookie = await loginAs("cache-9@test.local");
    const res = await request("GET", "/api/auth/token", { cookie });
    expect(res.status).toBe(404);
  });

  test("get-session hands page scripts no JWT header", async () => {
    const cookie = await loginAs("cache-10@test.local");
    const res = await request("GET", "/api/auth/get-session", { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-auth-jwt")).toBeNull();
  });

  test("delete-account expires the cache cookie as well as the session", async () => {
    let cookie = await loginAs("cache-11@test.local");
    const res = await request("POST", "/api/auth/delete-account", { cookie });
    expect(res.status).toBe(200);
    cookie = applySetCookies(cookie, res);
    expect(cookieValue(cookie, "better-auth.session_data")).toBeUndefined();
    expect(cookieValue(cookie, "better-auth.session_token")).toBeUndefined();
  });
});
