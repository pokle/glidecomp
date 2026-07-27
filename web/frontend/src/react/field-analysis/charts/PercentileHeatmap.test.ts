import { describe, expect, it } from "vitest";
import { heatmapColumns } from "./PercentileHeatmap";
import { orientedRho } from "./chart-utils";
import type { MetricReport, MetricCorrelation, MetricDirection } from "../types";

function metric(
  id: string,
  direction: MetricDirection,
  rho: number | null,
  extra: Partial<MetricReport> & { verdict?: MetricCorrelation["verdict"] } = {},
): MetricReport {
  const { verdict = "strong", ...rest } = extra;
  const correlation: MetricCorrelation | null =
    rho === null
      ? null
      : { metricId: id, rho, absRho: Math.abs(rho), n: 20, verdict };
  return {
    id,
    label: id,
    unit: "ratio",
    family: "racecraft",
    direction,
    explanation: "test",
    // One usable value is enough to survive the all-blank-column filter.
    perPilot: [{ trackFile: "a.igc", value: 1 }],
    correlation,
    ...rest,
  };
}

const ids = (metrics: MetricReport[]) => metrics.map((m) => m.id);

describe("orientedRho", () => {
  // Cells are direction-adjusted percentiles (100 = the metric's better end),
  // and ρ is signed against rank where rank 1 is best. So the sign that
  // predicts "dark at the top of this column" flips for every direction but
  // 'lower'.
  it("flips 'higher': ρ < 0 (more went with better ranks) is agreement", () => {
    expect(orientedRho(metric("m", "higher", -0.6))).toBeCloseTo(0.6);
    expect(orientedRho(metric("m", "higher", 0.6))).toBeCloseTo(-0.6);
  });
  it("keeps 'lower': ρ > 0 (less went with better ranks) is agreement", () => {
    expect(orientedRho(metric("m", "lower", 0.6))).toBeCloseTo(0.6);
    expect(orientedRho(metric("m", "lower", -0.6))).toBeCloseTo(-0.6);
  });
  it("treats 'neutral' like 'higher' — its raw percentile's high end is the high value", () => {
    expect(orientedRho(metric("m", "neutral", -0.6))).toBeCloseTo(0.6);
  });
  it("is 0 when the metric earned no coefficient", () => {
    expect(orientedRho(metric("m", "higher", null))).toBe(0);
  });
});

describe("heatmapColumns ordering", () => {
  it("runs from most-agreeing, through nothing, to most-counter-intuitive", () => {
    const { metrics } = heatmapColumns([
      metric("noise", "higher", 0.02),
      metric("against", "higher", 0.7),
      metric("agrees", "higher", -0.8),
      metric("agrees-a-bit", "lower", 0.4),
    ]);
    expect(ids(metrics)).toEqual(["agrees", "agrees-a-bit", "noise", "against"]);
  });

  it("puts metrics with no coefficient in the middle, with the noise", () => {
    const { metrics } = heatmapColumns([
      metric("against", "higher", 0.5),
      metric("nocorr", "higher", null),
      metric("agrees", "higher", -0.5),
    ]);
    expect(ids(metrics)).toEqual(["agrees", "nocorr", "against"]);
  });

  it("breaks ties on id, so SSR and the client agree", () => {
    // Same ρ, declared in the reverse of the order they must come out in.
    const input = [metric("b", "higher", -0.5), metric("a", "higher", -0.5)];
    expect(ids(heatmapColumns(input).metrics)).toEqual(["a", "b"]);
    expect(ids(heatmapColumns([...input].reverse()).metrics)).toEqual(["a", "b"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [metric("b", "higher", 0.5), metric("a", "higher", -0.5)];
    heatmapColumns(input);
    expect(ids(input)).toEqual(["b", "a"]);
  });
});

describe("heatmapColumns filtering", () => {
  it("drops outcome-derived metrics, which track rank by construction", () => {
    const { metrics } = heatmapColumns([
      metric("race.time_behind", "lower", 0.95, { outcome: true }),
      metric("behaviour", "higher", -0.4),
    ]);
    expect(ids(metrics)).toEqual(["behaviour"]);
  });

  it("drops columns with no usable value anywhere", () => {
    const { metrics } = heatmapColumns([
      metric("blank", "higher", -0.9, {
        perPilot: [
          { trackFile: "a.igc", value: null },
          { trackFile: "b.igc", value: null },
        ],
      }),
      metric("kept", "higher", -0.4),
    ]);
    expect(ids(metrics)).toEqual(["kept"]);
  });
});

describe("heatmapColumns bands", () => {
  it("spans runs of consecutive verdict and repeats one at both ends", () => {
    // Signed ordering ramps down into the noise and back out the other side,
    // so "clear pattern" legitimately appears twice — the bands are runs, not
    // a group-by, and each needs its own key.
    const { bands } = heatmapColumns([
      metric("agrees", "higher", -0.8, { verdict: "strong" }),
      metric("agrees-mid", "higher", -0.4, { verdict: "moderate" }),
      metric("noise-a", "higher", -0.02, { verdict: "within noise" }),
      metric("noise-b", "higher", 0.02, { verdict: "within noise" }),
      metric("against", "higher", 0.8, { verdict: "strong" }),
    ]);
    expect(bands.map((b) => [b.label, b.span])).toEqual([
      ["clear", 1],
      ["some", 1],
      ["noise", 2],
      ["clear", 1],
    ]);
    expect(new Set(bands.map((b) => b.key)).size).toBe(bands.length);
  });

  it("keeps the badges' full phrase as each band's title", () => {
    // A band is often one ~30px column, so the label is one word; the phrase
    // the ranking's badges use has to stay reachable.
    const { bands } = heatmapColumns([
      metric("noise", "higher", -0.02, { verdict: "within noise" }),
    ]);
    expect(bands.map((b) => [b.label, b.title])).toEqual([
      ["noise", "could be chance"],
    ]);
  });

  it("bands metrics with no coefficient apart", () => {
    const { bands } = heatmapColumns([
      metric("agrees", "higher", -0.8, { verdict: "strong" }),
      metric("nocorr", "higher", null),
    ]);
    expect(bands.map((b) => [b.label, b.title])).toEqual([
      ["clear", "clear pattern"],
      ["no reading", "no coefficient"],
    ]);
  });

  it("spans exactly the columns it returns", () => {
    const { metrics, bands } = heatmapColumns([
      metric("a", "higher", -0.8, { verdict: "strong" }),
      metric("b", "higher", -0.7, { verdict: "strong" }),
      metric("c", "higher", 0.1, { verdict: "within noise" }),
    ]);
    expect(bands.reduce((n, b) => n + b.span, 0)).toBe(metrics.length);
  });
});
