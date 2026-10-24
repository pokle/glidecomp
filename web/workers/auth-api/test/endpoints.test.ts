// SEC-55: the Better Auth catch-all serves the endpoints the app uses and
// nothing else (src/endpoints.ts). The refused ones were each reachable by any
// signed-in browser or API key before the allowlist.

import { describe, expect, test } from "vitest";
import { isServedAuthEndpoint } from "../src/endpoints";
import { loginAs, request } from "./helpers";

describe("isServedAuthEndpoint", () => {
  test.each([
    ["POST", "/api/auth/sign-in/social"],
    ["GET", "/api/auth/callback/google"],
    ["POST", "/api/auth/callback/google"],
    ["GET", "/api/auth/callback/google/oauth-proxy"],
    ["GET", "/api/auth/oauth-proxy-callback"],
    ["GET", "/api/auth/error"],
    ["POST", "/api/auth/email-otp/send-verification-otp"],
    ["POST", "/api/auth/sign-in/email-otp"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-out"],
    ["GET", "/api/auth/jwks"],
    ["POST", "/api/auth/api-key/create"],
    ["GET", "/api/auth/api-key/list"],
    ["POST", "/api/auth/api-key/delete"],
    ["GET", "/api/auth/ok"],
  ])("serves %s %s", (method, path) => {
    expect(isServedAuthEndpoint(method, path)).toBe(true);
  });

  test.each([
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/get-access-token"],
    ["POST", "/api/auth/refresh-token"],
    ["GET", "/api/auth/account-info"],
    ["GET", "/api/auth/list-accounts"],
    ["POST", "/api/auth/link-social"],
    ["POST", "/api/auth/unlink-account"],
    ["GET", "/api/auth/list-sessions"],
    ["POST", "/api/auth/revoke-sessions"],
    ["POST", "/api/auth/email-otp/check-verification-otp"],
    ["POST", "/api/auth/email-otp/verify-email"],
    ["POST", "/api/auth/forget-password/email-otp"],
    ["POST", "/api/auth/email-otp/reset-password"],
    ["POST", "/api/auth/email-otp/request-email-change"],
    ["POST", "/api/auth/change-email"],
    ["POST", "/api/auth/delete-user"],
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/api-key/get"],
    ["POST", "/api/auth/api-key/update"],
    ["GET", "/api/auth/token"],
    // Right path, wrong method; and nothing outside the base path.
    ["GET", "/api/auth/sign-out"],
    ["GET", "/api/auth/sign-in/social"],
    ["GET", "/api/authx/ok"],
    ["GET", "/ok"],
  ])("refuses %s %s", (method, path) => {
    expect(isServedAuthEndpoint(method, path)).toBe(false);
  });
});

describe("refused endpoints answer 404 before Better Auth sees them", () => {
  test("/update-user cannot rename the account around /set-name's checks", async () => {
    const cookie = await loginAs("sec55-rename@example.com", "Plain Name");
    const res = await request("POST", "/api/auth/update-user", {
      cookie,
      body: { name: "<img src=x onerror=alert(1)>", image: "https://attacker.example/p.gif" },
    });
    expect(res.status).toBe(404);
    const me = (await (await request("GET", "/api/auth/me", { cookie })).json()) as {
      user: { name: string; image: string | null };
    };
    expect(me.user.name).toBe("Plain Name");
    expect(me.user.image).toBeNull();
  });

  test("/get-access-token, /refresh-token and /account-info are not served", async () => {
    const cookie = await loginAs("sec55-tokens@example.com", "Token Holder");
    for (const [method, path] of [
      ["POST", "/api/auth/get-access-token"],
      ["POST", "/api/auth/refresh-token"],
      ["GET", "/api/auth/account-info"],
    ] as const) {
      const res = await request(method, path, {
        cookie,
        ...(method === "POST" ? { body: { providerId: "google" } } : {}),
      });
      expect(res.status, path).toBe(404);
    }
  });

  test("/email-otp/check-verification-otp is not a second way to test a code", async () => {
    const res = await request("POST", "/api/auth/email-otp/check-verification-otp", {
      body: { email: "sec55-check@example.com", type: "sign-in", otp: "000000" },
      headers: { "cf-connecting-ip": "192.0.2.55" },
    });
    expect(res.status).toBe(404);
  });
});

describe("served endpoints still reach Better Auth", () => {
  test("Google sign-in starts", async () => {
    const res = await request("POST", "/api/auth/sign-in/social", {
      body: { provider: "google", callbackURL: "/comp" },
      headers: { "cf-connecting-ip": "192.0.2.56" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  test("the OAuth callback is routed (a bad one fails inside Better Auth, not here)", async () => {
    const res = await request("GET", "/api/auth/callback/google?state=nope&code=nope");
    expect(res.status).not.toBe(404);
  });

  test("/jwks, /get-session and /ok answer", async () => {
    const cookie = await loginAs("sec55-session@example.com", "Session Holder");
    expect((await request("GET", "/api/auth/jwks")).status).toBe(200);
    expect((await request("GET", "/api/auth/ok")).status).toBe(200);
    const session = await request("GET", "/api/auth/get-session", { cookie });
    expect(session.status).toBe(200);
    expect(((await session.json()) as { user?: { email?: string } }).user?.email).toBe(
      "sec55-session@example.com"
    );
  });
});
