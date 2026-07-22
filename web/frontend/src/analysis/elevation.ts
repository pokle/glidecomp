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
 * tile fetches. Decoding happens on an OffscreenCanvas, so this module is
 * browser-only — callers import it dynamically (it must stay out of the SSR
 * bundle).
 */

const TERRAIN_TILESET = 'mapbox.terrain-rgb';
const TILE_ZOOM = 13;
const FETCH_CONCURRENCY = 8;

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

/** Fetch one terrain tile and rasterise it for pixel reads. */
async function loadTile(x: number, y: number, token: string): Promise<ImageData> {
  const url = `https://api.mapbox.com/v4/${TERRAIN_TILESET}/${TILE_ZOOM}/${x}/${y}@2x.pngraw?access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Terrain tile ${TILE_ZOOM}/${x}/${y}: HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a 2d canvas context');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Ground elevation (metres AMSL) for each point, in input order. A point
 * whose tile can't be fetched or decoded yields `null` rather than failing
 * the whole batch; only a missing access token rejects outright.
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
      let image: ImageData;
      try {
        image = await loadTile(job.x, job.y, token);
      } catch {
        continue; // this tile's points stay null
      }
      for (const { index, fx, fy } of job.points) {
        const px = Math.min(image.width - 1, Math.floor(fx * image.width));
        const py = Math.min(image.height - 1, Math.floor(fy * image.height));
        const i = (py * image.width + px) * 4;
        results[index] = decodeTerrainRgb(image.data[i], image.data[i + 1], image.data[i + 2]);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, worker)
  );
  return results;
}
