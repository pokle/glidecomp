import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { SignJWT, importJWK } from "jose";
import { resetSessionKeyCache } from "@glidecomp/worker-kit/session-cookie";

/**
 * Identity from auth-api's signed `session_data` cookie, with no auth hop.
 *
 * The mock AUTH_API (vitest.config.ts) publishes a test key's public half at
 * /api/auth/jwks, as auth-api does, and counts /api/auth/me calls per
 * `test-hop-key` cookie. These tests mint the cookie auth-api would set, with
 * the private half, and assert on both the answer and whether the hop ran.
 * auth-api's own suite (session-cache.test.ts) checks the same verifier
 * against the cookies real Better Auth issues.
 */

const CACHED_USER = {
  id: "user-cached",
  name: "Cached Pilot",
  email: "cached@test.com",
  image: null,
  username: "cachedpilot",
};

async function sessionDataJwt(opts: {
  token: string;
  user?: typeof CACHED_USER;
  expiresIn?: number;
  kid?: string;
}): Promise<string> {
  const jwk = JSON.parse(env.TEST_SESSION_SIGNING_JWK);
  const key = await importJWK(jwk, "EdDSA");
  const user = opts.user ?? CACHED_USER;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    session: {
      id: "s1",
      token: opts.token,
      userId: user.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    user: { ...user, emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    updatedAt: Date.now(),
    version: "1",
    sid: opts.token,
  })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: opts.kid ?? "test-kid",
      typ: "better-auth.session-cache+jwt",
    })
    .setIssuedAt()
    .setExpirationTime(now + (opts.expiresIn ?? 300))
    .setIssuer("http://localhost")
    .setAudience("better-auth:session-cache")
    .setSubject(user.id)
    .sign(key);
}

/** The session_token cookie as Better Auth sets it: `<token>.<hmac>`, encoded. */
function sessionTokenCookie(token: string): string {
  return `better-auth.session_token=${encodeURIComponent(`${token}.c2lnbmF0dXJl`)}`;
}

async function meCalls(key: string): Promise<number> {
  const res = await env.AUTH_API.fetch(`https://auth/__test/me-calls?key=${key}`);
  return ((await res.json()) as { calls: number }).calls;
}

async function getProfile(cookie: string, extra: Record<string, string> = {}) {
  return SELF.fetch("https://test/api/comp/pilot", {
    headers: { Cookie: cookie, ...extra },
  });
}

beforeEach(() => resetSessionKeyCache());

describe("session cookie cache", () => {
  test("a valid cache cookie authenticates without the /me hop", async () => {
    const key = "valid";
    const token = "tok-valid";
    const cookie = [
      sessionTokenCookie(token),
      `better-auth.session_data=${await sessionDataJwt({ token })}`,
      `better-auth.test-hop-key=${key}`,
    ].join("; ");

    const res = await getProfile(cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Cached Pilot");
    expect(await meCalls(key)).toBe(0);
  });

  test("the __Secure- prefixed names production uses are read too", async () => {
    const key = "secure";
    const token = "tok-secure";
    const cookie = [
      `__Secure-${sessionTokenCookie(token)}`,
      `__Secure-better-auth.session_data=${await sessionDataJwt({ token })}`,
      `better-auth.test-hop-key=${key}`,
    ].join("; ");

    const res = await getProfile(cookie);
    expect(res.status).toBe(200);
    expect(await meCalls(key)).toBe(0);
  });

  test("an expired cache cookie falls back to the hop, which decides", async () => {
    const key = "expired";
    const token = "tok-expired";
    const cookie = [
      sessionTokenCookie(token),
      `better-auth.session_data=${await sessionDataJwt({ token, expiresIn: -60 })}`,
      `better-auth.test-hop-key=${key}`,
      "better-auth.test-user=user-1",
    ].join("; ");

    const res = await getProfile(cookie);
    expect(res.status).toBe(200);
    // The hop's answer (user-1), not the expired cookie's.
    expect(((await res.json()) as { name: string }).name).toBe("Test Pilot");
    expect(await meCalls(key)).toBe(1);
  });

  test("a cookie signed by a key auth-api never published is not trusted", async () => {
    const key = "unknown-kid";
    const token = "tok-unknown";
    const cookie = [
      sessionTokenCookie(token),
      `better-auth.session_data=${await sessionDataJwt({ token, kid: "someone-elses" })}`,
      `better-auth.test-hop-key=${key}`,
    ].join("; ");

    // The hop has no test-user, so it answers "signed out".
    const res = await getProfile(cookie);
    expect(res.status).toBe(401);
    expect(await meCalls(key)).toBe(1);
  });

  test("a cache cookie for a different session_token is not trusted", async () => {
    const key = "mismatch";
    const cookie = [
      sessionTokenCookie("tok-mine"),
      `better-auth.session_data=${await sessionDataJwt({ token: "tok-theirs" })}`,
      `better-auth.test-hop-key=${key}`,
    ].join("; ");

    const res = await getProfile(cookie);
    expect(res.status).toBe(401);
    expect(await meCalls(key)).toBe(1);
  });

  test("an API key always takes the hop, cookie or not", async () => {
    const key = "api-key";
    const token = "tok-apikey";
    const cookie = [
      sessionTokenCookie(token),
      `better-auth.session_data=${await sessionDataJwt({ token })}`,
      `better-auth.test-hop-key=${key}`,
      "better-auth.test-user=user-1",
    ].join("; ");

    const res = await getProfile(cookie, { "x-api-key": "glc_whatever" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Test Pilot");
    expect(await meCalls(key)).toBe(1);
  });

  test("a visitor with only non-auth cookies costs no hop", async () => {
    // Unprefixed, so forwardAuthHeaders drops it along with the analytics
    // cookie. Were it forwarded, the mock would count a /me call against it.
    const key = "analytics-only";
    const res = await SELF.fetch("https://test/api/comp", {
      headers: { Cookie: `_ga=GA1.1.123; __cf_bm=abc; test-hop-key=${key}` },
    });
    expect(res.status).toBe(200);
    expect(await meCalls(key)).toBe(0);
  });
});
