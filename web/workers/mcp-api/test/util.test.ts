// Tests for the comp-api forwarding helpers. The COMPETITION_API mock
// echoes the inbound request as JSON so we can assert exactly which
// headers we sent — most importantly, that we forward the API key as
// `x-api-key` and never as the legacy X-Glidecomp-Internal-User trust
// header (SEC-10).

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { compApi, compApiRaw } from "../src/util";

interface Echo {
  echo: {
    method: string;
    pathname: string;
    headers: Record<string, string>;
    body: string | null;
  };
}

describe("compApi (header forwarding)", () => {
  test("forwards apiKey as x-api-key", async () => {
    const data = (await compApi(env, "glc_user1", "GET", "/api/comp")) as Echo;
    expect(data.echo.headers["x-api-key"]).toBe("glc_user1");
    expect(data.echo.method).toBe("GET");
    expect(data.echo.pathname).toBe("/api/comp");
  });

  test("omits x-api-key when called anonymously", async () => {
    const data = (await compApi(env, null, "GET", "/api/comp")) as Echo;
    expect(data.echo.headers["x-api-key"]).toBeUndefined();
  });

  test("never forges the legacy internal-user header (SEC-10 regression)", async () => {
    // Whether authenticated or anonymous, the helper must never set
    // X-Glidecomp-Internal-User. The trust path it once enabled is gone.
    const auth = (await compApi(env, "glc_user1", "GET", "/api/comp")) as Echo;
    const anon = (await compApi(env, null, "GET", "/api/comp")) as Echo;
    expect(auth.echo.headers["x-glidecomp-internal-user"]).toBeUndefined();
    expect(anon.echo.headers["x-glidecomp-internal-user"]).toBeUndefined();
  });

  test("sends Content-Type: application/json when a body is provided", async () => {
    const data = (await compApi(
      env,
      "glc_user1",
      "POST",
      "/api/comp",
      { name: "Test Comp", category: "hg" }
    )) as Echo;
    expect(data.echo.headers["content-type"]).toBe("application/json");
    expect(data.echo.body).toBe('{"name":"Test Comp","category":"hg"}');
  });

  test("omits Content-Type when no body is provided", async () => {
    const data = (await compApi(env, "glc_user1", "DELETE", "/api/comp/abc")) as Echo;
    expect(data.echo.headers["content-type"]).toBeUndefined();
    expect(data.echo.body).toBe("");
  });

  test("throws with the upstream error message on non-2xx", async () => {
    // The mock returns 403 with { error: "Forbidden" } for this path.
    await expect(
      compApi(env, "glc_user1", "GET", "/api/comp/__force-error")
    ).rejects.toThrow("Forbidden");
  });
});

describe("compApiRaw (binary passthrough)", () => {
  test("forwards apiKey as x-api-key and returns the Response as-is", async () => {
    const res = await compApiRaw(env, "glc_user1", "GET", "/api/comp/x/igc/y/download");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Echo;
    expect(data.echo.headers["x-api-key"]).toBe("glc_user1");
  });

  test("merges extraHeaders without dropping x-api-key", async () => {
    const res = await compApiRaw(
      env,
      "glc_user1",
      "GET",
      "/api/comp/x/igc/y/download",
      undefined,
      { Accept: "application/octet-stream" }
    );
    const data = (await res.json()) as Echo;
    expect(data.echo.headers["x-api-key"]).toBe("glc_user1");
    expect(data.echo.headers["accept"]).toBe("application/octet-stream");
  });
});
