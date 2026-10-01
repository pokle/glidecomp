// Email-OTP sign-in flow through the real Better Auth endpoints, using the
// dev OTP capture (isLocalDev is true under the test env) instead of a
// mailbox. Also covers the per-IP rate limit, the per-email send throttle,
// and the dev-last-otp helper's gating.
//
// Each test sends a distinct cf-connecting-ip (the header auth.ts keys rate
// limits on): without one, every test would share Better Auth's fallback
// bucket and the suite would 429 itself.

import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { applySetCookies, loginAs, request } from "./helpers";
import {
  OTP_EMAIL_SEND_THROTTLE,
  OTP_SEND_RATE_LIMIT,
  OTP_VERIFY_FAILURE_BUDGET,
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

  test("a brand-new user arrives with a derived username and NO name", async () => {
    // The state the onboarding gate exists to catch. Better Auth's email-otp
    // route has no name to work from, so it creates the account with `name:
    // ""`; our user.create hook still derives a username, but with the name
    // slug empty it falls through to the email local-part. Onboarding is the
    // only thing that ever asks for the name, so a username-only gate would
    // leave this account nameless forever.
    const email = "otp-no-name@example.com";
    await sendOtp(email, "203.0.113.9");
    const signInRes = await signInWithOtp(
      email,
      await fetchDevOtp(email),
      "203.0.113.9"
    );
    let cookie = cookieHeader(signInRes);

    const me = (await (
      await request("GET", "/api/auth/me", { cookie })
    ).json()) as { user: { name: string; username: string } };
    expect(me.user.name).toBe("");
    expect(me.user.username).toBe("otp-no-name");

    // …and set-username is what gets it out of that state, in one request.
    const fix = await request("POST", "/api/auth/set-username", {
      cookie,
      body: { username: "nogales", name: "Jean Nogales" },
    });
    expect(fix.status).toBe(200);
    cookie = applySetCookies(cookie, fix);
    const after = (await (
      await request("GET", "/api/auth/me", { cookie })
    ).json()) as { user: { name: string; username: string } };
    expect(after.user).toMatchObject({
      name: "Jean Nogales",
      username: "nogales",
    });
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

/** How many codes Better Auth holds for `email` (it stores one row per mint). */
async function liveCodeRows(email: string, type = "sign-in"): Promise<number> {
  const row = await env.glidecomp_auth
    .prepare("SELECT COUNT(*) AS n FROM verification WHERE identifier = ?")
    .bind(`${type}-otp-${email}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("SEC-56: per-address budgets hold against a distributed guesser", () => {
  // Every request below comes from its own address, so Better Auth's per-IP
  // limiter never trips: the per-ADDRESS budgets are all that stands between
  // a guesser and a six-digit code.

  test("a throttled send leaves no new code behind", async () => {
    const email = "sec56-throttled-mint@example.com";
    for (let i = 0; i < OTP_EMAIL_SEND_THROTTLE.maxSends; i++) {
      await registerOtpEmailSend(env.glidecomp_auth, email);
    }
    const res = await sendOtp(email, "198.51.100.200");
    expect(res.status).toBe(200); // still indistinguishable from a sent code
    // Before the fix Better Auth minted (and stored) a fresh code — three new
    // guesses — and only the email was withheld.
    expect(await liveCodeRows(email)).toBe(0);
  });

  test("wrong codes spend the address's budget, after which even the right code is refused", async () => {
    const email = "sec56-guessed@example.com";
    expect((await sendOtp(email, "198.51.100.1")).status).toBe(200);
    const real = await fetchDevOtp(email);
    const wrong = real === "000000" ? "000001" : "000000";

    for (let i = 0; i < OTP_VERIFY_FAILURE_BUDGET.max; i++) {
      const res = await signInWithOtp(email, wrong, `198.51.100.${10 + i}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(429);
    }

    // A fresh, correct code, from yet another address: still refused, so a
    // guesser who finally hits the code is turned away with everyone else.
    expect((await sendOtp(email, "198.51.100.99")).status).toBe(200);
    const blocked = await signInWithOtp(email, await fetchDevOtp(email), "198.51.100.98");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(blocked.headers.getSetCookie()).toEqual([]);
  });

  test("another address is untouched by one address's spent budget", async () => {
    const spent = "sec56-spent@example.com";
    await sendOtp(spent, "198.51.100.120");
    const real = await fetchDevOtp(spent);
    const wrong = real === "000000" ? "000001" : "000000";
    for (let i = 0; i < OTP_VERIFY_FAILURE_BUDGET.max; i++) {
      await signInWithOtp(spent, wrong, `198.51.100.${130 + i}`);
    }
    const other = "sec56-other@example.com";
    await sendOtp(other, "198.51.100.121");
    const ok = await signInWithOtp(other, await fetchDevOtp(other), "198.51.100.122");
    expect(ok.status).toBe(200);
  });

  test("a right code first time costs nothing", async () => {
    const email = "sec56-first-time@example.com";
    await sendOtp(email, "198.51.100.140");
    const ok = await signInWithOtp(email, await fetchDevOtp(email), "198.51.100.141");
    expect(ok.status).toBe(200);
    const row = await env.glidecomp_auth
      .prepare('SELECT 1 FROM "rateLimit" WHERE "key" = ?')
      .bind(`otp-fail:${email}`)
      .first();
    expect(row).toBeNull();
  });

  test("only sign-in codes are minted", async () => {
    // An existing account, so that a mint for it is kept rather than undone.
    const email = "sec56-other-type@example.com";
    await loginAs(email, "Other Type");
    for (const type of ["forget-password", "email-verification"]) {
      const res = await request("POST", "/api/auth/email-otp/send-verification-otp", {
        body: { email, type },
        headers: { "cf-connecting-ip": "198.51.100.150" },
      });
      expect(res.status).toBe(400);
      expect(await liveCodeRows(email, type)).toBe(0);
    }
  });

  test("a body the guards cannot read never reaches Better Auth", async () => {
    // The budgets only read JSON. Better Auth refuses other bodies on these two
    // routes today too, but the guards must not depend on that: some of its
    // endpoints do take form bodies.
    for (const path of ["/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp"]) {
      const res = await SELF.fetch(`https://test${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.51.100.160",
        },
        body: "email=sec56-form%40example.com&type=sign-in&otp=000000",
      });
      expect(res.status).toBe(415);
    }
    expect(await liveCodeRows("sec56-form@example.com")).toBe(0);
  });

  test("a first sign-in cannot name the account (SEC-55)", async () => {
    const email = "sec56-named@example.com";
    await sendOtp(email, "198.51.100.170");
    const res = await request("POST", "/api/auth/sign-in/email-otp", {
      body: { email, otp: await fetchDevOtp(email), name: "<b>x</b>" },
      headers: { "cf-connecting-ip": "198.51.100.170" },
    });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
