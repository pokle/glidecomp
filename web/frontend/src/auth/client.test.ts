/**
 * Issue #481 — getCurrentUser() must not report a failed question as an
 * answer.
 *
 * It runs once per page load and everything downstream keys off it, so a
 * single dropped request or 5xx used to render the whole app permanently
 * signed out: header, comp admin controls, the lot, with no retry and no
 * recovery short of a reload.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { getCurrentUser, needsOnboarding, ACCOUNT_HINT_KEY } from "./client";

const USER = {
  id: "u1",
  name: "Test Pilot",
  email: "pilot@test.com",
  image: null,
  username: "testpilot",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Run `p` to completion, letting the retry backoff timers fire. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("getCurrentUser", () => {
  test("returns the user on a clean first answer", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: USER }));
    expect(await settle(getCurrentUser())).toEqual(USER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a dropped request is retried, not read as signed out", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ user: USER }));

    expect(await settle(getCurrentUser())).toEqual(USER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a 5xx is retried, not read as signed out", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500))
      .mockResolvedValueOnce(jsonResponse({ user: USER }));

    expect(await settle(getCurrentUser())).toEqual(USER);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("a real 'nobody is signed in' answer is taken at face value", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: null }));

    expect(await settle(getCurrentUser())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a 4xx is a real answer and is not retried", async () => {
    // /api/auth/me answers 429 for a rate-limited API key. Retrying would
    // both lie about the limit and push the caller further past it.
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: null }, 429));

    expect(await settle(getCurrentUser())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("gives up after its attempts and renders signed out", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    expect(await settle(getCurrentUser())).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("a failed round trip leaves the account hint alone", async () => {
    // The hint is what the static Astro chrome renders from. Clearing it on a
    // blip would flip those pages to "Sign in" for an account that is fine.
    localStorage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name: "Test Pilot" }));
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await settle(getCurrentUser());
    expect(localStorage.getItem(ACCOUNT_HINT_KEY)).not.toBeNull();
  });

  test("a real sign-out does clear the account hint", async () => {
    localStorage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name: "Test Pilot" }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: null }));

    await settle(getCurrentUser());
    expect(localStorage.getItem(ACCOUNT_HINT_KEY)).toBeNull();
  });
});

/**
 * The onboarding gate. Both halves are load-bearing, and each is the only
 * signal for a different sign-up path — a username-only gate let every
 * email-OTP account through nameless, because the username is auto-derived
 * at sign-up and the display name is not.
 */
describe("needsOnboarding", () => {
  test("a fully set-up account is done", () => {
    expect(needsOnboarding(USER)).toBe(false);
  });

  test("no username (a pre-#349 account) still needs onboarding", () => {
    expect(needsOnboarding({ ...USER, username: null })).toBe(true);
  });

  test("an email-OTP sign-up — derived username, no name — needs onboarding", () => {
    // What Better Auth's email-otp route creates: name "", plus the username
    // our user.create hook derives from the email local-part.
    expect(needsOnboarding({ ...USER, name: "", username: "pilot" })).toBe(true);
  });

  test("a whitespace-only name is no name", () => {
    expect(needsOnboarding({ ...USER, name: "   " })).toBe(true);
  });
});
