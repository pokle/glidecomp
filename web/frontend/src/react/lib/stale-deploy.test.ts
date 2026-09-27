/**
 * Reloading a tab that outlived a deploy — once, and never in a loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isChunkLoadError, reloadForNewDeploy } from "./stale-deploy";

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://glidecomp.com/assets/Dashboard-a1b2.js",
    "error loading dynamically imported module: https://glidecomp.com/assets/Dashboard-a1b2.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/Settings-c3d4.css",
  ])("recognises %s", (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it("leaves every other error alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("reloadForNewDeploy", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reloads the first time", () => {
    const reload = vi.fn();
    expect(reloadForNewDeploy(reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload again straight after a reload, so it cannot loop", () => {
    const reload = vi.fn();
    reloadForNewDeploy(reload);
    vi.advanceTimersByTime(5_000);
    expect(reloadForNewDeploy(reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads again for a later deploy", () => {
    const reload = vi.fn();
    reloadForNewDeploy(reload);
    vi.advanceTimersByTime(60_000);
    expect(reloadForNewDeploy(reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when there is nowhere to record the attempt", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const reload = vi.fn();
    expect(reloadForNewDeploy(reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
