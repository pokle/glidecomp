import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldAnalysisBasis } from "@glidecomp/engine";
import { AnalysisBasis } from "./AnalysisBasis";

/** A basis with neither airtime field — what a stored v11-or-earlier report gives us. */
const OLD_BASIS: FieldAnalysisBasis = {
  pilotCount: 37,
  gridStepSeconds: 10,
  sharedThermalCount: 182,
  multiPilotThermalCount: 51,
  workingBandFloor: 894,
  workingBandCeiling: 2575,
  workingBandFallback: false,
};

const WINDOW = { from: "2026-01-07T02:05:00Z", to: "2026-01-07T07:40:00Z" };
const SPLIT = { climbPct: 37.6, glidePct: 23.4, searchPct: 39.0, airborneSeconds: 294_840 };

function html(basis: FieldAnalysisBasis): string {
  return renderToStaticMarkup(
    createElement(AnalysisBasis, { basis, excluded: [], timeZone: "Australia/Sydney" })
  );
}

describe("AnalysisBasis", () => {
  /**
   * The version bump makes stored reports stale, but a stale row is SERVED
   * while it revalidates — so the box meets bases without the field and must
   * simply omit the fact. Getting this wrong takes down the whole page for
   * every reader until the background recompute lands.
   */
  it("renders without airtime or window (stored pre-v12 report)", () => {
    const out = html(OLD_BASIS);
    expect(out).not.toContain("Airtime");
    // The rest of the basis is unaffected.
    expect(out).toContain("Pilots");
    expect(out).toContain("37");
    expect(out).toContain("894");
  });

  /** The 10 s grid is constant across every task and comp, so it moved to the
   * glossary at the foot of the page — see MetricGlossary's `method` note. */
  it("does not spend a tile on the resampling grid", () => {
    expect(html({ ...OLD_BASIS, airtimeSplit: SPLIT, analysisWindow: WINDOW })).not.toContain(
      "Sampling"
    );
  });

  it("pairs the airtime total with the window it was flown in", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT, analysisWindow: WINDOW });
    // 294840 s = 81.9 h, rendered whole above 10 h; window in COMP time
    // (13:05–18:40 AEDT), never the runtime's zone.
    expect(out).toContain("82h (13:05–18:40 AEDT)");
  });

  it("keeps a decimal on a thin day, where the total is the warning", () => {
    const out = html({
      ...OLD_BASIS,
      pilotCount: 7,
      airtimeSplit: { ...SPLIT, airborneSeconds: 20_160 },
      analysisWindow: WINDOW,
    });
    expect(out).toContain("5.6h");
  });

  it("falls back to the window alone when a stale row has no split", () => {
    const out = html({ ...OLD_BASIS, analysisWindow: WINDOW });
    expect(out).toContain("13:05–18:40 AEDT");
    expect(out).not.toContain("Airtime split");
  });

  it("renders the split as time, in gerunds, when present", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT });
    // "Airtime", not "Phase": the label has to say the percentages are of time.
    expect(out).toContain("Airtime split");
    expect(out).toContain("climbing");
    expect(out).toContain("gliding");
    expect(out).toContain("searching");
    // Largest-remainder rounding — naive rounding would render 38/23/40 = 101%.
    expect(out).toContain("38%");
    expect(out).toContain("23%");
    expect(out).toContain("39%");
  });
});
