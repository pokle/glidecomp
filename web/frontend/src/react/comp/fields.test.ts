import { describe, expect, test } from "vitest";
import {
  LAT_HINT,
  LON_HINT,
  coordsProblems,
  joinCoords,
  lonFieldName,
  splitCoords,
} from "./fields";
import { parseCoords } from "./route-editor";

describe("splitCoords / joinCoords — one stored value, two fields", () => {
  test("a stored pair splits into its halves, as written", () => {
    expect(splitCoords("-36.550979, 147.890395")).toEqual({
      lat: "-36.550979",
      lon: "147.890395",
    });
    // A map tap's `at=` has no space after the comma.
    expect(splitCoords("-36.5,148.2")).toEqual({ lat: "-36.5", lon: "148.2" });
    // parseCoords also reads a pair with only a space between.
    expect(splitCoords("-36.5 148.2")).toEqual({ lat: "-36.5", lon: "148.2" });
  });

  test("a half typed so far comes back where it was", () => {
    expect(splitCoords(joinCoords("-36.5", ""))).toEqual({ lat: "-36.5", lon: "" });
    expect(splitCoords(joinCoords("", "147"))).toEqual({ lat: "", lon: "147" });
  });

  test("blank is blank both ways", () => {
    expect(joinCoords("", "  ")).toBe("");
    expect(splitCoords("")).toEqual({ lat: "", lon: "" });
  });

  test("two good halves join into a pair the rest of the app reads", () => {
    expect(parseCoords(joinCoords("-36.55", "147.89"))).toEqual({ lat: -36.55, lon: 147.89 });
  });
});

describe("coordsProblems — each problem under the half it is about", () => {
  const lon = lonFieldName("coords");

  test("blank is fine unless the form needs them, and then both are asked for", () => {
    expect(coordsProblems("coords", "")).toEqual({});
    expect(coordsProblems("coords", "", true)).toEqual({ coords: LAT_HINT, [lon]: LON_HINT });
  });

  test("a good pair has no problems", () => {
    expect(coordsProblems("coords", "-36.55, 147.89", true)).toEqual({
      coords: null,
      [lon]: null,
    });
  });

  test("half a pair is a problem with the missing half only", () => {
    expect(coordsProblems("coords", joinCoords("-36.55", ""))).toEqual({
      coords: null,
      [lon]: LON_HINT,
    });
    expect(coordsProblems("coords", joinCoords("", "147.89"))).toEqual({
      coords: LAT_HINT,
      [lon]: null,
    });
  });

  test("out of range or not a number", () => {
    expect(coordsProblems("coords", "91, 147")).toEqual({ coords: LAT_HINT, [lon]: null });
    expect(coordsProblems("coords", "-36, 181")).toEqual({ coords: null, [lon]: LON_HINT });
    expect(coordsProblems("coords", "nowhere")).toEqual({ coords: LAT_HINT, [lon]: LON_HINT });
  });

  test("the longitude's name follows the latitude's (a manual flight's landing_lon)", () => {
    expect(lonFieldName("landing")).toBe("landing_lon");
  });
});
