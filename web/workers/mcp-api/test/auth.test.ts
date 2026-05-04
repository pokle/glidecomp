import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { extractBearerToken, verifyApiKey } from "../src/auth";

describe("extractBearerToken", () => {
  test("returns the token after 'Bearer '", () => {
    const h = new Headers({ Authorization: "Bearer glc_user1" });
    expect(extractBearerToken(h)).toBe("glc_user1");
  });

  test("returns null when header is missing", () => {
    expect(extractBearerToken(new Headers())).toBeNull();
  });

  test("returns null for non-Bearer schemes", () => {
    const h = new Headers({ Authorization: "Basic abc" });
    expect(extractBearerToken(h)).toBeNull();
  });

  test("does not match a Bearer prefix without the trailing space", () => {
    // Strict prefix check — "Bearerfoo" must not be accepted as Bearer "foo"
    const h = new Headers({ Authorization: "Bearerglc_user1" });
    expect(extractBearerToken(h)).toBeNull();
  });
});

describe("verifyApiKey", () => {
  test("resolves a known key to its user", async () => {
    const user = await verifyApiKey(env, "glc_user1");
    expect(user).toMatchObject({ id: "user-1", name: "Test Pilot" });
  });

  test("returns null for an unknown key", async () => {
    const user = await verifyApiKey(env, "glc_unknown");
    expect(user).toBeNull();
  });
});
