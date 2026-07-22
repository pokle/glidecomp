import { describe, expect, it } from "vitest";
import { captionText } from "./RankScatter";
import { notableExcludedRanks } from "../exclusions";
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
  it("names top-ranked pilots among the excluded", () => {
    // The Corryong 2026 T1 case: gaggle.departure_winrate null for the #1
    // and #2 ranked pilots — the winner stayed in every gaggle to the end,
    // so the ρ is computed over a subpopulation excluding him. The caption
    // must say so instead of leaving the absence silent.
    expect(captionText(metric("neutral", -0.63), 13, [1, 2])).toContain(
      "13 pilots have no value and are not plotted, including the #1 and #2 ranked pilots."
    );
    expect(captionText(metric("neutral", -0.63), 5, [1])).toContain(
      "including the #1 ranked pilot."
    );
    expect(captionText(metric("neutral", -0.63), 5, [1, 2, 3])).toContain(
      "including the #1, #2 and #3 ranked pilots."
    );
  });
});

describe("notableExcludedRanks", () => {
  const pilots = [
    { trackFile: "a.igc", pilotName: "A", rank: 1 },
    { trackFile: "b.igc", pilotName: "B", rank: 2 },
    { trackFile: "c.igc", pilotName: "C", rank: 3 },
    { trackFile: "d.igc", pilotName: "D", rank: 4 },
  ];
  it("returns top-3 ranks with no usable value, joined by trackFile", () => {
    const perPilot = [
      { trackFile: "b.igc", value: null },
      { trackFile: "a.igc", value: null },
      { trackFile: "c.igc", value: 5 },
      { trackFile: "d.igc", value: null },
    ];
    expect(notableExcludedRanks(pilots, perPilot)).toEqual([1, 2]);
  });
  it("empty when the top ranks all have values", () => {
    const perPilot = pilots.map((p) => ({ trackFile: p.trackFile, value: 1 }));
    expect(notableExcludedRanks(pilots, perPilot)).toEqual([]);
  });
});
