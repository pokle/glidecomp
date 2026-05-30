// Regression tests for SEC-01 on the auth worker: the CORS middleware must
// NOT reflect arbitrary origins back when credentials:true is set, or any site
// the user visits while logged in could read / drive their session.
//
// Mirrors web/workers/competition-api/test/cors.test.ts — the allowlist logic
// is the same in both workers.

import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

async function preflight(origin: string): Promise<Response> {
  return SELF.fetch("http://localhost:8788/api/auth/me", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
}

describe("CORS allowlist (SEC-01)", () => {
  test.each([
    "https://glidecomp.com",
    "https://preview-abc.glidecomp.pages.dev",
    "https://feature-x-y.glidecomp.pages.dev",
    "http://localhost:5173",
    "http://localhost:8788",
  ])("allows origin %s", async (origin) => {
    const res = await preflight(origin);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test.each([
    "https://evil.example",
    "https://glidecomp.com.evil.example",
    "https://notglidecomp.com",
    "https://glidecomp.pages.dev.evil.example",
    "https://fake.glidecomp.pages.dev.attacker.com",
    "http://glidecomp.com",
  ])("rejects origin %s", async (origin) => {
    const res = await preflight(origin);
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao === null || acao === "").toBe(true);
  });

  test("rejects malformed Origin header", async () => {
    const res = await preflight("not-a-url");
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao === null || acao === "").toBe(true);
  });
});
