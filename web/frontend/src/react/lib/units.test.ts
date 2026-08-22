/**
 * Altitude input conversion (issue #662): what a reader types is in THEIR
 * unit, what the app stores is metres, and a value nobody edited must come
 * back unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_UNITS,
  fromAltitudeInput,
  toAltitudeInput,
  type UnitPreferences,
} from "./units";

const FEET: UnitPreferences = { ...DEFAULT_UNITS, altitude: "ft" };

describe("altitude input conversion", () => {
  it("leaves metres alone for a metric reader", () => {
    expect(toAltitudeInput(1000, DEFAULT_UNITS)).toBe(1000);
    expect(fromAltitudeInput(1000, DEFAULT_UNITS)).toBe(1000);
  });

  it("shows and reads whole feet for a foot reader", () => {
    expect(toAltitudeInput(1000, FEET)).toBe(3281);
    expect(fromAltitudeInput(3281, FEET)).toBe(1000);
    expect(fromAltitudeInput(10000, FEET)).toBe(3048);
  });

  it("round-trips every metre without drift", () => {
    // A foot is finer than a metre, so metres → feet → metres always lands
    // back on the same metre — an altitude nobody touched can never move.
    for (let m = -1000; m <= 30000; m += 7) {
      expect(fromAltitudeInput(toAltitudeInput(m, FEET), FEET)).toBe(m);
    }
  });

  it("passes a blank altitude through as NaN", () => {
    expect(toAltitudeInput(NaN, FEET)).toBeNaN();
    expect(fromAltitudeInput(NaN, FEET)).toBeNaN();
  });
});
