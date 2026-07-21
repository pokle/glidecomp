import { describe, expect, it } from "vitest";
import { captionText } from "./RankScatter";
import type { MetricReport, MetricCorrelation, MetricDirection } from "../types";

function metric(direction: MetricDirection, rho: number | null): MetricReport {
  const correlation: MetricCorrelation | null =
    rho === null
      ? null
      : { metricId: "test.metric", rho, absRho: Math.abs(rho), n: 20, verdict: "strong" };
  return {
    id: "test.metric",
    label: "Test metric",
    unit: "ratio",
    family: "racecraft",
    direction,
    explanation: "test",
    perPilot: [],
    correlation,
  };
}

describe("captionText", () => {
  // The gathering sentence must follow the OBSERVED ρ sign. Rank 1 is at the
  // top and numerically smallest, so ρ < 0 means larger values went with
  // better ranks (dots gather right); ρ > 0 gathers left.
  it("higher-is-better running as expected (ρ < 0) gathers right", () => {
    expect(captionText(metric("higher", -0.6), 0)).toContain(
      "More is expected to be better here, and it was: top ranks gather to the right."
    );
  });
  it("lower-is-better running as expected (ρ > 0) gathers left", () => {
    expect(captionText(metric("lower", 0.6), 0)).toContain(
      "Less is expected to be better here, and it was: top ranks gather to the left."
    );
  });
  it("higher-is-better running AGAINST expectation says so and gathers left", () => {
    expect(captionText(metric("higher", 0.6), 0)).toContain(
      "More is expected to be better here, but this task ran the other way: top ranks gather to the left."
    );
  });
  it("lower-is-better running AGAINST expectation says so and gathers right", () => {
    // The real case that motivated this: race.start_delay (direction "lower")
    // on Bright Open 2025 T2 came out ρ = −0.75 over 85 pilots — later
    // starters won. The old prior-derived caption claimed the opposite side.
    expect(captionText(metric("lower", -0.75), 0)).toContain(
      "Less is expected to be better here, but this task ran the other way: top ranks gather to the right."
    );
  });
  it("a directional metric with ρ = 0 claims no lean, not a side", () => {
    const text = captionText(metric("higher", 0), 0);
    expect(text).toContain("no lean either way");
    expect(text).not.toContain("gather");
  });
  it("neutral metrics state the sign as the finding", () => {
    expect(captionText(metric("neutral", -0.4), 0)).toContain(
      "the sign is the finding: larger values went with better ranks here."
    );
    expect(captionText(metric("neutral", 0.4), 0)).toContain("worse ranks here");
  });
  it("no correlation reads as no trend", () => {
    expect(captionText(metric("higher", null), 0)).toContain(
      "Too few usable values for a correlation"
    );
  });
  it("excluded pilots are counted", () => {
    expect(captionText(metric("higher", -0.6), 2)).toContain(
      "2 pilots have no value and are not plotted."
    );
  });
});
