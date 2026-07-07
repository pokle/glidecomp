import { describe, expect, test } from "bun:test";
import {
  isValidTimezone,
  timezoneForCoords,
  timezoneForXctsk,
} from "../src/timezone";

describe("timezoneForCoords", () => {
  test("resolves land coordinates to their IANA zone", () => {
    // Corryong, VIC (the bundled sample comp)
    expect(timezoneForCoords(-36.195, 147.9)).toBe("Australia/Melbourne");
    // Chamonix
    expect(timezoneForCoords(45.92, 6.87)).toBe("Europe/Paris");
  });

  test("resolves open ocean to an Etc/GMT zone Intl accepts", () => {
    const zone = timezoneForCoords(0, -30);
    expect(zone).toMatch(/^Etc\/GMT/);
    expect(isValidTimezone(zone!)).toBe(true);
  });

  test("returns undefined for out-of-range input", () => {
    expect(timezoneForCoords(999, 0)).toBeUndefined();
    expect(timezoneForCoords(NaN, NaN)).toBeUndefined();
  });
});

describe("timezoneForXctsk", () => {
  const task = {
    taskType: "CLASSIC",
    version: 1,
    turnpoints: [
      {
        type: "TAKEOFF",
        radius: 400,
        waypoint: { name: "Launch", lat: -36.195, lon: 147.9 },
      },
    ],
  };

  test("derives the zone from the first turnpoint (object input)", () => {
    expect(timezoneForXctsk(task)).toBe("Australia/Melbourne");
  });

  test("derives the zone from the stored JSON string", () => {
    expect(timezoneForXctsk(JSON.stringify(task))).toBe("Australia/Melbourne");
  });

  test("returns undefined for null / malformed / empty tasks", () => {
    expect(timezoneForXctsk(null)).toBeUndefined();
    expect(timezoneForXctsk("not json")).toBeUndefined();
    expect(timezoneForXctsk({ taskType: "CLASSIC", turnpoints: [] })).toBeUndefined();
    expect(
      timezoneForXctsk({ turnpoints: [{ waypoint: { lat: "x", lon: "y" } }] })
    ).toBeUndefined();
  });
});

describe("isValidTimezone", () => {
  test("accepts IANA names and rejects garbage", () => {
    expect(isValidTimezone("Australia/Melbourne")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Etc/GMT+2")).toBe(true);
    // Offset zones ("+11:00") are also accepted — modern ECMA-402 allows
    // them and every consumer is Intl itself, so they format fine.
    expect(isValidTimezone("+11:00")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
