/**
 * The sign-in page's "Last used" pill must reflect a SUCCESSFUL sign-in:
 * a Google attempt the pilot cancelled must not relabel the page.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  confirmPendingSignIn,
  markPendingSignIn,
  readLastSignInMethod,
  writeLastSignInMethod,
  LAST_SIGN_IN_KEY,
  PENDING_SIGN_IN_KEY,
} from "./last-sign-in";
import { getCurrentUser } from "./client";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("last sign-in method", () => {
  test("nothing recorded reads as null", () => {
    expect(readLastSignInMethod()).toBeNull();
  });

  test("an unknown stored value reads as null", () => {
    localStorage.setItem(LAST_SIGN_IN_KEY, "carrier-pigeon");
    expect(readLastSignInMethod()).toBeNull();
  });

  test("a direct write is read back", () => {
    writeLastSignInMethod("email");
    expect(readLastSignInMethod()).toBe("email");
  });

  test("a pending attempt changes nothing until confirmed", () => {
    writeLastSignInMethod("email");
    markPendingSignIn("google");
    expect(readLastSignInMethod()).toBe("email");
    confirmPendingSignIn();
    expect(readLastSignInMethod()).toBe("google");
    expect(sessionStorage.getItem(PENDING_SIGN_IN_KEY)).toBeNull();
  });

  test("confirming with nothing pending leaves the record alone", () => {
    writeLastSignInMethod("email");
    confirmPendingSignIn();
    expect(readLastSignInMethod()).toBe("email");
  });
});

describe("getCurrentUser promotes a pending sign-in", () => {
  function mockMe(user: unknown) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user }),
    } as Response) as unknown as typeof fetch;
  }

  test("signed in: the pending Google attempt becomes last used", async () => {
    markPendingSignIn("google");
    mockMe({ id: "u1", name: "Pilot", email: "p@test.com" });
    await getCurrentUser();
    expect(readLastSignInMethod()).toBe("google");
  });

  test("signed out (cancelled OAuth): nothing is promoted", async () => {
    writeLastSignInMethod("email");
    markPendingSignIn("google");
    mockMe(null);
    await getCurrentUser();
    expect(readLastSignInMethod()).toBe("email");
  });
});
