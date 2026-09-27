/**
 * The sign-in page's "Last used" pill. Only the sign-in actions write it; the
 * readers of "who is signed in" must stay free of it.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  parseSignInMethod,
  readLastSignInMethod,
  writeLastSignInMethod,
  LAST_SIGN_IN_KEY,
} from "./last-sign-in";
import { getCurrentUser, seedCurrentUser, signInWithGoogle } from "./client";

// better-auth's client is a Proxy that captures `fetch` when it is created, so
// neither a spy nor a fetch stub reaches it: stand the client itself in.
const social = vi.hoisted(() => vi.fn());
vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({ signIn: { social } }),
}));

beforeEach(() => {
  localStorage.clear();
  social.mockReset().mockResolvedValue({ data: null, error: null });
});

describe("last sign-in method", () => {
  test("nothing recorded reads as null", () => {
    expect(readLastSignInMethod()).toBeNull();
  });

  test("an unknown stored value reads as null", () => {
    localStorage.setItem(LAST_SIGN_IN_KEY, "carrier-pigeon");
    expect(readLastSignInMethod()).toBeNull();
  });

  test("a write is read back", () => {
    writeLastSignInMethod("email");
    expect(readLastSignInMethod()).toBe("email");
  });

  test("only known methods parse from a query param", () => {
    expect(parseSignInMethod("google")).toBe("google");
    expect(parseSignInMethod("email")).toBe("email");
    expect(parseSignInMethod("GOOGLE")).toBeNull();
    expect(parseSignInMethod(null)).toBeNull();
  });
});

describe("signInWithGoogle", () => {
  test("returns through /signin?via=google, carrying the destination", async () => {
    await signInWithGoogle("/comp/abc-1?task=2");
    const { callbackURL } = social.mock.calls[0][0] as { callbackURL: string };
    const url = new URL(callbackURL, "https://glidecomp.invalid");
    expect(url.pathname).toBe("/signin");
    expect(url.searchParams.get("via")).toBe("google");
    expect(url.searchParams.get("next")).toBe("/comp/abc-1?task=2");
  });

  test("records nothing when clicked — only a completed sign-in does", async () => {
    writeLastSignInMethod("email");
    await signInWithGoogle("/comp");
    expect(readLastSignInMethod()).toBe("email");
  });
});

describe("the readers of the current user don't touch it", () => {
  test("seedCurrentUser (the SSR'd pages)", () => {
    writeLastSignInMethod("email");
    seedCurrentUser({ id: "u1", name: "Pilot", email: "p@test.com" } as never);
    expect(readLastSignInMethod()).toBe("email");
  });

  test("getCurrentUser (/api/auth/me)", async () => {
    writeLastSignInMethod("email");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: "u1", name: "Pilot", email: "p@test.com" } }),
    } as Response) as unknown as typeof fetch;
    await getCurrentUser();
    expect(readLastSignInMethod()).toBe("email");
  });
});
