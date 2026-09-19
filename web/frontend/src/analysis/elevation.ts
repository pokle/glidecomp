/**
 * Ground-elevation lookup from Mapbox Terrain-RGB DEM tiles.
 *
 * Used by the waypoints editor to fill in altitudes that the uploaded
 * waypoint file didn't carry. We deliberately do NOT read elevations off the
 * live map (`map.queryTerrainElevation`): that only answers for DEM tiles the
 * current viewport happens to have loaded, at the viewport's zoom — a map
 * fitted to a whole comp sits around z8–9, where the DEM runs 150–300 m per
 * pixel and ridge-top waypoints read low by tens of metres. Instead we fetch
 * the Terrain-RGB tiles ourselves at a fixed high zoom with the same access
 * token, so every point gets the same ~10 m-per-pixel answer regardless of
 * what the map is showing.
 *
 * Tiles are 512 px `@2x` tiles at z13 (equivalent grid to z14@256 — about
 * 9.5·cos(lat) m/pixel), deduplicated per request: clustered waypoints share
 * tile fetches.
 *
 * ## Why this decodes the PNG itself instead of using a canvas
 *
 * A Terrain-RGB pixel is a 24-bit NUMBER spread across three bytes, and these
 * tiles are RGBA — Mapbox marks no-data, including the sea beyond a coastline,
 * with partial alpha. A canvas stores premultiplied 8-bit RGBA, so drawing
 * such a pixel and reading it back does not round-trip: the RGB payload is
 * multiplied by alpha on the way in and divided by it on the way out, and what
 * survives is the nearest byte. `premultiplyAlpha: 'none'` does not help,
 * because the loss is in the canvas, not the decoder.
 *
 * That is not a rounding nuisance. The red byte carries 6553.6 m per step, so
 * a single step of premultiplication error reads as kilometres. Measured, for
 * a real 166 m coastal hill:
 *
 * | alpha | read back |
 * |-------|-----------|
 * | 255   | 166 m     |
 * | 200   | 192 m     |
 * | 128   | 6720 m    |
 * | 100   | -6413 m   |
 * | 0     | -10000 m  |
 *
 * A waypoint on the Great Ocean Road came back as 13273 m this way, and the
 * editor offered to write it into the waypoint file. So the PNG is inflated
 * and unfiltered here instead, which is exact by construction — no canvas, no
 * premultiplication and no colour management can touch the bytes. It also
 * makes this path unit-testable against a real recorded tile, which the canvas
 * version could not be, and drops the OffscreenCanvas requirement.
 *
 * Still browser-only (`DecompressionStream`), and callers import it
 * dynamically so it stays out of the SSR bundle.
 */

const TERRAIN_TILESET = 'mapbox.terrain-rgb';
const TILE_ZOOM = 13;
const FETCH_CONCURRENCY = 8;

/**
 * The range a GROUND ELEVATION can possibly fall in, in metres AMSL.
 *
 * Everest is 8849 m and the lowest dry land is the Dead Sea shore at about
 * -430 m (which people do fly), so this is generous at both ends and still
 * rejects anything that is not an elevation at all.
 *
 * It has to be checked, because one wrong byte in a Terrain-RGB pixel is not a
 * small error: the red channel carries 6553.6 m per step, so a single bit of
 * corruption reads as kilometres. A coastal waypoint on this project's own
 * Great Ocean Road competition came back as 13273 m — the app printed it and
 * offered to write it into the waypoint file. Whatever produces a bad byte,
 * this module's contract is "metres AMSL, or null", and 13273 m is neither.
 */
const MIN_PLAUSIBLE_ELEVATION_M = -500;
const MAX_PLAUSIBLE_ELEVATION_M = 9000;

/** Whether a decoded pixel can be a ground elevation at all. */
export function isPlausibleElevation(metres: number): boolean {
  return (
    Number.isFinite(metres) &&
    metres >= MIN_PLAUSIBLE_ELEVATION_M &&
    metres <= MAX_PLAUSIBLE_ELEVATION_M
  );
}

