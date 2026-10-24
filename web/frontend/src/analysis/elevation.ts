/**
 * Ground-elevation lookup from Mapbox Terrain-RGB DEM tiles, for the website.
 *
 * The decoder and the sampling live in terrain-elevation.ts; read that file
 * for why the PNG is decoded by hand rather than through a canvas. What stays here is the browser's half: the inflater
 * (`DecompressionStream`) and the build's token. Still browser-only, and
 * callers import it dynamically so it stays out of the SSR bundle.
 */
import {
  decodeTerrainPng as decodeWith,
  fetchElevations as fetchWith,
  type LatLon,
  type TerrainPixels,
} from "./terrain-elevation";

export {
  decodeTerrainRgb,
  isPlausibleElevation,
  sampleElevation,
  tileForPoint,
  type LatLon,
  type TerrainPixels,
  type TilePoint,
} from "./terrain-elevation";

// Uint8Array<ArrayBuffer> (not the ArrayBufferLike default): the stream
// APIs will not take a view that might be over a SharedArrayBuffer.
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
  const inflated = source.pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

export function decodeTerrainPng(bytes: Uint8Array): Promise<TerrainPixels> {
  return decodeWith(bytes, inflate);
}

export function fetchElevations(
  points: LatLon[],
  token: string = import.meta.env.VITE_MAPBOX_TOKEN
): Promise<(number | null)[]> {
  return fetchWith(points, token, { inflate });
}
