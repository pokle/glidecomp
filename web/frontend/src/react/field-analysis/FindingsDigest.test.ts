import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CorrelationVerdict } from "@glidecomp/engine";
import { FindingsDigest } from "./FindingsDigest";
import type { MetricReport } from "./types";

/** The smallest metric the digest can rank: a correlation and a label. */
function metric(
  id: string,
  absRho: number,
  verdict: CorrelationVerdict,
  extra: Partial<MetricReport> = {}
): MetricReport {
  return {
    id,
    label: `Metric ${id}`,
    unit: "s",
    family: "climbing",
    direction: "higher",
    explanation: "test metric",
    perPilot: [],
    correlation: {
      metricId: id,
      rho: -absRho,
      absRho,
      n: 30,
      verdict,
    },
    ...extra,
  };
}

function html(metrics: MetricReport[]): string {
  return renderToStaticMarkup(createElement(FindingsDigest, { metrics }));
}

describe("FindingsDigest", () => {
  it("shows the strongest behaviours, most separating first", () => {
    const out = html([
      metric("a", 0.4, "moderate"),
      metric("b", 0.7, "strong"),
      metric("c", 0.3, "weak"),
    ]);
    expect(out.indexOf("Metric b")).toBeGreaterThan(-1);
    expect(out.indexOf("Metric b")).toBeLessThan(out.indexOf("Metric a"));
    expect(out.indexOf("Metric a")).toBeLessThan(out.indexOf("Metric c"));
  });

  /**
   * A headline must not shout a reading the chip beside it un-says: verdicts
   * below weak ("could be chance", "too few pilots") stay out of the digest
   * no matter how large their ρ.
   */
  it("keeps verdicts below weak out, however strong the coefficient", () => {
    const out = html([
      metric("noise", 0.9, "within noise"),
      metric("thin", 0.8, "n too small"),
      metric("real", 0.3, "weak"),
    ]);
    expect(out).toContain("Metric real");
    expect(out).not.toContain("Metric noise");
    expect(out).not.toContain("Metric thin");
  });

  /** Outcome checks correlate by construction — never headline material. */
  it("keeps outcome-derived metrics out", () => {
    const out = html([
      metric("outcome", 0.9, "strong", { outcome: true }),
      metric("real", 0.5, "moderate"),
    ]);
    expect(out).not.toContain("Metric outcome");
    expect(out).toContain("Metric real");
  });

  /**
   * When nothing clears the bar the card says so rather than vanishing — "no
   * clear pattern" is itself the day's finding, and a digest that only
   * appears on tidy days would quietly overclaim on the rest.
   */
  it("says it can't say when no verdict clears the bar", () => {
    const out = html([metric("noise", 0.9, "within noise")]);
    expect(out).toContain("What separated the field");
    expect(out).toContain("no clear pattern");
    expect(out).not.toContain("Metric noise");
  });

  it("also can't say when no metric produced a correlation at all", () => {
    const out = html([metric("dead", 0, "weak", { correlation: null })]);
    expect(out).toContain("no clear pattern");
  });
});
