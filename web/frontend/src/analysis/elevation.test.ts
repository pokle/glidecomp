import { describe, expect, it } from "vitest";
import { decodeTerrainRgb, fetchElevations, tileForPoint } from "./elevation";

describe("decodeTerrainRgb", () => {
  it("decodes the Terrain-RGB zero point", () => {
    expect(decodeTerrainRgb(0, 0, 0)).toBe(-10000);
  });

  it("decodes sea level", () => {
    // 1*65536 + 134*256 + 160 = 100000 → -10000 + 10000 = 0
    expect(decodeTerrainRgb(1, 134, 160)).toBe(0);
  });

  it("decodes a real summit pixel", () => {
    // The z13 @2x tile pixel at Mt Kosciuszko (surveyed 2228 m) decodes to
    // 2220.1 m — verified against a live tile download.
    expect(decodeTerrainRgb(1, 221, 89)).toBeCloseTo(2220.1, 5);
  });
});

describe("tileForPoint", () => {
  it("maps the origin to the centre tile with zero offset", () => {
    const t = tileForPoint(0, 0, 13);
    expect(t).toEqual({ x: 4096, y: 4096, fx: 0, fy: 0 });
  });

  it("maps Mt Kosciuszko to its known z13 tile and pixel", () => {
    // Verified against a live tile: z13 tile 7469/4987, @2x pixel (418, 500).
    const t = tileForPoint(-36.455825, 148.263502);
    expect(t.x).toBe(7469);
    expect(t.y).toBe(4987);
    expect(Math.floor(t.fx * 512)).toBe(418);
    expect(Math.floor(t.fy * 512)).toBe(500);
  });

  it("clamps polar latitudes to valid tiles", () => {
    const north = tileForPoint(89.9, 0, 13);
    const south = tileForPoint(-89.9, 0, 13);
    expect(north.y).toBe(0);
    expect(south.y).toBe(8191);
  });

  it("normalises out-of-range longitudes", () => {
    const wrapped = tileForPoint(0, 190, 13); // = lon -170
    expect(wrapped).toEqual(tileForPoint(0, -170, 13));
    const edge = tileForPoint(0, 180, 13); // = lon -180 → first column
    expect(edge.x).toBe(0);
  });
});

describe("fetchElevations", () => {
  it("rejects when no access token is configured", async () => {
    await expect(fetchElevations([{ lat: 0, lon: 0 }], "")).rejects.toThrow(
      /access token/
    );
  });

  it("resolves an empty batch without fetching", async () => {
    await expect(fetchElevations([], "test-token")).resolves.toEqual([]);
  });
});
