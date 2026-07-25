import { describe, expect, it } from "vitest";
import {
  directionAdjustedPercentile,
  extent,
  formatTickValue,
  linearScale,
  loessTrend,
  niceTicks,
  percentileRank,
  quantileSorted,
  spreadLabels,
} from "./chart-utils";

describe("percentileRank", () => {
  it("ranks by share of field below, midrank for ties", () => {
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(87.5);
    expect(percentileRank([1, 2, 3, 4], 1)).toBe(12.5);
    expect(percentileRank([1, 2, 2, 4], 2)).toBe(50);
  });
  it("a lone value is the 50th percentile", () => {
    expect(percentileRank([7], 7)).toBe(50);
  });
  it("empty field is NaN", () => {
    expect(percentileRank([], 5)).toBeNaN();
  });
});

describe("directionAdjustedPercentile", () => {
  const field = [1, 2, 3, 4];
  it("keeps higher-is-better as-is", () => {
    expect(directionAdjustedPercentile("higher", field, 4)).toBe(87.5);
  });
  it("inverts lower-is-better so 100 = best", () => {
    expect(directionAdjustedPercentile("lower", field, 1)).toBe(87.5);
  });
  it("leaves neutral raw — position, not quality", () => {
    expect(directionAdjustedPercentile("neutral", field, 4)).toBe(87.5);
    expect(directionAdjustedPercentile("neutral", field, 1)).toBe(12.5);
  });
});

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
  it("suffixes the preferred-unit display tokens", () => {
    expect(formatTickValue("mph", 37.3)).toBe("37.3 mph");
    expect(formatTickValue("kts", 32.4)).toBe("32.4 kts");
    expect(formatTickValue("fpm", 400)).toBe("400 fpm");
    expect(formatTickValue("ft", 2600)).toBe("2600 ft");
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

describe("loessTrend", () => {
  /** 0, 1, … n−1 */
  const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("recovers a straight line", () => {
    const xs = seq(30);
    const ys = xs.map((x) => 3 * x + 5);
    const fit = loessTrend(xs, ys)!;
    expect(fit).not.toBeNull();
    for (const p of fit) expect(p.y).toBeCloseTo(3 * p.x + 5, 6);
  });

  it("spans exactly the data's x range, in ascending order", () => {
    const xs = [4, 1, 9, 7, 2, 6, 3, 8];
    const fit = loessTrend(xs, xs.map((x) => x * 2))!;
    expect(fit[0].x).toBe(1);
    expect(fit[fit.length - 1].x).toBe(9);
    for (let i = 1; i < fit.length; i++) expect(fit[i].x).toBeGreaterThan(fit[i - 1].x);
  });

  it("follows a curve instead of straightening it", () => {
    // A U-shape: a least-squares line through this is flat and says
    // "no relationship"; the local fit has to bend.
    const xs = seq(41).map((i) => i - 20);
    const fit = loessTrend(xs, xs.map((x) => x * x))!;
    const at = (x: number) => fit.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    expect(at(0).y).toBeLessThan(at(-20).y / 2);
    expect(at(0).y).toBeLessThan(at(20).y / 2);
  });

  it("is not levered by a lone outlier", () => {
    // One pilot 100× off the trend must bend the curve near itself, not tilt
    // the whole line — the case a plain regression gets wrong.
    const xs = seq(30);
    const clean = loessTrend(xs, xs.map((x) => 2 * x))!;
    const ys = xs.map((x) => (x === 15 ? 2000 : 2 * x));
    const dirty = loessTrend(xs, ys)!;
    expect(dirty[0].y).toBeCloseTo(clean[0].y, 1);
    expect(dirty[dirty.length - 1].y).toBeCloseTo(clean[clean.length - 1].y, 1);
  });

  it("tracks a monotone trend downward as x rises", () => {
    // The chart's own shape: better metric value → numerically better rank.
    const xs = seq(24);
    const fit = loessTrend(xs, xs.map((x) => 40 - 1.5 * x))!;
    expect(fit[0].y).toBeGreaterThan(fit[fit.length - 1].y);
  });

  it("returns null when there is nothing to fit", () => {
    expect(loessTrend([1, 2, 3], [1, 2, 3])).toBeNull(); // too few pairs
    expect(loessTrend([5, 5, 5, 5, 5], [1, 2, 3, 4, 5])).toBeNull(); // no x spread
    expect(loessTrend([], [])).toBeNull();
  });

  it("ignores non-finite pairs rather than poisoning the fit", () => {
    const xs = [0, 1, 2, NaN, 3, 4, 5];
    const ys = [0, 2, 4, 99, 6, Infinity, 10];
    const fit = loessTrend(xs, ys)!;
    expect(fit).not.toBeNull();
    for (const p of fit) expect(Number.isFinite(p.y)).toBe(true);
    expect(fit[fit.length - 1].y).toBeCloseTo(10, 6);
  });

  it("survives duplicated x values", () => {
    const xs = [0, 0, 0, 1, 1, 2, 2, 2, 3];
    const fit = loessTrend(xs, xs.map((x) => x * 4))!;
    for (const p of fit) expect(Number.isFinite(p.y)).toBe(true);
  });

  it("samples a discrete metric only at the values it can take", () => {
    // Count metrics (0, 1, 2, 3 thermals) sampled on an even grid draw a
    // plateau and a wall between the integers, implying values that cannot
    // exist. Sampled at the observed values it is one segment per gap.
    const xs = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3];
    const fit = loessTrend(xs, [30, 28, 25, 22, 15, 13, 11, 6, 5, 2])!;
    expect(fit.map((p) => p.x)).toEqual([0, 1, 2, 3]);
  });

  it("falls back to an even grid when observations outnumber it", () => {
    const xs = seq(200);
    const fit = loessTrend(xs, xs.map((x) => -x), { steps: 20 })!;
    expect(fit).toHaveLength(21);
    expect(fit[0].x).toBe(0);
    expect(fit[fit.length - 1].x).toBe(199);
  });
});
