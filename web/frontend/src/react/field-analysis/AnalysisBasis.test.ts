import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldAnalysisBasis } from "@glidecomp/engine";
import { AnalysisBasis } from "./AnalysisBasis";

/** A basis with no airtime split — what a stored v11-or-earlier report gives us. */
const OLD_BASIS: FieldAnalysisBasis = {
  pilotCount: 37,
  gridStepSeconds: 10,
  sharedThermalCount: 182,
  multiPilotThermalCount: 51,
  workingBandFloor: 894,
  workingBandCeiling: 2575,
  workingBandFallback: false,
};

function html(basis: FieldAnalysisBasis): string {
  return renderToStaticMarkup(createElement(AnalysisBasis, { basis, excluded: [] }));
}

describe("AnalysisBasis", () => {
  /**
   * The version bump makes stored reports stale, but a stale row is SERVED
   * while it revalidates — so the box meets bases without the field and must
   * simply omit the fact. Getting this wrong takes down the whole page for
   * every reader until the background recompute lands.
   */
  it("renders without an airtime split (stored pre-v12 report)", () => {
    const out = html(OLD_BASIS);
    expect(out).not.toContain("Airtime split");
    // The rest of the basis is unaffected.
    expect(out).toContain("Pilots analysed");
    expect(out).toContain("37");
    expect(out).toContain("894");
  });

  it("renders the split as time, in gerunds, when present", () => {
    const out = html({
      ...OLD_BASIS,
      airtimeSplit: {
        climbPct: 37.6,
        glidePct: 23.4,
        searchPct: 39.0,
        airborneSeconds: 123456,
      },
    });
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
