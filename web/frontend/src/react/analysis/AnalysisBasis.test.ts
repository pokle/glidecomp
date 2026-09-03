import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskAnalysisBasis } from "@glidecomp/engine";
import { AnalysisBasis } from "./AnalysisBasis";

/** A basis with neither airtime field — what a stored v12-or-earlier report gives us. */
const OLD_BASIS: TaskAnalysisBasis = {
  pilotCount: 37,
  gridStepSeconds: 10,
  sharedThermalCount: 182,
  multiPilotThermalCount: 51,
  workingBandFloor: 894,
  workingBandCeiling: 2575,
  workingBandFallback: false,
};

const SPLIT = { climbPct: 37.6, glidePct: 23.4, searchPct: 39.0, airborneSeconds: 294_840 };

function html(
  basis: TaskAnalysisBasis,
  excluded: { pilot_name: string; reason: string }[] = [],
  extra: { excludedHref?: string } = {}
): string {
  return renderToStaticMarkup(
    createElement(AnalysisBasis, { basis, excluded, ...extra })
  );
}

describe("AnalysisBasis", () => {
  /**
   * The readings a section owns went to that section's box (basis-facts.ts).
   * What is left here belongs to no section — repeating any of them would put
   * the row of tiles back one fact at a time.
   */
  it("states neither the field nor the thermals nor the band", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT });
    expect(out).not.toContain("Pilots");
    expect(out).not.toContain("Thermals");
    expect(out).not.toContain("Working band");
    expect(out).not.toContain("894");
  });

  /** The 10 s grid is constant across every task and comp, so it lives in the
   * method page's note rather than in a tile here. */
  it("does not spend a tile on the resampling grid", () => {
    expect(html({ ...OLD_BASIS, airtimeSplit: SPLIT })).not.toContain("Sampling");
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

  /**
   * The version bump makes stored reports stale, but a stale row is SERVED
   * while it revalidates — so the box meets bases with no split at all. With
   * nothing else to say it must render nothing, not an empty card.
   */
  it("renders nothing when a stale row has no split and no one was excluded", () => {
    expect(html(OLD_BASIS)).toBe("");
  });

  it("still renders the exclusion note when that is all it has", () => {
    const out = html(OLD_BASIS, [{ pilot_name: "A", reason: "no tracklog" }]);
    expect(out).toContain("in the scores but not in this analysis");
    expect(out).not.toContain("Airtime split");
  });
});

describe("AnalysisBasis excluded pilots", () => {
  const EIGHT = Array.from({ length: 8 }, (_, i) => ({
    pilot_name: `Pilot ${i}`,
    reason: "scored from a manual flight report — no tracklog to analyse",
  }));

  /**
   * Eight names and their reasons ran longer than every fact that used to sit
   * above them put together, which is how the caveats came to be the first
   * thing a reader met.
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

  /** The list is on another page now, so the anchor alone would scroll
   * nowhere — the caller says where it went. */
  it("follows the caller's link to wherever the list lives", () => {
    const out = html(OLD_BASIS, EIGHT, { excludedHref: "/x/method#excluded-pilots" });
    expect(out).toContain('href="/x/method#excluded-pilots"');
  });

  it("says nothing at all when every pilot was analysed", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT }, []);
    expect(out).not.toContain("in the scores");
    expect(out).not.toContain("excluded-pilots");
  });

  it("keeps the singular readable for one pilot", () => {
    expect(html(OLD_BASIS, EIGHT.slice(0, 1))).toContain("pilot is in the scores");
  });
});

/**
 * How hard the day was — the fact the rest of the page has to be read
 * against. Since v27 the engine's own `glide.extra_distance` explanation tells
 * the reader to read it "against how many pilots made goal" (#683), and until
 * this line the page never said what that number was.
 *
 * The denominator is the analysed `pilotCount`: see
 * TaskAnalysisBasis.goalCount.
 */
describe("AnalysisBasis goal share", () => {
  it("states the count, the field it is out of, and the share", () => {
    const out = html({ ...OLD_BASIS, goalCount: 14, pilotCount: 32 });
    expect(out).toContain("14 of 32");
    expect(out).toContain("made goal");
    expect(out).toContain("(44%)");
  });

  /** The denominator is the analysed field — the same population behind
   * every correlation on the page, so the share stays checkable against the
   * tables that follow it. */
  it("counts out of the analysed pilot count", () => {
    const out = html({ ...OLD_BASIS, goalCount: 14, pilotCount: 29 });
    expect(out).toContain("14 of 29");
    // 14/29 = 48%.
    expect(out).toContain("(48%)");
  });

  /**
   * Zero is the loudest reading the basis has — nobody completed the task —
   * and it is also falsy. A box that tested truthiness would drop the fact on
   * exactly the days that have one.
   */
  it("renders the hardest day of all rather than treating 0 as absent", () => {
    const out = html({ ...OLD_BASIS, goalCount: 0, pilotCount: 32 });
    expect(out).toContain("0 of 32");
    expect(out).toContain("(0%)");
  });

  it("renders a whole field into goal", () => {
    const out = html({ ...OLD_BASIS, goalCount: 32, pilotCount: 32 });
    expect(out).toContain("32 of 32");
    expect(out).toContain("(100%)");
  });

  /**
   * The version bump makes stored reports stale, but a stale row is SERVED
   * while it revalidates — so the box meets bases with no count and must say
   * nothing rather than print "undefined" or invent a 0% day.
   */
  it("says nothing when a v27-or-earlier row carries no count", () => {
    const out = html({ ...OLD_BASIS, airtimeSplit: SPLIT });
    expect(out).not.toContain("made goal");
    expect(out).not.toContain("undefined");
  });

  /** With no counts, no split and nobody excluded there is still nothing to
   * say — the goal share must not resurrect the empty card. */
  it("still renders nothing when the count is all that is missing", () => {
    expect(html(OLD_BASIS)).toBe("");
  });

  /** "0 of 0 made goal" is a degenerate report, not a difficult day. */
  it("says nothing for a field of no pilots", () => {
    expect(html({ ...OLD_BASIS, goalCount: 0, pilotCount: 0 })).toBe("");
  });

  /** It leads: it is context for the rest, not one more reading among them. */
  it("comes before the airtime split", () => {
    const out = html({
      ...OLD_BASIS,
      goalCount: 14,
      pilotCount: 32,
      airtimeSplit: SPLIT,
    });
    expect(out.indexOf("made goal")).toBeLessThan(out.indexOf("Airtime split"));
  });

  /** The share alone is enough to earn the card, on a stale row with no split. */
  it("carries the card on its own", () => {
    const out = html({ ...OLD_BASIS, goalCount: 14, pilotCount: 32 });
    expect(out).not.toBe("");
    expect(out).not.toContain("Airtime split");
  });
});
