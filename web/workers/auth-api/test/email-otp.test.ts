// Email-OTP sign-in flow through the real Better Auth endpoints, using the
// dev OTP capture (isLocalDev is true under the test env) instead of a
// mailbox. Also covers the per-IP rate limit, the per-email send throttle,
// and the dev-last-otp helper's gating.
//
// Each test sends a distinct cf-connecting-ip (the header auth.ts keys rate
// limits on): without one, every test would share Better Auth's fallback
// bucket and the suite would 429 itself.

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { loginAs, request } from "./helpers";
import {
  OTP_EMAIL_SEND_THROTTLE,
  OTP_SEND_RATE_LIMIT,
  registerOtpEmailSend,
} from "../src/rate-limit";

async function sendOtp(email: string, ip: string): Promise<Response> {
  return request("POST", "/api/auth/email-otp/send-verification-otp", {
    body: { email, type: "sign-in" },
    headers: { "cf-connecting-ip": ip },
  });
}

async function fetchDevOtp(email: string): Promise<string> {
  const res = await request(
    "GET",
    `/api/auth/dev-last-otp?email=${encodeURIComponent(email)}`
  );
  expect(res.status).toBe(200);
  const { otp } = (await res.json()) as { otp: string };
  return otp;
}

async function signInWithOtp(
  email: string,
  otp: string,
  ip: string
): Promise<Response> {
  return request("POST", "/api/auth/sign-in/email-otp", {
    body: { email, otp },
    headers: { "cf-connecting-ip": ip },
  });
}

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((sc) => sc.split(";")[0])
    .join("; ");
}

describe("email OTP sign-in", () => {
  test("send → verify signs in a brand-new user", async () => {
    const email = "otp-new-user@example.com";
    const sendRes = await sendOtp(email, "203.0.113.1");
    expect(sendRes.status).toBe(200);

    const otp = await fetchDevOtp(email);
    expect(otp).toMatch(/^\d{6}$/);

    const signInRes = await signInWithOtp(email, otp, "203.0.113.1");
    expect(signInRes.status).toBe(200);
    const cookie = cookieHeader(signInRes);
    expect(cookie).not.toBe("");

    const meRes = await request("GET", "/api/auth/me", { cookie });
    const me = (await meRes.json()) as { user: { email: string } | null };
    expect(me.user?.email).toBe(email);
  });

  test("signs into the SAME account as an existing user with that email", async () => {
    // Simulates the Google-first user: dev-login creates the account, then
    // OTP sign-in must resolve to it rather than minting a duplicate.
    const email = "otp-existing-user@example.com";
    const cookie1 = await loginAs(email, "Existing Pilot");
    const me1 = (await (
      await request("GET", "/api/auth/me", { cookie: cookie1 })
    ).json()) as { user: { id: string } };

    await sendOtp(email, "203.0.113.2");
    const otp = await fetchDevOtp(email);
    const signInRes = await signInWithOtp(email, otp, "203.0.113.2");
    expect(signInRes.status).toBe(200);

    const me2 = (await (
      await request("GET", "/api/auth/me", { cookie: cookieHeader(signInRes) })
    ).json()) as { user: { id: string } };
    expect(me2.user.id).toBe(me1.user.id);
  });

  test("a wrong code is rejected", async () => {
    const email = "otp-wrong-code@example.com";
    await sendOtp(email, "203.0.113.3");
    const otp = await fetchDevOtp(email);
    const wrong = otp === "000000" ? "000001" : "000000";
    const res = await signInWithOtp(email, wrong, "203.0.113.3");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("session cookie lasts 60 days", async () => {
    const email = "otp-session-length@example.com";
    await sendOtp(email, "203.0.113.4");
    const otp = await fetchDevOtp(email);
    const res = await signInWithOtp(email, otp, "203.0.113.4");
    const sessionCookie = res.headers
      .getSetCookie()
      .find((sc) => sc.includes("session_token"));
    expect(sessionCookie).toBeDefined();
    const maxAge = /max-age=(\d+)/i.exec(sessionCookie!)?.[1];
    expect(Number(maxAge)).toBe(60 * 60 * 24 * 60);
  });
});

describe("per-IP send rate limit", () => {
  test("429s past the per-minute cap, with Retry-After", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < OTP_SEND_RATE_LIMIT.max; i++) {
      const res = await sendOtp(`ip-limit-${i}@example.com`, ip);
      expect(res.status).toBe(200);
    }
    const blocked = await sendOtp("ip-limit-over@example.com", ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("per-email send throttle", () => {
  test("allows up to the cap in one window, then denies, then resets", async () => {
    const email = "throttle-unit@example.com";
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < OTP_EMAIL_SEND_THROTTLE.maxSends; i++) {
      expect(
        await registerOtpEmailSend(env.glidecomp_auth, email, t0 + i)
      ).toBe(true);
    }
    expect(
      await registerOtpEmailSend(env.glidecomp_auth, email, t0 + 1000)
    ).toBe(false);
    // A fresh window (anchored at the FIRST send) starts over.
    expect(
      await registerOtpEmailSend(
        env.glidecomp_auth,
        email,
        t0 + OTP_EMAIL_SEND_THROTTLE.windowMs + 1
      )
    ).toBe(true);
  });

  test("keys are case/whitespace-insensitive per address", async () => {
    const t0 = 2_000_000_000_000;
    for (let i = 0; i < OTP_EMAIL_SEND_THROTTLE.maxSends; i++) {
      await registerOtpEmailSend(env.glidecomp_auth, "Case@Example.com", t0 + i);
    }
    expect(
      await registerOtpEmailSend(env.glidecomp_auth, " case@example.com ", t0 + 10)
    ).toBe(false);
  });

  test("throttled sends still return 200 but deliver nothing (no inbox oracle)", async () => {
    const email = "throttle-endpoint@example.com";
    // Exhaust the address's window directly (distributed-abuser scenario:
    // the per-IP limiter never trips because every request has a new IP).
    for (let i = 0; i < OTP_EMAIL_SEND_THROTTLE.maxSends; i++) {
      await registerOtpEmailSend(env.glidecomp_auth, email);
    }
    const res = await sendOtp(email, "203.0.113.60");
    expect(res.status).toBe(200); // indistinguishable from a delivered send
    const devRes = await request(
      "GET",
      `/api/auth/dev-last-otp?email=${encodeURIComponent(email)}`
    );
    expect(devRes.status).toBe(404); // ...but no OTP was captured/sent
  });
});

describe("dev-last-otp gating (SEC-07 pattern)", () => {
  test("requires the email param", async () => {
    const res = await request("GET", "/api/auth/dev-last-otp");
    expect(res.status).toBe(400);
  });

  test("404s for an email that never requested a code", async () => {
    const res = await request(
      "GET",
      "/api/auth/dev-last-otp?email=never-asked@example.com"
    );
    expect(res.status).toBe(404);
  });
});
