import { describe, test, expect, vi } from "vitest";
import { retry } from "./retry";

describe("retry", () => {
  test("returns the value on first success (no retries)", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await retry(fn, { attempts: 3, delayMs: 0 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries then succeeds on a transient failure", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    });
    expect(await retry(fn, { attempts: 3, delayMs: 0 })).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("rethrows the last error after exhausting attempts", async () => {
    const fn = vi.fn(async () => {
      throw new Error("still broken");
    });
    await expect(retry(fn, { attempts: 3, delayMs: 0 })).rejects.toThrow("still broken");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
