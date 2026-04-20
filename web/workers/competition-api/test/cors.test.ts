// Regression tests for SEC-01: the CORS middleware must NOT reflect arbitrary
// origins back when credentials:true is set, or any site the user visits while
// logged in could read authenticated responses.
//
// We exercise the middleware via OPTIONS preflight requests to /api/comp,
// which is enough to assert the allowlist logic without needing a fully
// authenticated session.

import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

async function preflight(origin: string): Promise<Response> {
  return SELF.fetch("https://test/api/comp", {
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
    "https://glidecomp.com.evil.example", // suffix attack
    "https://notglidecomp.com",
    "https://glidecomp.pages.dev.evil.example", // pages-preview suffix attack
    "https://fake.glidecomp.pages.dev.attacker.com",
    "http://glidecomp.com", // wrong scheme
  ])("rejects origin %s", async (origin) => {
    const res = await preflight(origin);
    // Hono's cors middleware omits the ACAO header (or sets it to empty) when
    // the origin function returns "". Either is safe — the browser will block.
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao === null || acao === "").toBe(true);
  });

  test("rejects malformed Origin header", async () => {
    const res = await preflight("not-a-url");
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao === null || acao === "").toBe(true);
  });

  test("request with no Origin header gets no ACAO", async () => {
    // Same-origin requests don't send Origin and don't need CORS headers.
    const res = await SELF.fetch("https://test/api/comp", { method: "OPTIONS" });
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao === null || acao === "").toBe(true);
  });
});
