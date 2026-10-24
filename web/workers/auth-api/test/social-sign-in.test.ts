// The guard in front of Better Auth's social sign-in (src/index.ts): no
// callback may leave the web, and no ID token may name a new account.

import { describe, expect, test } from "vitest";
import { request } from "./helpers";

describe("social sign-in", () => {
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

  test("an ID token may not carry a name for the new account (SEC-55)", async () => {
    const res = await request("POST", "/api/auth/sign-in/social", {
      body: {
        provider: "google",
        idToken: { token: "x", user: { name: { firstName: "<img src=x onerror=alert(1)>" } } },
      },
      headers: { "cf-connecting-ip": "203.0.113.78" },
    });
    expect(res.status).toBe(400);
  });
});
