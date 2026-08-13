import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldAnalysisBasis } from "@glidecomp/engine";
import { AnalysisBasis } from "./AnalysisBasis";

/** A basis with neither airtime field — what a stored v12-or-earlier report gives us. */
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

function html(
  basis: FieldAnalysisBasis,
  excluded: { pilot_name: string; reason: string }[] = [],
  extra: { weatherHref?: string; thermalsHref?: string } = {}
): string {
  return renderToStaticMarkup(
    createElement(AnalysisBasis, {
      basis,
      excluded,
      timeZone: "Australia/Sydney",
      ...extra,
    })
  );
}

describe("AnalysisBasis", () => {
  /**
   * The version bump makes stored reports stale, but a stale row is SERVED
   * while it revalidates — so the box meets bases without the field and must
   * simply omit the fact. Getting this wrong takes down the whole page for
   * every reader until the background recompute lands.
   */
  it("renders without airtime or window (stored pre-v13 report)", () => {
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

  /**
   * Reading order, worst to best use of the air — not the order the fields sit
   * in on `FieldAirtimeSplit`. The rounding still runs in field order, so which
   * phase collects the largest remainder does not depend on the layout: 37.6 /
   * 23.4 / 39.0 rounds to 38 / 23 / 39 either way.
   */
  it("orders the phases searching, climbing, gliding", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT });
    expect(out.indexOf("searching")).toBeLessThan(out.indexOf("climbing"));
    expect(out.indexOf("climbing")).toBeLessThan(out.indexOf("gliding"));
    // Each row is a label at the bar's start and the percentage at its end.
    expect(out.indexOf("climbing")).toBeLessThan(out.indexOf("38%"));
  });
});

describe("AnalysisBasis fact links", () => {
  /**
   * The facts become doors into the sections that explain them — but only
   * when the caller says the section rendered. An anchor to a missing id
   * would scroll nowhere, so no href means a plain reading.
   */
  it("links thermals, airtime and working band to their sections when given targets", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT, analysisWindow: WINDOW }, [], {
      weatherHref: "#weather-heading",
      thermalsHref: "#thermals-heading",
    });
    expect(out).toContain('href="#thermals-heading"');
    expect(out).toContain('href="#weather-heading"');
  });

  it("renders no anchors at all without targets", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT, analysisWindow: WINDOW });
    expect(out).not.toContain("#thermals-heading");
    expect(out).not.toContain("#weather-heading");
    // The readings themselves are unchanged.
    expect(out).toContain("182");
    expect(out).toContain("82h (13:05–18:40 AEDT)");
  });
});

describe("AnalysisBasis excluded pilots", () => {
  const EIGHT = Array.from({ length: 8 }, (_, i) => ({
    pilot_name: `Pilot ${i}`,
    reason: "scored from a manual flight report — no tracklog to analyse",
  }));

  /**
   * The box is a glance at what was evaluated. Eight names and their reasons
   * ran longer than every fact above them put together, which is how the
   * caveats came to be the first thing a reader met.
   */
  it("keeps the count but sends the names to the footnote", () => {
    const out = html(OLD_BASIS, EIGHT);
    expect(out).toContain("8");
    expect(out).toContain("in the scores but not in this analysis");
    expect(out).not.toContain("Pilot 0");
    expect(out).not.toContain("no tracklog to analyse");
    // ...via a link that lands on the footnote's heading.
    expect(out).toContain('href="#excluded-pilots"');
  });

  it("says nothing at all when every pilot was analysed", () => {
    const out = html(OLD_BASIS, []);
    expect(out).not.toContain("in the scores");
    expect(out).not.toContain("excluded-pilots");
  });

  it("keeps the singular readable for one pilot", () => {
    expect(html(OLD_BASIS, EIGHT.slice(0, 1))).toContain("pilot is in the scores");
  });
});
