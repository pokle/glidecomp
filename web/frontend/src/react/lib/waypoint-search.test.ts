import { describe, expect, it } from "vitest";

import type { MapWaypoint } from "@/analysis/map-provider";
import { searchWaypoints } from "./waypoint-search";

function wp(code: string, name: string): MapWaypoint {
  return { id: code, code, name, lat: -36, lon: 147 };
}

const SET = [
  wp("B10", "Bright Showgrounds"),
  wp("A01", "Mt Elliot Launch"),
  wp("A010", "Elliot Lookout"),
  wp("C22", "Corryong Airfield"),
  wp("Z99", "Tawonga Gap"),
  wp("K05", "Côte Rôtie"),
];

const codes = (hits: MapWaypoint[]) => hits.map((h) => h.code);

describe("searchWaypoints", () => {
  it("matches nothing for an empty or blank query", () => {
    expect(searchWaypoints("", SET)).toEqual([]);
    expect(searchWaypoints("   ", SET)).toEqual([]);
  });

  it("puts the exact code first, then codes that start with it", () => {
    expect(codes(searchWaypoints("a01", SET))).toEqual(["A01", "A010"]);
  });

  it("ranks a name prefix above a later word, and a word above a substring", () => {
    // "Elliot Lookout" starts with it; "Mt Elliot Launch" has it as a word.
    expect(codes(searchWaypoints("elli", SET))).toEqual(["A010", "A01"]);
    // "ong" is only inside "Corryong" and "Tawonga".
    expect(codes(searchWaypoints("ong", SET))).toEqual(["C22", "Z99"]);
  });

  it("matches several words in any order", () => {
    expect(codes(searchWaypoints("launch elliot", SET))).toEqual(["A01"]);
    expect(codes(searchWaypoints("elliot nowhere", SET))).toEqual([]);
  });

  it("ignores case and accents", () => {
    expect(codes(searchWaypoints("cote", SET))).toEqual(["K05"]);
    expect(codes(searchWaypoints("CÔTE", SET))).toEqual(["K05"]);
  });

  it("keeps the file's order for equal ranks, and stops at the limit", () => {
    const many = Array.from({ length: 8 }, (_, i) => wp(`T${i}`, "Turnpoint"));
    expect(codes(searchWaypoints("turn", many))).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(searchWaypoints("turn", many, 2)).toHaveLength(2);
  });
});