export interface LatLon {
  lat: number;
  lon: number;
}

export interface TilePoint {
  /** Slippy-map tile x/y at `zoom`. */
  x: number;
  y: number;
  /** Position within the tile, each in [0, 1). Multiply by the tile's pixel
   *  size (which varies: 256 plain, 512 @2x) to get pixel coordinates. */
  fx: number;
  fy: number;
}

/**
 * Web-Mercator (slippy) tile containing a coordinate, plus the fractional
 * position inside that tile. Latitude is clamped to the Mercator limits and
 * longitude normalised, so any real-world coordinate maps to a valid tile.
 */
export function tileForPoint(lat: number, lon: number, zoom: number = TILE_ZOOM): TilePoint {
  const n = 2 ** zoom;
  // Normalise longitude to [-180, 180) so out-of-range inputs still land on a tile.
  const lonNorm = ((((lon + 180) % 360) + 360) % 360) - 180;
  const xf = ((lonNorm + 180) / 360) * n;
  const latRad = (Math.max(-85.051128, Math.min(85.051128, lat)) * Math.PI) / 180;
  const yf = Math.min(
    n - 1e-9,
    Math.max(0, ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  );
  const x = Math.min(n - 1, Math.floor(xf));
  const y = Math.floor(yf);
  return { x, y, fx: xf - x, fy: yf - y };
}

/** Decode one Terrain-RGB pixel to metres AMSL. */
export function decodeTerrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1;
}

/** A decoded tile: raw 8-bit samples, `channels` per pixel, row-major. */
export interface TerrainPixels {
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. Mapbox ships RGBA. */
  channels: number;
  data: Uint8Array;
}

/**
 * Inflate a zlib stream with the platform's own decompressor.
 *
 * Fed from a ReadableStream rather than a Blob: Blob is the one part of this
 * that a non-browser environment is likely to implement only partly, and
 * nothing here needs it.
 */
// Uint8Array<ArrayBuffer> (not the ArrayBufferLike default): the stream
// APIs will not take a view that might be over a SharedArrayBuffer.
async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const inflated = source.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Decode an 8-bit, non-interlaced truecolour PNG (colour type 2 or 6) to its
 * raw samples.
 *
 * That is the only shape Mapbox's `.pngraw` terrain tiles come in, and the
 * only one worth supporting: anything else throws, which the caller turns into
 * "no elevation here" rather than a wrong one. Deliberately not a general PNG
 * decoder — palettes, 16-bit samples, interlacing and greyscale are all absent
 * because reading a DEM never needs them.
 */
export async function decodeTerrainPng(bytes: Uint8Array): Promise<TerrainPixels> {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('Not a PNG');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
    );
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const depth = body[8];
      const colourType = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`Unsupported PNG: depth ${depth}, colour ${colourType}, interlace ${interlace}`);
      }
      channels = colourType === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    // 4 length + 4 type + body + 4 CRC. The CRC is not checked: a corrupt
    // tile decodes to implausible elevations, which are rejected downstream.
    offset += 12 + length;
  }
  if (!width || !height || !channels || idat.length === 0) throw new Error('PNG has no image data');

  const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  const raw = await inflate(joined);

  // Undo the per-row filters (PNG spec §9.2). Each row is prefixed with its
  // filter type and predicted from the bytes to its left (a) and above (b).
  //
  // The filter is chosen once per ROW rather than per byte: a `switch` inside
  // the inner loop would re-decide it a million times a tile, and reads as
  // though it could change mid-row.
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is short');
  const out = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    if (filter > 4) throw new Error(`Unknown PNG row filter ${filter}`);
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      if (filter === 0) {
        out[rowStart + x] = value & 0xff;
        continue;
      }
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      let predicted: number;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else {
        // Paeth: whichever of the three neighbours the linear prediction
        // a + b - c lands nearest to.
        const c = x >= channels && y > 0 ? out[prevStart + x - channels] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[rowStart + x] = (value + predicted) & 0xff;
    }
    src += stride;
  }
  return { width, height, channels, data: out };
}

