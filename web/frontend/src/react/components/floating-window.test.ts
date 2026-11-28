import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOAT,
  opensKeyboard,
  parseFloatState,
  releaseVelocity,
  settle,
  type FloatState,
  type Release,
} from "./floating-window";

// A 390 x 780 phone and the small window (176 px square).
const still = (cx: number, cy: number): Release => ({
  cx,
  cy,
  width: 176,
  vx: 0,
  vy: 0,
  vw: 390,
  vh: 780,
});
const at = (over: Partial<FloatState>): FloatState => ({ ...DEFAULT_FLOAT, ...over });

describe("settle: where a released window rests", () => {
  it("goes to the corner its centre is nearest", () => {
    expect(settle(at({}), still(100, 600))).toMatchObject({
      side: "left",
      edge: "bottom",
      tucked: false,
    });
    expect(settle(at({ side: "left", edge: "bottom" }), still(300, 100))).toMatchObject({
      side: "right",
      edge: "top",
      tucked: false,
    });
  });

  it("rests in the middle of an edge when it is let go there", () => {
    expect(settle(at({ side: "left" }), still(195, 600))).toMatchObject({
      side: "centre",
      edge: "bottom",
      tucked: false,
    });
  });

  it("is carried on by a flick", () => {
    // Released left of the middle, moving right at speed.
    const r = { ...still(150, 200), vx: 1.2 };
    expect(settle(at({ side: "left" }), r).side).toBe("right");
  });

  it("is not put away by a fast move TOWARDS a side", () => {
    // The whole window is on screen: this is a throw to the corner.
    const r = { ...still(290, 200), vx: 3 };
    expect(settle(at({ side: "left" }), r)).toMatchObject({ side: "right", tucked: false });
  });

  it("is put away when a third of it is over a side edge", () => {
    expect(settle(at({}), still(390 - 88 + 60, 200))).toMatchObject({
      side: "right",
      tucked: true,
    });
    expect(settle(at({}), still(88 - 60, 200))).toMatchObject({ side: "left", tucked: true });
    // A little over, and still: it comes back.
    expect(settle(at({}), still(390 - 88 + 30, 200)).tucked).toBe(false);
  });

  it("is put away from less far by a flick outward", () => {
    const r = { ...still(390 - 88 + 30, 200), vx: 0.8 };
    expect(settle(at({}), r).tucked).toBe(true);
    // The same place, flicked back in: it stays.
    expect(settle(at({}), { ...r, vx: -0.8 }).tucked).toBe(false);
  });

  it("a large window, centred, keeps its side", () => {
    const large = { ...still(195, 300), width: 366 };
    expect(settle(at({ size: "large", side: "left" }), large).side).toBe("left");
    expect(settle(at({ size: "large", side: "right" }), { ...large, cx: 205 }).side).toBe("right");
  });

  it("keeps the size it had", () => {
    expect(settle(at({ size: "large" }), still(100, 600)).size).toBe("large");
  });
});

describe("releaseVelocity", () => {
  it("is zero for a finger that stopped before it lifted", () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 200, y: 0, t: 100 },
    ];
    expect(releaseVelocity(samples, 400)).toEqual({ vx: 0, vy: 0 });
  });

  it("is the speed over the last moments", () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 50, y: 0, t: 950 },
      { x: 100, y: 10, t: 1000 },
    ];
    expect(releaseVelocity(samples, 1000)).toEqual({ vx: 1, vy: 0.2 });
  });
});

describe("releaseVelocity on a busy page", () => {
  it("still sees a flick when the moves arrive far apart", () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 50, t: 130 },
      { x: 0, y: 100, t: 260 },
    ];
    const v = releaseVelocity(samples, 265);
    expect(v.vy).toBeGreaterThan(0.3);
  });

  it("and still calls a finger that stopped, stopped", () => {
    const samples = [
      { x: 0, y: 0, t: 0 },
      { x: 0, y: 50, t: 130 },
    ];
    expect(releaseVelocity(samples, 430)).toEqual({ vx: 0, vy: 0 });
  });
});

describe("parseFloatState", () => {
  it("reads back what was written", () => {
    const s: FloatState = { side: "left", edge: "bottom", size: "large", tucked: true };
    expect(parseFloatState(JSON.stringify(s))).toEqual(s);
  });

  it("answers null for nothing, and for what is not JSON", () => {
    expect(parseFloatState(null)).toBeNull();
    expect(parseFloatState("{")).toBeNull();
    expect(parseFloatState("null")).toBeNull();
  });

  it("replaces a field it does not know with the default", () => {
    expect(parseFloatState('{"side":"up","size":7}')).toEqual(DEFAULT_FLOAT);
    expect(parseFloatState('{"side":"centre"}')?.side).toBe("centre");
  });
});

describe("opensKeyboard", () => {
  it("is true for text entry, and false for the rest", () => {
    expect(opensKeyboard({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(opensKeyboard({ tagName: "INPUT" })).toBe(true);
    expect(opensKeyboard({ tagName: "TEXTAREA" })).toBe(true);
    expect(opensKeyboard({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(opensKeyboard({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(opensKeyboard({ tagName: "INPUT", type: "text", readOnly: true })).toBe(false);
    expect(opensKeyboard({ tagName: "BUTTON" })).toBe(false);
    expect(opensKeyboard(null)).toBe(false);
  });
});
