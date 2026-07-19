import { describe, expect, it } from "vitest";
import {
  extent,
  formatTickValue,
  linearScale,
  niceTicks,
  quantileSorted,
  spreadLabels,
} from "./chart-utils";

describe("formatTickValue", () => {
  it("suffixes percentages without a space", () => {
    expect(formatTickValue("pct", 50)).toBe("50%");
    expect(formatTickValue("pct", 0)).toBe("0%");
  });
  it("suffixes dimensional units with a space", () => {
    expect(formatTickValue("km/h", 60)).toBe("60 km/h");
    expect(formatTickValue("m/s", 2.1)).toBe("2.1 m/s");
    expect(formatTickValue("s", 30)).toBe("30 s");
    expect(formatTickValue("m", 800)).toBe("800 m");
  });
  it("keeps minutes as 'min', never 'm' (metres)", () => {
    expect(formatTickValue("min", 5)).toBe("5 min");
  });
  it("leaves unitless values bare", () => {
    expect(formatTickValue("count", 3)).toBe("3");
    expect(formatTickValue("ratio", 1.25)).toBe("1.25");
  });
  it("trims only all-zero decimals", () => {
    expect(formatTickValue("ratio", 1.5)).toBe("1.50");
    expect(formatTickValue("km/h", 2.5)).toBe("2.5 km/h");
  });
});

describe("extent", () => {
  it("finds min and max", () => {
    expect(extent([3, -1, 7, 2])).toEqual([-1, 7]);
  });
  it("ignores non-finite values", () => {
    expect(extent([NaN, 2, Infinity, 5])).toEqual([2, 5]);
  });
  it("returns null for no finite values", () => {
    expect(extent([])).toBeNull();
    expect(extent([NaN])).toBeNull();
  });
  it("handles a single value", () => {
    expect(extent([4])).toEqual([4, 4]);
  });
});

describe("linearScale", () => {
  it("maps domain endpoints to range endpoints", () => {
    const s = linearScale([0, 10], [0, 100]);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
    expect(s(5)).toBe(50);
  });
  it("supports an inverted range (rank 1 at the top)", () => {
    const s = linearScale([1, 40], [0, 300]);
    expect(s(1)).toBe(0);
    expect(s(40)).toBe(300);
  });
  it("maps a degenerate domain to the range midpoint", () => {
    const s = linearScale([5, 5], [0, 100]);
    expect(s(5)).toBe(50);
    expect(s(999)).toBe(50);
  });
});

describe("niceTicks", () => {
  it("produces round steps inside the domain", () => {
    expect(niceTicks([0, 10], 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });
  it("handles negative-spanning domains (rho)", () => {
    const ticks = niceTicks([-1, 1], 4);
    expect(ticks).toEqual([-1, -0.5, 0, 0.5, 1]);
  });
  it("never emits a tick outside the domain", () => {
    const ticks = niceTicks([0.3, 9.7], 5);
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(0.3);
    expect(Math.max(...ticks)).toBeLessThanOrEqual(9.7);
  });
  it("snaps float accumulation to the grid", () => {
    // 0.1 + 0.2 style error must not leak into tick values.
    for (const t of niceTicks([0, 0.7], 7)) {
      expect(t).toBe(Math.round(t * 10) / 10);
    }
  });
  it("degenerate domain yields the single value", () => {
    expect(niceTicks([3, 3])).toEqual([3]);
  });
});

describe("spreadLabels", () => {
  it("leaves already-separated labels alone", () => {
    expect(spreadLabels([10, 50, 90], 11, 0, 100)).toEqual([10, 50, 90]);
  });
  it("pushes colliding labels apart to minGap", () => {
    const out = spreadLabels([20, 22, 24], 11, 0, 300);
    expect(out[0]).toBe(20);
    expect(out[1] - out[0]).toBeGreaterThanOrEqual(11);
    expect(out[2] - out[1]).toBeGreaterThanOrEqual(11);
  });
  it("respects the upper bound by pushing the cluster up", () => {
    const out = spreadLabels([95, 97, 99], 11, 0, 100);
    expect(Math.max(...out)).toBeLessThanOrEqual(100);
    expect(out[1] - out[0]).toBeGreaterThanOrEqual(11);
    expect(out[2] - out[1]).toBeGreaterThanOrEqual(11);
  });
  it("preserves input order, not sorted order", () => {
    const out = spreadLabels([90, 10], 11, 0, 100);
    expect(out).toEqual([90, 10]);
  });
  it("clamps to the lower bound when there is no room above", () => {
    const out = spreadLabels([1, 2], 11, 0, 100);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    expect(out[1] - out[0]).toBeGreaterThanOrEqual(11);
  });
  it("handles empty and single inputs", () => {
    expect(spreadLabels([], 11, 0, 100)).toEqual([]);
    expect(spreadLabels([50], 11, 0, 100)).toEqual([50]);
  });
});

describe("quantileSorted", () => {
  it("interpolates the median of an even-length array", () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
  it("returns exact elements at p=0 and p=1", () => {
    expect(quantileSorted([1, 5, 9], 0)).toBe(1);
    expect(quantileSorted([1, 5, 9], 1)).toBe(9);
  });
  it("single element is every quantile", () => {
    expect(quantileSorted([7], 0.25)).toBe(7);
  });
  it("empty input is NaN", () => {
    expect(quantileSorted([], 0.5)).toBeNaN();
  });
});
