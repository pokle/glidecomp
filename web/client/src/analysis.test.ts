import { describe, expect, it } from "bun:test";
import type { CompAnalysisReport, CompMetricAggregate, MetricReport } from "@glidecomp/engine";
import {
  compAnalysisRows,
  consistencyWords,
  rankMetrics,
  reportCellText,
  rhoText,
  winningLabel,
} from "./analysis";

const metric = (id: string, absRho: number | null, outcome = false): MetricReport =>
  ({
    id,
    label: id,
    unit: "pct",
    family: "climbing",
    direction: "higher",
    explanation: "",
    perPilot: [],
    ...(outcome ? { outcome: true } : {}),
    correlation: absRho === null ? null : { metricId: id, rho: -absRho, absRho, n: 30, verdict: "strong" },
  }) as MetricReport;

describe("reading a task analysis", () => {
  it("ranks behaviours by |ρ|, leaving out outcome checks and uncorrelated ones", () => {
    expect(rankMetrics([metric("a", 0.2), metric("b", 0.6), metric("c", 0.9, true), metric("d", null)]).map((r) => r.metric.id)).toEqual(["b", "a"]);
  });

  it("names a behaviour by the side that won", () => {
    const m = { label: "Gaggle time", winning: { more: "More time in gaggles", less: "Less time in gaggles" } };
    expect(winningLabel(m, -0.5)).toBe("More time in gaggles");
    expect(winningLabel(m, 0.5)).toBe("Less time in gaggles");
    expect(winningLabel({ label: "Plain" }, -0.5)).toBe("Plain");
  });

  it("prints a coefficient with a real minus sign, and cells in the comp's zone", () => {
    expect(rhoText(-0.6234)).toBe("ρ −0.62");
    expect(rhoText(0.1)).toBe("ρ 0.10");
    expect(reportCellText("text", null)).toBe("text");
    expect(reportCellText({ t: "2026-01-14T02:00:00Z" }, "Australia/Sydney")).toBe("13:00 AEDT");
  });
});

describe("reading a competition analysis", () => {
  const agg = (id: string, mean: number | null, opts: Partial<CompMetricAggregate> = {}): CompMetricAggregate =>
    ({
      id,
      label: id,
      unit: "pct",
      direction: "higher",
      perTaskRho: mean === null ? [null] : [mean],
      perTaskCorrelation: [],
      meanAbsRho: mean === null ? null : Math.abs(mean),
      meanSignedRho: mean,
      signSummary: { negative: 1, positive: 0, quiet: 0 },
      consistency: "consistent",
      compRho: null,
      ...opts,
    }) as CompMetricAggregate;

  it("leads with consistent separation, and sets outcome checks and day metrics apart", () => {
    const rows = compAnalysisRows({
      taskLabels: ["T1"],
      pilots: [],
      metrics: [agg("weak", -0.1), agg("strong", 0.7), agg("check", -0.9, { outcome: true }), agg("day", null)],
    } as unknown as CompAnalysisReport);
    expect(rows.ranked.map((m) => m.id)).toEqual(["strong", "weak"]);
    expect(rows.outcomes.map((m) => m.id)).toEqual(["check"]);
    expect(rows.uncorrelated.map((m) => m.id)).toEqual(["day"]);
  });

  it("says how few tasks a quiet verdict rests on", () => {
    expect(consistencyWords("quiet", 0)).toBe("no clear task");
    expect(consistencyWords("quiet", 1)).toBe("one clear task only");
    expect(consistencyWords("split", 3)).toBe("depended on the day");
  });
});
