import { describe, expect, it } from "vitest";
import {
  COORD_SUSPECT_DELTA_M,
  SUSPECT_DELTA_M,
  altitudeDelta,
  altitudeVerdict,
  describeAltitudePattern,
  detectAltitudePattern,
  feetToMetres,
  formatAltitudeDelta,
  looksLikeCorruptedTerrainRead,
  needsReview,
  reviewSortKey,
  summariseAltitudeCheck,
  type AltitudePair,
} from "./altitude-check";

describe("altitudeDelta", () => {
  it("is signed: file minus map", () => {
    expect(altitudeDelta({ fileAlt: 800, mapAlt: 650 })).toBe(150);
    expect(altitudeDelta({ fileAlt: 650, mapAlt: 800 })).toBe(-150);
  });
  it("is undefined when either side is unknown", () => {
    expect(altitudeDelta({ mapAlt: 650 })).toBeUndefined();
    expect(altitudeDelta({ fileAlt: 650 })).toBeUndefined();
    expect(altitudeDelta({})).toBeUndefined();
  });
  it("treats a genuine zero as a number, not as absent", () => {
    expect(altitudeDelta({ fileAlt: 0, mapAlt: 0 })).toBe(0);
    expect(altitudeDelta({ fileAlt: 0, mapAlt: 1500 })).toBe(-1500);
  });
});

describe("altitudeVerdict", () => {
  it("passes a rounded-to-10 m file altitude as ok", () => {
    // The bundled Corryong set is rounded to 10 m and encodes the altitude in
    // the code ("4C-080"); a few metres out is the file, not an error.
    expect(altitudeVerdict({ fileAlt: 800, mapAlt: 796 })).toBe("ok");
    expect(altitudeVerdict({ fileAlt: 150, mapAlt: 163 })).toBe("ok");
  });
  it("flags a disagreement past the tolerance", () => {
    expect(altitudeVerdict({ fileAlt: 800, mapAlt: 800 - SUSPECT_DELTA_M })).toBe("suspect");
    expect(altitudeVerdict({ fileAlt: 800, mapAlt: 801 - SUSPECT_DELTA_M })).toBe("ok");
  });
  it("blames the coordinates once the gap is too big for terrain", () => {
    expect(altitudeVerdict({ fileAlt: 1500, mapAlt: 1500 - COORD_SUSPECT_DELTA_M })).toBe("coords");
  });
  it("separates an absent altitude from a wrong one", () => {
    expect(altitudeVerdict({ mapAlt: 1500 })).toBe("missing");
    // A zero at a mountain launch is WRONG, not missing — the whole point.
    expect(altitudeVerdict({ fileAlt: 0, mapAlt: 1500 })).toBe("coords");
  });
  it("says unreachable when the map has no answer", () => {
    expect(altitudeVerdict({ fileAlt: 800 })).toBe("unreachable");
    expect(altitudeVerdict({})).toBe("unreachable");
  });
});

describe("needsReview", () => {
  it("lists only the rows with something to decide", () => {
    expect(needsReview({ fileAlt: 800, mapAlt: 796 })).toBe(false);
    expect(needsReview({ fileAlt: 800, mapAlt: 600 })).toBe(true);
    expect(needsReview({ mapAlt: 600 })).toBe(true);
    // Nothing to compare against is nothing to review.
    expect(needsReview({ fileAlt: 800 })).toBe(false);
  });
});

describe("reviewSortKey", () => {
  it("puts the biggest disagreement first and the blanks last", () => {
    const rows: AltitudePair[] = [
      { fileAlt: 800, mapAlt: 700 }, // 100
      { mapAlt: 700 }, // blank: needs a value, needs no judgement
      { fileAlt: 1500, mapAlt: 700 }, // 800
      { fileAlt: 800, mapAlt: 790 }, // 10
    ];
    const order = [...rows].sort((a, b) => reviewSortKey(b) - reviewSortKey(a));
    expect(order.map((r) => r.fileAlt)).toEqual([1500, 800, 800, undefined]);
  });
});

describe("looksLikeCorruptedTerrainRead", () => {
  it("recognises the real cases from the Great Ocean Road comp", () => {
    // Point_Addis_Hill: the file holds 6660 m, the terrain is 80 m. 6580 is
    // one red-byte step (6553.6 m) plus the difference between the single
    // pixel the old code read and the 3x3 median read now.
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 6660, mapAlt: 80 })).toBe(true);
    // Big_Hill: 13273 m against a 166 m hill — two steps.
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 13273, mapAlt: 166 })).toBe(true);
    // And the other direction, which partial alpha also produced.
    expect(looksLikeCorruptedTerrainRead({ fileAlt: -6413, mapAlt: 140 })).toBe(true);
  });

  it("does not claim an ordinary mistake", () => {
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 800, mapAlt: 600 })).toBe(false);
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 1500, mapAlt: 200 })).toBe(false);
    // A file in feet read as metres is 3.28x, not a whole byte step.
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 4567, mapAlt: 1392 })).toBe(false);
    // Nothing to compare against.
    expect(looksLikeCorruptedTerrainRead({ mapAlt: 80 })).toBe(false);
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 80 })).toBe(false);
  });

  it("needs the step to be close, not merely large", () => {
    // 6553.6 m exactly, and a mistake 200 m away from it.
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 6633.6, mapAlt: 80 })).toBe(true);
    expect(looksLikeCorruptedTerrainRead({ fileAlt: 6853.6, mapAlt: 80 })).toBe(false);
  });
});

