/**
 * Unit tests for PreferencesSync.
 *
 * Strategy: instantiate fresh PreferencesSync per test, stub global fetch,
 * use jsdom's real localStorage. Auto-bootstrap is gated off in test mode
 * (see preferences-sync.ts), so the module is quiet on import.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { PreferencesSync } from "./preferences-sync";
import type { AuthUser } from "./client";

const USER: AuthUser = {
  id: "u1",
  name: "Test User",
  email: "u@test.com",
  image: null,
  username: "test",
};

const STORAGE_KEY_PREFS = "glidecomp:preferences";

const SAMPLE_PREFS = {
  units: { speed: "mph", altitude: "ft", distance: "mi", climbRate: "ft/min" },
  theme: "dark",
};
const ALT_PREFS = { units: { speed: "knots" } };


type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

let fetchMock: FetchMock;
let sync: PreferencesSync;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  sync = new PreferencesSync();
});

afterEach(() => {
  sync.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── hydrate ─────────────────────────────────────────────────────────────────

describe("hydrate", () => {
  test("anonymous user: no fetch, no localStorage writes", async () => {
    await sync.hydrate(null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY_PREFS)).toBeNull();
  });

  test("cloud empty + local empty: GET only, no PUT", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ prefs: {}, theme: null, updated_at: null })
    );

    await sync.hydrate(USER);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/preferences",
      expect.objectContaining({ credentials: "include" })
    );
    expect(localStorage.getItem(STORAGE_KEY_PREFS)).toBeNull();
  });

  test("cloud empty + local has prefs: uploads local as one-time migration", async () => {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ prefs: {}, theme: null, updated_at: null })
      )
      .mockResolvedValueOnce(jsonResponse({ updated_at: "2026-05-10T00:00:00Z" }));

    await sync.hydrate(USER);
    // Let the fire-and-forget put() resolve
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const putCall = fetchMock.mock.calls[1];
    expect(putCall[1].method).toBe("PUT");
    const body = JSON.parse(putCall[1].body);
    expect(body.prefs).toEqual(SAMPLE_PREFS);
    expect(body.theme).toBeUndefined();
    // localStorage unchanged — local was the source
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS)!)).toEqual(
      SAMPLE_PREFS
    );
  });

  test("cloud has prefs + local empty: cloud written to localStorage, event fires", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ prefs: SAMPLE_PREFS, theme: null, updated_at: "now" })
    );
    const events: unknown[] = [];
    window.addEventListener("glidecomp:preferences-changed", (e) =>
      events.push((e as CustomEvent).detail)
    );

    await sync.hydrate(USER);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS)!)).toEqual(
      SAMPLE_PREFS
    );
    expect(events.length).toBe(1);
  });

  test("cloud has prefs + local has different prefs: cloud wins", async () => {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(ALT_PREFS));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ prefs: SAMPLE_PREFS, theme: null, updated_at: "now" })
    );

    await sync.hydrate(USER);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS)!)).toEqual(
      SAMPLE_PREFS
    );
    // Should NOT have made a PUT (cloud already had data)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("legacy cloud theme field is ignored", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ prefs: {}, theme: { name: "Old" }, updated_at: "now" })
    );

    await sync.hydrate(USER);
    await flushMicrotasks();

    // The retired theme system's cloud data is neither stored nor uploaded
    expect(localStorage.getItem("glidecomp:theme")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("GET network error: stays local-only, no writes", async () => {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(ALT_PREFS));
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await sync.hydrate(USER);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS)!)).toEqual(
      ALT_PREFS
    );
  });

  test("GET 401: stays local-only, no PUT attempted", async () => {
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));

    await sync.hydrate(USER);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS)!)).toEqual(
      SAMPLE_PREFS
    );
  });

  test("strips mapLocation when uploading local-only prefs to cloud", async () => {
    const localWithMap = {
      ...SAMPLE_PREFS,
      mapLocation: { center: [10, 20], zoom: 12, pitch: 0, bearing: 0 },
    };
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(localWithMap));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ prefs: {}, theme: null, updated_at: null })
      )
      .mockResolvedValueOnce(jsonResponse({ updated_at: "now" }));

    await sync.hydrate(USER);
    await flushMicrotasks();

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.prefs).toEqual(SAMPLE_PREFS);
    expect(body.prefs.mapLocation).toBeUndefined();
  });

  test("preserves local mapLocation when cloud prefs win", async () => {
    const localMap = { center: [10, 20], zoom: 12, pitch: 0, bearing: 0 };
    localStorage.setItem(
      STORAGE_KEY_PREFS,
      JSON.stringify({ ...ALT_PREFS, mapLocation: localMap })
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ prefs: SAMPLE_PREFS, theme: null, updated_at: "now" })
    );

    await sync.hydrate(USER);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_PREFS)!);
    expect(stored.units).toEqual(SAMPLE_PREFS.units);
    expect(stored.mapLocation).toEqual(localMap);
  });

});

// ── schedulePush ────────────────────────────────────────────────────────────

describe("schedulePush", () => {
  test("no-op when user is null", () => {
    vi.useFakeTimers();
    sync.schedulePush();
    vi.advanceTimersByTime(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("debounces: rapid calls produce a single PUT", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock.mockResolvedValue(jsonResponse({ updated_at: "now" }));

    vi.useFakeTimers();
    sync.schedulePush();
    sync.schedulePush();
    sync.schedulePush();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
  });

  test("pushes prefs from current localStorage at flush time, not schedule time", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock.mockResolvedValue(jsonResponse({ updated_at: "now" }));

    vi.useFakeTimers();
    sync.schedulePush();
    // Mutate localStorage AFTER scheduling but BEFORE flush
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(ALT_PREFS));
    await vi.advanceTimersByTimeAsync(2000);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prefs).toEqual(ALT_PREFS);
  });

  test("schedulePush() skips PUT when only mapLocation changed", async () => {
    await primeSignedIn();
    // localStorage has only mapLocation — nothing else worth syncing
    localStorage.setItem(
      STORAGE_KEY_PREFS,
      JSON.stringify({ mapLocation: { center: [0, 0], zoom: 5, pitch: 0, bearing: 0 } })
    );
    fetchMock.mockResolvedValue(jsonResponse({ updated_at: "now" }));

    vi.useFakeTimers();
    sync.schedulePush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("schedulePush() strips mapLocation but PUTs other fields", async () => {
    await primeSignedIn();
    localStorage.setItem(
      STORAGE_KEY_PREFS,
      JSON.stringify({
        ...SAMPLE_PREFS,
        mapLocation: { center: [0, 0], zoom: 5, pitch: 0, bearing: 0 },
      })
    );
    fetchMock.mockResolvedValue(jsonResponse({ updated_at: "now" }));

    vi.useFakeTimers();
    sync.schedulePush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prefs.mapLocation).toBeUndefined();
    expect(body.prefs.units).toEqual(SAMPLE_PREFS.units);
  });

});

// ── put failure modes ──────────────────────────────────────────────────────

describe("put error handling", () => {
  test("401 disables further pushes for the session", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));

    vi.useFakeTimers();
    sync.schedulePush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Subsequent schedule should be ignored
    sync.schedulePush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("transient 500 retries up to 3 times, then gives up", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));

    vi.useFakeTimers();
    sync.schedulePush();
    await vi.advanceTimersByTimeAsync(2000); // debounce fires, attempt 0
    await vi.advanceTimersByTimeAsync(1000); // backoff for attempt 1
    await vi.advanceTimersByTimeAsync(2000); // backoff for attempt 2
    await vi.advanceTimersByTimeAsync(4000); // backoff for attempt 3

    // Initial + 3 retries = 4 total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("network error retries", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse({ updated_at: "now" }));

    vi.useFakeTimers();
    sync.schedulePush();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("uses keepalive: true on the PUT", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock.mockResolvedValue(jsonResponse({ updated_at: "now" }));

    vi.useFakeTimers();
    sync.schedulePush();
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
  });
});

// ── pagehide flush ──────────────────────────────────────────────────────────

describe("pagehide flush", () => {
  test("dispatching pagehide flushes pending prefs push immediately", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fetchMock.mockResolvedValue(jsonResponse({ updated_at: "now" }));

    vi.useFakeTimers();
    sync.schedulePush();
    expect(fetchMock).not.toHaveBeenCalled();

    // Fire pagehide BEFORE the 2s debounce elapses
    window.dispatchEvent(new Event("pagehide"));
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── cross-tab storage events ────────────────────────────────────────────────

describe("cross-tab storage event", () => {
  // jsdom's StorageEvent constructor rejects our polyfilled Storage (it's
  // not a real jsdom Storage instance). Build the event manually so we can
  // attach our shim as storageArea.
  function fireStorage(
    key: string | null,
    newValue: string | null,
    area: Storage = localStorage
  ): void {
    const ev = new Event("storage") as StorageEvent;
    Object.defineProperty(ev, "key", { value: key, configurable: true });
    Object.defineProperty(ev, "newValue", { value: newValue, configurable: true });
    Object.defineProperty(ev, "storageArea", { value: area, configurable: true });
    window.dispatchEvent(ev);
  }

  test("prefs storage event fires preferences-changed and refreshes cache", async () => {
    const events: unknown[] = [];
    window.addEventListener("glidecomp:preferences-changed", (e) =>
      events.push((e as CustomEvent).detail)
    );
    // Simulate another tab writing prefs directly into our localStorage
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fireStorage(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));

    await flushMicrotasks();

    expect(events.length).toBe(1);
    // The detail should be a merged UserPreferences with our units
    expect((events[0] as { units: unknown }).units).toEqual(SAMPLE_PREFS.units);
  });

  test("storage event for unrelated key is ignored", async () => {
    const events: unknown[] = [];
    window.addEventListener("glidecomp:preferences-changed", (e) =>
      events.push((e as CustomEvent).detail)
    );
    fireStorage("some-other-key", "irrelevant");

    await flushMicrotasks();

    expect(events.length).toBe(0);
  });

  test("storage event from sessionStorage is ignored", async () => {
    const events: unknown[] = [];
    window.addEventListener("glidecomp:preferences-changed", (e) =>
      events.push((e as CustomEvent).detail)
    );
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fireStorage(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS), sessionStorage);

    await flushMicrotasks();

    expect(events.length).toBe(0);
  });

  test("storage event does NOT trigger a cloud PUT (source tab handles that)", async () => {
    await primeSignedIn();
    localStorage.setItem(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));
    fireStorage(STORAGE_KEY_PREFS, JSON.stringify(SAMPLE_PREFS));

    await flushMicrotasks();
    // Some additional time in case any scheduled push slipped through
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Bring `sync` into a signed-in state. We do this by calling hydrate with a
 * cloud response that has nothing — which leaves user set on the instance
 * without writing anything else.
 */
async function primeSignedIn(): Promise<void> {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({ prefs: {}, theme: null, updated_at: null })
  );
  await sync.hydrate(USER);
  fetchMock.mockReset();
}

/**
 * Drain pending microtasks. Multiple awaits cover deep promise chains,
 * including the first resolution of a dynamic import (which can take a
 * handful of microtasks). Pure Promise-based — works under fake timers.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
