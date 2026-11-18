import { describe, expect, it } from "vitest";
import { LEGACY_FRAME, frameForWidth } from "./frame";

describe("frameForWidth", () => {
  it("is in CSS pixels: the viewBox is as wide as the chart is drawn", () => {
    const frame = frameForWidth(319);
    expect(frame.width).toBe(319);
    expect(frame.fontSize).toBe(13);
    expect(frame.measured).toBe(true);
  });

  it("keeps the same label size at every width, so only the plot grows", () => {
    const phone = frameForWidth(319);
    const desktop = frameForWidth(1078);
    expect(desktop.fontSize).toBe(phone.fontSize);
    expect(desktop.plotLeft).toBe(phone.plotLeft);
    expect(desktop.width - desktop.plotRight).toBe(phone.width - phone.plotRight);
  });

  it("sizes its margins for the type they hold", () => {
    const frame = frameForWidth(319);
    // Five digits of y tick ("10000" in feet) and their gap.
    expect(frame.plotLeft).toBeGreaterThanOrEqual(13 * 0.6 * 5 + 6);
    // Half of the last time label overhangs the plot's right edge.
    expect(frame.width - frame.plotRight).toBeGreaterThanOrEqual(16);
  });

  it("grows with the reader's own text size", () => {
    const frame = frameForWidth(319, 20);
    expect(frame.fontSize).toBe(16.25);
    expect(frame.plotLeft).toBeGreaterThan(frameForWidth(319).plotLeft);
  });

  it("does not lay out for a collapsed parent", () => {
    expect(frameForWidth(1).width).toBe(240);
  });

  it("keeps the fixed geometry for the stack that has not been converted", () => {
    expect(LEGACY_FRAME).toMatchObject({ width: 560, plotLeft: 44, plotRight: 540, fontSize: 10 });
  });
});
