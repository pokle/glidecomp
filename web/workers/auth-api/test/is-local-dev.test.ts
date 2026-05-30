// Unit tests for isLocalDev — the gate that enables dev-login and
// email/password auth. Getting this wrong in production would expose a
// password-less signup + signin endpoint (SEC-07).
//
// We test the pure function directly rather than the full request flow
// because the full flow requires re-initialising the miniflare env, which
// would need a second vitest project.

import { describe, expect, test } from "vitest";
import { isLocalDev } from "../src/auth";

describe("isLocalDev (SEC-07)", () => {
  test.each([
    "http://localhost:8788",
    "http://localhost",
    "http://localhost:5173",
    "https://localhost:8788",
  ])("true for %s", (url) => {
    expect(isLocalDev({ BETTER_AUTH_URL: url })).toBe(true);
  });

  test.each([
    "https://glidecomp.com",
    "https://preview.glidecomp.pages.dev",
    "https://localhost.evil.example", // suffix attack
    "https://evil.example/localhost",
    "http://127.0.0.1:8788", // not "localhost" by hostname string
    "",
    "not-a-url",
  ])("false for %s", (url) => {
    expect(isLocalDev({ BETTER_AUTH_URL: url })).toBe(false);
  });
});
