import { describe, expect, it } from "vitest";
import { LIBRARY_LIMITS, storageUsage } from "./account";

describe("storageUsage", () => {
  it("states the byte allowance, and the counts only near their limits", () => {
    expect(storageUsage(3.2 * 1024 * 1024, 4, 1).summary).toBe("3.2 of 200 MB");
    expect(storageUsage(50 * 1024 * 1024, 450, 1).summary).toBe("50 of 200 MB · 450 of 500 tracks");
  });

  it("is as full as the fullest allowance", () => {
    expect(storageUsage(LIBRARY_LIMITS.bytes / 2, 0, 190).fraction).toBeCloseTo(0.95);
  });
});
