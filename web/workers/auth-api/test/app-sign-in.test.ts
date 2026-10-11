// The native app's sign-in (mobile plan, stage 4): the expo() plugin's origin
// mapping, and the guard that keeps a session cookie out of every URL
// (guardSocialSignIn's note in src/index.ts).

import { describe, expect, test } from "vitest";
import { request } from "./helpers";

async function fetchDevOtp(email: string): Promise<string> {
  const res = await request("GET", `/api/auth/dev-last-otp?email=${encodeURIComponent(email)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { otp: string }).otp;
}

describe("the app's origin", () => {
  test.each(["glidecomp://", "glidecomp-dev://"])("%s signs in with an emailed code", async (origin) => {
    const email = `app-${origin.replace(/\W/g, "")}@example.com`;
    const ip = origin === "glidecomp://" ? "203.0.113.71" : "203.0.113.72";
    const send = await request("POST", "/api/auth/email-otp/send-verification-otp", {
      body: { email, type: "sign-in" },
      headers: { "expo-origin": origin, "cf-connecting-ip": ip },
    });
    expect(send.status).toBe(200);

    const signIn = await request("POST", "/api/auth/sign-in/email-otp", {
      body: { email, otp: await fetchDevOtp(email) },
      headers: { "expo-origin": origin, "cf-connecting-ip": ip },
    });
    expect(signIn.status).toBe(200);
    // The cookie arrives in the response, for the app's secure store.
    expect(signIn.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);
  });

  test("an origin nobody trusts is refused", async () => {
    const res = await request("POST", "/api/auth/email-otp/send-verification-otp", {
      body: { email: "app-untrusted@example.com", type: "sign-in" },
      headers: { "expo-origin": "attacker://", "cf-connecting-ip": "203.0.113.73" },
    });
    expect(res.status).toBe(403);
  });
});

describe("no session cookie rides a URL", () => {
  test("/expo-authorization-proxy is not served (it is an open redirect too)", async () => {
    const res = await request(
      "GET",
      `/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent("https://attacker.example/?state=x")}`
    );
    expect(res.status).toBe(404);
  });

  test.each(["callbackURL", "newUserCallbackURL", "errorCallbackURL"])(
    "a custom-scheme %s is refused",
    async (field) => {
      const res = await request("POST", "/api/auth/sign-in/social", {
        body: { provider: "google", [field]: "glidecomp://me" },
        headers: { "cf-connecting-ip": "203.0.113.74" },
      });
      expect(res.status).toBe(400);
    }
  );

  test("the website's own callback still starts Google's redirect flow", async () => {
    const res = await request("POST", "/api/auth/sign-in/social", {
      body: { provider: "google", callbackURL: "/signin?via=google&next=%2Fcomp" },
      headers: { "cf-connecting-ip": "203.0.113.75" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string; redirect?: boolean };
    expect(body.redirect).toBe(true);
    expect(body.url).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  test("a non-JSON body is refused before Better Auth reads it", async () => {
    const res = await request("POST", "/api/auth/sign-in/social", {
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.76" },
    });
    expect(res.status).toBe(415);
  });
});

describe("Sign in with Apple is native-only", () => {
  test("Apple's web flow is refused", async () => {
    const res = await request("POST", "/api/auth/sign-in/social", {
      body: { provider: "apple", callbackURL: "/comp" },
      headers: { "cf-connecting-ip": "203.0.113.77" },
    });
    expect(res.status).toBe(400);
  });

  test("an ID token may not carry a name for the new account (SEC-55)", async () => {
    const res = await request("POST", "/api/auth/sign-in/social", {
      body: {
        provider: "apple",
        idToken: { token: "x", user: { name: { firstName: "<img src=x onerror=alert(1)>" } } },
      },
      headers: { "cf-connecting-ip": "203.0.113.78" },
    });
    expect(res.status).toBe(400);
  });

  test("a token Apple did not sign is refused by Better Auth", async () => {
    const header = btoa(JSON.stringify({ alg: "RS256", kid: "nope" })).replace(/=+$/, "");
    const payload = btoa(JSON.stringify({ iss: "https://appleid.apple.com", aud: "com.glidecomp.app" })).replace(/=+$/, "");
    const res = await request("POST", "/api/auth/sign-in/social", {
      body: { provider: "apple", idToken: { token: `${header}.${payload}.c2ln` } },
      headers: { "cf-connecting-ip": "203.0.113.79" },
    });
    expect(res.status).toBe(401);
  });
});
