import { describe, expect, it } from "vitest";
import { nearestLine, nearestPoint } from "./nearest";

describe("nearestPoint", () => {
  const points = [
    { x: 10, y: 10 },
    { x: 100, y: 10 },
    { x: 100, y: 100 },
  ];

  it("is the point with the least distance, wherever the pointer is", () => {
    expect(nearestPoint(points, 12, 9)?.index).toBe(0);
    expect(nearestPoint(points, 90, 30)?.index).toBe(1);
    // Far outside every dot's old 12-unit halo, and still an answer.
    expect(nearestPoint(points, 300, 300)?.index).toBe(2);
  });

  it("says how far away it is", () => {
    expect(nearestPoint(points, 13, 14)).toEqual({ index: 0, distance: 5 });
  });

  it("gives a tie to the first", () => {
    expect(nearestPoint(points, 55, 10)?.index).toBe(0);
  });

  it("has no answer for no points", () => {
    expect(nearestPoint([], 0, 0)).toBeNull();
  });
});

describe("nearestLine", () => {
  const flat = [[{ x: 0, y: 0 }, { x: 100, y: 0 }]];
  const diagonal = [[{ x: 0, y: 100 }, { x: 100, y: 0 }]];

  it("measures to the line, not to its points", () => {
    // The middle of the flat line is 50 units from either of its ends, and 5
    // from the line itself.
    expect(nearestLine([diagonal, flat], 50, 5)).toEqual({ index: 1, distance: 5 });
    expect(nearestLine([flat, diagonal], 50, 45)?.index).toBe(1);
  });

  it("does not measure across a gap, where nothing is drawn", () => {
    const gapped = [
      [{ x: 0, y: 50 }, { x: 20, y: 50 }],
      [{ x: 80, y: 50 }, { x: 100, y: 50 }],
    ];
    const other = [[{ x: 0, y: 70 }, { x: 100, y: 70 }]];
    // (50, 55) is 5 from where the gapped line would run, but 30 from either
    // piece that is drawn; the other line is 15 away.
    expect(nearestLine([gapped, other], 50, 55)).toEqual({ index: 1, distance: 15 });
  });

  it("treats a piece of one point as that point", () => {
    const dot = [[{ x: 10, y: 10 }]];
    expect(nearestLine([flat, dot], 12, 9)?.index).toBe(1);
  });

  it("has no answer for no lines", () => {
    expect(nearestLine([], 0, 0)).toBeNull();
  });
});