describe("summariseAltitudeCheck", () => {
  it("counts each verdict, and reviewable is what the list shows", () => {
    const summary = summariseAltitudeCheck([
      { fileAlt: 800, mapAlt: 796 },
      { fileAlt: 150, mapAlt: 152 },
      { fileAlt: 800, mapAlt: 600 }, // suspect
      { fileAlt: 1500, mapAlt: 400 }, // coords
      { mapAlt: 700 }, // missing
      { fileAlt: 800 }, // unreachable
    ]);
    expect(summary).toMatchObject({
      compared: 4,
      ok: 2,
      suspect: 1,
      coords: 1,
      missing: 1,
      unreachable: 1,
      reviewable: 3,
      corruptTerrainRead: 0,
    });
  });

  it("counts the altitudes the old terrain read wrote", () => {
    const summary = summariseAltitudeCheck([
      { fileAlt: 6660, mapAlt: 80 }, // one byte step
      { fileAlt: 13273, mapAlt: 166 }, // two
      { fileAlt: 1500, mapAlt: 200 }, // a real mistake, not a step
      { fileAlt: 160, mapAlt: 158 }, // fine
    ]);
    expect(summary.corruptTerrainRead).toBe(2);
    expect(summary.coords).toBe(3);
  });
});

describe("detectAltitudePattern", () => {
  // The real case: the HG Worlds 2026 OziExplorer file states feet, and
  // reading it as metres made every altitude 3.28x the terrain.
  const feetSet: AltitudePair[] = [
    { fileAlt: 738, mapAlt: 225 },
    { fileAlt: 650, mapAlt: 198 },
    { fileAlt: 902, mapAlt: 275 },
    { fileAlt: 1224, mapAlt: 373 },
    { fileAlt: 1827, mapAlt: 557 },
    { fileAlt: 4567, mapAlt: 1392 },
  ];

  it("recognises a file of feet read as metres", () => {
    const pattern = detectAltitudePattern(feetSet);
    expect(pattern?.kind).toBe("feet");
    expect(pattern).toMatchObject({ count: 6, total: 6 });
    expect((pattern as { ratio: number }).ratio).toBeCloseTo(3.28, 1);
    expect(describeAltitudePattern(pattern!)).toContain("in feet");
  });

  it("recognises a constant offset as one cause, not many mistakes", () => {
    const offsetSet: AltitudePair[] = [
      { fileAlt: 325, mapAlt: 225 },
      { fileAlt: 298, mapAlt: 198 },
      { fileAlt: 380, mapAlt: 275 },
      { fileAlt: 470, mapAlt: 373 },
      { fileAlt: 655, mapAlt: 557 },
      { fileAlt: 1490, mapAlt: 1392 },
    ];
    const pattern = detectAltitudePattern(offsetSet);
    expect(pattern?.kind).toBe("offset");
    // The median of the six offsets — "about 100 m", not exactly the 100 the
    // fixture was built around.
    expect((pattern as { metres: number }).metres).toBe(99);
    expect(describeAltitudePattern(pattern!)).toContain("above the terrain");
  });

  it("claims nothing for a set that is merely a bit rough", () => {
    expect(
      detectAltitudePattern([
        { fileAlt: 800, mapAlt: 796 },
        { fileAlt: 150, mapAlt: 163 },
        { fileAlt: 275, mapAlt: 270 },
        { fileAlt: 373, mapAlt: 380 },
        { fileAlt: 557, mapAlt: 540 },
        { fileAlt: 1392, mapAlt: 1400 },
      ])
    ).toBeNull();
  });

  it("claims nothing for a handful of rows", () => {
    expect(detectAltitudePattern(feetSet.slice(0, 4))).toBeNull();
  });

  it("claims nothing when a few bad rows sit in a good set", () => {
    const mostlyFine: AltitudePair[] = [
      { fileAlt: 800, mapAlt: 796 },
      { fileAlt: 150, mapAlt: 152 },
      { fileAlt: 275, mapAlt: 270 },
      { fileAlt: 373, mapAlt: 380 },
      { fileAlt: 557, mapAlt: 540 },
      { fileAlt: 4567, mapAlt: 1392 }, // one genuine mistake
      { fileAlt: 1500, mapAlt: 200 }, // and one wrong coordinate
    ];
    expect(detectAltitudePattern(mostlyFine)).toBeNull();
  });

  it("ignores near-sea-level rows, where a ratio means nothing", () => {
    // 3 m vs 10 m is a ratio of 0.3 and 12 vs 2 is 6; neither is a finding.
    const coastal: AltitudePair[] = [
      { fileAlt: 3, mapAlt: 10 },
      { fileAlt: 12, mapAlt: 2 },
      { fileAlt: 5, mapAlt: 1 },
      { fileAlt: 8, mapAlt: 4 },
      { fileAlt: 2, mapAlt: 9 },
      { fileAlt: 6, mapAlt: 3 },
    ];
    expect(detectAltitudePattern(coastal)).toBeNull();
  });
});

describe("feetToMetres", () => {
  it("converts the sampled HG Worlds altitudes back to the published metres", () => {
    expect(feetToMetres(738)).toBe(225);
    expect(feetToMetres(2234)).toBe(681);
    expect(feetToMetres(4567)).toBe(1392);
  });
});

describe("formatAltitudeDelta", () => {
  it("always carries its sign", () => {
    expect(formatAltitudeDelta(120)).toBe("+120");
    expect(formatAltitudeDelta(-45.4)).toBe("-45");
    expect(formatAltitudeDelta(0)).toBe("0");
  });
});
