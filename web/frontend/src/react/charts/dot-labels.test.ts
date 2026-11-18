import { describe, expect, it } from "vitest";
import { placeDotLabels, type LabelBox } from "./dot-labels";

const BOUNDS: LabelBox = { x0: 0, x1: 300, y0: 0, y1: 300 };
const base = { fontSize: 13, dotRadius: 4.5, bounds: BOUNDS };

function overlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

describe("placeDotLabels", () => {
  it("names a dot on its own level with it, to its right", () => {
    const [label] = placeDotLabels({
      ...base,
      dots: [{ key: "a", x: 100, y: 100 }],
      wanted: [{ key: "a", text: "GlideSpd" }],
    });
    expect(label.anchor).toBe("start");
    expect(label.x).toBeGreaterThan(100 + 4.5);
    // The baseline that centres 13px type on the dot.
    expect(label.y).toBeCloseTo(100 + 13 * 0.35);
  });

  it("goes to the left of a dot near the right-hand edge", () => {
    const [label] = placeDotLabels({
      ...base,
      dots: [{ key: "a", x: 280, y: 100 }],
      wanted: [{ key: "a", text: "GlideSpd" }],
    });
    expect(label.anchor).toBe("end");
    expect(label.box.x1).toBeLessThan(280 - 4.5);
    expect(label.box.x0).toBeGreaterThanOrEqual(0);
  });

  it("keeps the names of a diagonal run of dots off each other and off the dots", () => {
    // Five dots 7px apart up a diagonal: nearer than a line of 13px type.
    const dots = [0, 1, 2, 3, 4].map((i) => ({
      key: `d${i}`,
      x: 100 + i * 7,
      y: 200 - i * 7,
    }));
    const labels = placeDotLabels({
      ...base,
      dots,
      wanted: dots.map((d) => ({ key: d.key, text: "Search%" })),
    });
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const a of labels) {
      for (const b of labels) {
        if (a !== b) expect(overlap(a.box, b.box)).toBe(false);
      }
      for (const d of dots) {
        if (d.key === a.key) continue;
        const nx = Math.min(a.box.x1, Math.max(a.box.x0, d.x));
        const ny = Math.min(a.box.y1, Math.max(a.box.y0, d.y));
        expect(Math.hypot(nx - d.x, ny - d.y)).toBeGreaterThanOrEqual(4.5);
      }
      // Beside its own dot, never carried off: within two lines of it.
      const own = dots.find((d) => d.key === a.key)!;
      expect(Math.abs(a.y - own.y)).toBeLessThan(13 * 2);
    }
  });

  it("places in the caller's order, so the first wanted name is the one kept", () => {
    // Two dots in one place: one name fits, and it is the first asked for.
    const dots = [
      { key: "strong", x: 150, y: 150 },
      { key: "weak", x: 151, y: 151 },
    ];
    const labels = placeDotLabels({
      ...base,
      bounds: { x0: 140, x1: 240, y0: 140, y1: 162 },
      dots,
      wanted: [
        { key: "strong", text: "GlideSpd" },
        { key: "weak", text: "StartDly" },
      ],
    });
    expect(labels.map((l) => l.key)).toEqual(["strong"]);
  });

  it("does not move a standing name when another is added after it", () => {
    const dots = [
      { key: "a", x: 100, y: 100 },
      { key: "b", x: 108, y: 94 },
    ];
    const alone = placeDotLabels({ ...base, dots, wanted: [{ key: "a", text: "GlideSpd" }] });
    const both = placeDotLabels({
      ...base,
      dots,
      wanted: [
        { key: "a", text: "GlideSpd" },
        { key: "b", text: "Wide%" },
      ],
    });
    expect(both[0]).toEqual(alone[0]);
  });

  it("keeps clear of a blocked box, and drops a name with no clear place", () => {
    const dots = [{ key: "a", x: 150, y: 150 }];
    const wanted = [{ key: "a", text: "GlideSpd" }];
    const right: LabelBox = { x0: 150, x1: 300, y0: 0, y1: 300 };
    const [label] = placeDotLabels({ ...base, dots, wanted, blocked: [right] });
    expect(label.anchor).toBe("end");
    expect(placeDotLabels({ ...base, dots, wanted, blocked: [BOUNDS] })).toEqual([]);
  });

  it("ignores a wanted name with no dot", () => {
    expect(placeDotLabels({ ...base, dots: [], wanted: [{ key: "x", text: "Nope" }] })).toEqual([]);
  });
});
