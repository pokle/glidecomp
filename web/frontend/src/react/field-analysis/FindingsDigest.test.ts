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

  /**
   * The heading claims a winner, but the ranking orders by |ρ| and the
   * verdict is computed from |ρ| and n — so nothing upstream distinguishes a
   * metric that won by MORE from one that won by LESS. Without the flip, the
   * real Corryong 2026 open T2 report headlined "Gliding wide of the optimal
   * course line" at ρ = +0.80 when holding the line is what won.
   */
  describe("directional naming", () => {
    const WIDE: Partial<MetricReport> = {
      label: "Gliding wide of the optimal course line",
      winning: {
        more: "Flying wide of the optimised route",
        less: "Flying close to the optimised route",
      },
    };

    it("names the low side when less of the metric won", () => {
      const out = html([metric("wide", 0.8, "strong", { ...WIDE, correlation: {
        metricId: "wide", rho: +0.8, absRho: 0.8, n: 30, verdict: "strong",
      } })]);
      expect(out).toContain("Flying close to the optimised route");
      expect(out).not.toContain("Flying wide of the optimised route");
      expect(out).not.toContain("Gliding wide of the optimal course line");
    });

    it("names the high side when more of the metric won", () => {
      const out = html([metric("wide", 0.8, "strong", WIDE)]);
      expect(out).toContain("Flying wide of the optimised route");
      expect(out).not.toContain("Flying close to the optimised route");
    });

    /** A side with no honest phrasing, and any report stored before the field
     * existed, both fall back to the neutral label rather than vanishing. */
    it("falls back to the label for a missing side", () => {
      const out = html([metric("outclimb", 0.8, "strong", {
        label: "Climbing faster than the pilots sharing the thermal",
        winning: { more: "Climbing faster than others in the same thermal" },
        correlation: {
          metricId: "outclimb", rho: +0.8, absRho: 0.8, n: 30, verdict: "strong",
        },
      })]);
      expect(out).toContain("Climbing faster than the pilots sharing the thermal");
    });

    it("falls back to the label for a stored report with no winning at all", () => {
      const out = html([metric("old", 0.8, "strong", { label: "An older metric" })]);
      expect(out).toContain("An older metric");
    });
  });

  /**
   * The heading counts what actually made the cut. The verdict filter can
   * leave fewer than DIGEST_COUNT entries, and a hardcoded "Top 3" over a
   * list of one is a miscount sitting right above the evidence.
   */
  it("counts the entries it actually shows, singular included", () => {
    const three = html([
      metric("a", 0.7, "strong"),
      metric("b", 0.6, "strong"),
      metric("c", 0.5, "moderate"),
      metric("d", 0.4, "weak"),
    ]);
    expect(three).toContain("Top 3 winning behaviours");

    const one = html([
      metric("a", 0.7, "strong"),
      metric("noise", 0.9, "within noise"),
    ]);
    expect(one).toContain("Top 1 winning behaviour");
    expect(one).not.toContain("behaviours");
  });
});
