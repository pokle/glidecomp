/**
 * Issue #481 — fetchWithRetry is the last thing between a transient API
 * failure and a page that says "Competition not found".
 *
 * Every caller wraps it in a try/catch that renders exactly that, so a
 * *dropped* request (a rejected promise, not a bad status) used to be
 * reported to the user as a missing competition — and stayed that way, since
 * nothing re-fetches.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchWithRetry } from "./types";

interface FakeRes {
  ok: boolean;
  status: number;
}

const ok: FakeRes = { ok: true, status: 200 };
const notFound: FakeRes = { ok: false, status: 404 };
const serverError: FakeRes = { ok: false, status: 500 };
const badRequest: FakeRes = { ok: false, status: 400 };
const unauthorized: FakeRes = { ok: false, status: 401 };
const forbidden: FakeRes = { ok: false, status: 403 };
const rateLimited: FakeRes = { ok: false, status: 429 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Run `p` to completion, letting the retry backoff timers fire. The bare
 * `.catch` marks the promise handled while the timers run, so a test that
 * asserts on a rejection doesn't also trip the unhandled-rejection reporter.
 */
function settle<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return vi.runAllTimersAsync().then(() => p);
}

describe("fetchWithRetry", () => {
  test("passes a good response straight through", async () => {
    const fetcher = vi.fn<() => Promise<FakeRes>>().mockResolvedValue(ok);
    expect(await settle(fetchWithRetry(fetcher))).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("a 404 is a real answer and is not retried", async () => {
    const fetcher = vi.fn<() => Promise<FakeRes>>().mockResolvedValue(notFound);
    expect(await settle(fetchWithRetry(fetcher))).toBe(notFound);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // 404 was once the ONLY 4xx spared. The rest cost three round trips and two
  // delays to arrive at the same verdict — and for the rate-limited case, the
  // retries pushed the caller further past the limit they had just hit.
  test.each([
    ["400", badRequest],
    ["401", unauthorized],
    ["403", forbidden],
    ["429", rateLimited],
  ])("a %s is a real answer and is not retried", async (_label, res) => {
    const fetcher = vi.fn<() => Promise<FakeRes>>().mockResolvedValue(res);
    expect(await settle(fetchWithRetry(fetcher))).toBe(res);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("retries a 5xx until it succeeds", async () => {
    const fetcher = vi
      .fn<() => Promise<FakeRes>>()
      .mockResolvedValueOnce(serverError)
      .mockResolvedValueOnce(serverError)
      .mockResolvedValueOnce(ok);
    expect(await settle(fetchWithRetry(fetcher))).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("retries a dropped request rather than letting it escape", async () => {
    const fetcher = vi
      .fn<() => Promise<FakeRes>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok);
    expect(await settle(fetchWithRetry(fetcher))).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("mixes both failure kinds and still recovers", async () => {
    const fetcher = vi
      .fn<() => Promise<FakeRes>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(serverError)
      .mockResolvedValueOnce(ok);
    expect(await settle(fetchWithRetry(fetcher))).toBe(ok);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("hands back the last real response when the API stays broken", async () => {
    // Callers read `.status`, so a persistent 500 must surface as a response
    // rather than a throw.
    const fetcher = vi.fn<() => Promise<FakeRes>>().mockResolvedValue(serverError);
    expect(await settle(fetchWithRetry(fetcher))).toBe(serverError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("re-raises when every attempt was dropped", async () => {
    const err = new TypeError("Failed to fetch");
    const fetcher = vi.fn<() => Promise<FakeRes>>().mockRejectedValue(err);
    await expect(settle(fetchWithRetry(fetcher))).rejects.toBe(err);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test("prefers a real response over an earlier dropped attempt", async () => {
    const fetcher = vi
      .fn<() => Promise<FakeRes>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(serverError);
    expect(await settle(fetchWithRetry(fetcher))).toBe(serverError);
  });
});