/** Fetch one terrain tile and decode it for pixel reads. */
async function loadTile(x: number, y: number, token: string): Promise<TerrainPixels> {
  const url = `https://api.mapbox.com/v4/${TERRAIN_TILESET}/${TILE_ZOOM}/${x}/${y}@2x.pngraw?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Terrain tile ${TILE_ZOOM}/${x}/${y}: HTTP ${res.status}`);
  return decodeTerrainPng(new Uint8Array(await res.arrayBuffer()));
}

/**
 * Read one point's elevation as the MEDIAN of the 3x3 pixels around it,
 * counting only pixels that can be an elevation at all.
 *
 * Two reasons not to trust the single nearest pixel:
 *
 *  - **A corrupt pixel is a kilometres-wide error**, not a small one (see
 *    isPlausibleElevation). Dropping the implausible ones before taking a
 *    median means one bad byte cannot become the answer.
 *  - **A waypoint sits on a hilltop or a cliff edge**, which is where a ~10 m
 *    DEM grid is least stable: a pixel either side of a coastal escarpment
 *    differs by the height of the escarpment. A median of the neighbourhood is
 *    the standard robust read, and at z13 the 3x3 spans about 30 m — still the
 *    waypoint's own ground rather than the next valley's.
 *
 * The neighbourhood is clamped to the tile, so a point within a pixel of a
 * tile edge is read from the pixels that ARE here rather than by fetching a
 * second tile for two more samples. Returns null when nothing in the
 * neighbourhood is plausible.
 */
export function sampleElevation(image: TerrainPixels, fx: number, fy: number): number | null {
  const cx = Math.min(image.width - 1, Math.floor(fx * image.width));
  const cy = Math.min(image.height - 1, Math.floor(fy * image.height));
  const found: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const i = (py * image.width + px) * image.channels;
      const metres = decodeTerrainRgb(image.data[i], image.data[i + 1], image.data[i + 2]);
      if (isPlausibleElevation(metres)) found.push(metres);
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a - b);
  const mid = found.length >> 1;
  const median = found.length % 2 ? found[mid] : (found[mid - 1] + found[mid]) / 2;
  return median;
}

/**
 * Ground elevation (metres AMSL) for each point, in input order. A point
 * whose tile can't be fetched or decoded yields `null` rather than failing
 * the whole batch; so does one whose pixels cannot be an elevation. Only a
 * missing access token rejects outright.
 */
export async function fetchElevations(
  points: LatLon[],
  token: string = import.meta.env.VITE_MAPBOX_TOKEN
): Promise<(number | null)[]> {
  if (!token) throw new Error('Mapbox access token is not configured');
  const results: (number | null)[] = new Array(points.length).fill(null);

  // Group the points by tile so clustered waypoints share one fetch.
  const tiles = new Map<string, { x: number; y: number; points: { index: number; fx: number; fy: number }[] }>();
  points.forEach((p, index) => {
    const t = tileForPoint(p.lat, p.lon);
    const key = `${t.x}/${t.y}`;
    let entry = tiles.get(key);
    if (!entry) {
      entry = { x: t.x, y: t.y, points: [] };
      tiles.set(key, entry);
    }
    entry.points.push({ index, fx: t.fx, fy: t.fy });
  });

  const queue = [...tiles.values()];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      let image: TerrainPixels;
      try {
        image = await loadTile(job.x, job.y, token);
      } catch {
        continue; // this tile's points stay null
      }
      for (const { index, fx, fy } of job.points) {
        results[index] = sampleElevation(image, fx, fy);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker)
  );
  return results;
}
