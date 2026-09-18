import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeTerrainPng,
  decodeTerrainRgb,
  fetchElevations,
  isPlausibleElevation,
  sampleElevation,
  tileForPoint,
  type TerrainPixels,
} from "./elevation";

/** Build a Terrain-RGB pixel's three bytes from an elevation in metres. */
function rgbFor(metres: number): [number, number, number] {
  const v = Math.round((metres + 10000) / 0.1);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/** A uniform RGBA grid, with optional per-pixel overrides by [x, y]. */
function grid(
  width: number,
  height: number,
  metres: number,
  overrides: Array<[number, number, number]> = []
): TerrainPixels {
  const data = new Uint8Array(width * height * 4);
  const [r, g, b] = rgbFor(metres);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  for (const [x, y, m] of overrides) {
    const [orr, og, ob] = rgbFor(m);
    const o = (y * width + x) * 4;
    data[o] = orr;
    data[o + 1] = og;
    data[o + 2] = ob;
  }
  return { width, height, channels: 4, data };
}

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


describe("isPlausibleElevation", () => {
  it("accepts the range a waypoint can actually sit in", () => {
    expect(isPlausibleElevation(0)).toBe(true);
    expect(isPlausibleElevation(8849)).toBe(true); // Everest
    expect(isPlausibleElevation(-430)).toBe(true); // the Dead Sea, which is flown
  });

  it("rejects what a corrupt byte produces", () => {
    // The values a canvas round-trip of a 166 m coastal pixel produced at
    // partial alpha. The red channel carries 6553.6 m per step, so one step of
    // corruption is never a small error.
    expect(isPlausibleElevation(13273)).toBe(false);
    expect(isPlausibleElevation(-6413)).toBe(false);
    expect(isPlausibleElevation(-10000)).toBe(false);
    expect(isPlausibleElevation(NaN)).toBe(false);
  });

  it("cannot catch a corrupt value that happens to be a real height", () => {
    // 6720 m is what the same pixel read as at alpha 128 — and it is also a
    // perfectly ordinary Himalayan summit, so no range check can reject it.
    // This is the whole reason the fix is decoding the PNG exactly rather than
    // sanity-checking a canvas read: the guard is a backstop for the absurd
    // values, never the thing that makes the numbers right.
    expect(isPlausibleElevation(6720)).toBe(true);
  });
});

describe("sampleElevation", () => {
  it("reads flat ground as itself", () => {
    expect(sampleElevation(grid(8, 8, 742), 0.5, 0.5)).toBe(742);
  });

  it("throws out an implausible pixel instead of averaging it in", () => {
    // One pixel with the red byte one step high — the coastal-alpha failure.
    // The median of the eight good neighbours is the answer, not 6720 m.
    const g = grid(8, 8, 166, [[4, 4, 6720]]);
    expect(sampleElevation(g, 4.5 / 8, 4.5 / 8)).toBe(166);
  });

  it("returns null when nothing in the neighbourhood can be an elevation", () => {
    const g = grid(8, 8, -10000);
    expect(sampleElevation(g, 0.5, 0.5)).toBeNull();
  });

  it("holds its ground on a cliff edge, where one pixel is the sea", () => {
    // A hilltop waypoint with the shoreline cutting through its 3x3: five
    // pixels of hill, four of water. The hill is the waypoint's own ground.
    const g = grid(8, 8, 160, [
      [3, 3, 0],
      [3, 4, 0],
      [3, 5, 0],
      [4, 5, 0],
    ]);
    expect(sampleElevation(g, 4.5 / 8, 4.5 / 8)).toBe(160);
  });

  it("clamps the neighbourhood to the tile at a corner", () => {
    // Only 4 of the 9 pixels exist; the answer comes from those rather than
    // from a second tile fetch for two more samples.
    const g = grid(4, 4, 300, [[0, 0, 9999]]);
    expect(sampleElevation(g, 0, 0)).toBe(300);
  });
});

describe("decodeTerrainPng", () => {
  /** Deflate with the same platform API the decoder inflates with. */
  async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const deflated = source.pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(deflated).arrayBuffer());
  }

  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function chunk(type: string, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    let c = -1;
    for (let i = 4; i < 8 + body.length; i++) c = CRC_TABLE[(c ^ out[i]) & 0xff] ^ (c >>> 8);
    view.setUint32(8 + body.length, (c ^ -1) >>> 0);
    return out;
  }

  /** A 2x2 RGBA PNG carrying one elevation at a given alpha. */
  async function tilePng(metres: number, alpha: number): Promise<Uint8Array> {
    const size = 2;
    const [r, g, b] = rgbFor(metres);
    const raw = new Uint8Array(size * (1 + size * 4));
    for (let y = 0; y < size; y++) {
      const rowStart = y * (1 + size * 4);
      raw[rowStart] = 0; // filter: none
      for (let x = 0; x < size; x++) {
        const o = rowStart + 1 + x * 4;
        raw[o] = r;
        raw[o + 1] = g;
        raw[o + 2] = b;
        raw[o + 3] = alpha;
      }
    }
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, size);
    new DataView(ihdr.buffer).setUint32(4, size);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    const parts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", await deflate(raw)),
      chunk("IEND", new Uint8Array(0)),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const png = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      png.set(p, at);
      at += p.length;
    }
    return png;
  }

  /**
   * The regression test for the bug this decoder exists for: a partially
   * transparent pixel must read back EXACTLY. Through a canvas the same pixel
   * comes back as 6720 m at alpha 128 and -6413 m at alpha 100, because the
   * canvas stores premultiplied bytes and the red channel is 6553.6 m a step.
   * Mapbox marks the sea beyond a coastline with partial alpha, which is how a
   * Great Ocean Road waypoint was read as 13273 m.
   */
  it("reads a partially transparent pixel exactly, at every alpha", async () => {
    for (const alpha of [255, 200, 128, 100, 85, 1, 0]) {
      const pixels = await decodeTerrainPng(await tilePng(166, alpha));
      expect(pixels.channels).toBe(4);
      expect(sampleElevation(pixels, 0.5, 0.5), `alpha ${alpha}`).toBe(166);
    }
  });

  it("rejects anything that is not the tile shape we asked for", async () => {
    await expect(decodeTerrainPng(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Not a PNG/);
    // An HTML or JSON error body served with a 200 must not decode to terrain.
    await expect(
      decodeTerrainPng(new TextEncoder().encode('{"message":"Not Authorized"}'))
    ).rejects.toThrow(/Not a PNG/);
  });

  /**
   * Real Mapbox bytes. These four tiles are the ones the e2e suite records for
   * the Corryong valley, and the ranges are what an independent decode (plain
   * node:zlib, no canvas) measured from the same files — so a fault in the
   * unfiltering here shows up as a range that has moved.
   */
  describe("against the recorded Mapbox tiles", () => {
    const RECORDINGS = join(import.meta.dirname, "../../../../e2e/fixtures/mapbox-recordings");
    const cases: Array<[string, number, number]> = [
      ["v4-mapbox-terrain-rgb-13-7459-4986-2x-pngraw_9047287e96c9.png", 443.2, 945.0],
      ["v4-mapbox-terrain-rgb-13-7461-4980-2x-pngraw_b683de11b328.png", 272.9, 461.8],
      ["v4-mapbox-terrain-rgb-13-7462-4982-2x-pngraw_8177eaa66e36.png", 317.9, 879.1],
      ["v4-mapbox-terrain-rgb-13-7464-4978-2x-pngraw_3147311428c0.png", 242.4, 649.2],
    ];

    for (const [file, wantMin, wantMax] of cases) {
      it(`decodes ${file.slice(22, 34)} to real Victorian terrain`, async () => {
        const pixels = await decodeTerrainPng(new Uint8Array(readFileSync(join(RECORDINGS, file))));
        expect(pixels.width).toBe(512);
        expect(pixels.height).toBe(512);
        expect(pixels.channels).toBe(4);

        let min = Infinity;
        let max = -Infinity;
        let implausible = 0;
        for (let i = 0; i < pixels.width * pixels.height; i++) {
          const o = i * pixels.channels;
          const m = decodeTerrainRgb(pixels.data[o], pixels.data[o + 1], pixels.data[o + 2]);
          min = Math.min(min, m);
          max = Math.max(max, m);
          if (!isPlausibleElevation(m)) implausible++;
        }
        expect(min).toBeCloseTo(wantMin, 1);
        expect(max).toBeCloseTo(wantMax, 1);
        // Real terrain data has no impossible pixels. Every one we have seen
        // came from reading the tile through a canvas, not from Mapbox.
        expect(implausible).toBe(0);
      });
    }
  });
});
