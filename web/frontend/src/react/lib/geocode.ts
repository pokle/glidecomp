/**
 * Forward place search over the Mapbox Geocoding API v6.
 *
 * This exists for one moment: an organiser creates their first competition,
 * opens the route or waypoint editor, and the map shows the whole globe because
 * there is not yet a single waypoint to fit to. Typing "Manilla" is the fastest
 * way out of that.
 *
 * WHY v6 AND NOT THE SEARCH BOX API. The free allowance is 100,000 requests a
 * month, against Search Box's 500 sessions. The price of that is that v6 carries
 * NO points of interest — Mapbox moved those to Search Box — so "Manilla, New
 * South Wales" resolves and "Mount Borah" does not. That suits the job: this
 * search aims the camera at a town or a region, and the launch itself gets
 * placed by tapping the map.
 *
 * TEMPORARY TIER ONLY. The free allowance covers results that are shown to a
 * person and then thrown away. Nothing here may be cached, and a returned
 * coordinate must never be written into a waypoint or any other record —
 * storing one moves the call to the permanent tier, which has no free
 * allowance. Moving the camera is display-only, so it stays inside the terms.
 *
 * The token is the same URL-restricted `VITE_MAPBOX_TOKEN` the map uses, so a
 * new origin (a branch preview, a tunnel) needs adding to its allowlist before
 * search works there — the map will render while search 403s.
 */
import type { MapBounds } from "@/analysis/map-provider";

/** One geocoder hit, reduced to what the map and the list need. */
export interface PlaceResult {
  /** Mapbox's stable id for the feature; the ComboBox's item key. */
  id: string;
  /** The place itself, e.g. "Manilla". */
  name: string;
  /** Where it is, e.g. "New South Wales, Australia". Absent for countries. */
  context?: string;
  lat: number;
  lon: number;
  /**
   * The feature's extent, when the geocoder gives one. A town and the country
   * around it have the same centre point but nothing else in common, so fitting
   * the box beats zooming to a coordinate at a guessed level.
   */
  bounds?: MapBounds;
}

const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

/** Whether place search can run at all — false in a build with no map token. */
export const PLACE_SEARCH_AVAILABLE = Boolean(MAPBOX_ACCESS_TOKEN);

/** Shorter queries match half the planet, so they aren't worth a request. */
export const MIN_PLACE_QUERY_LENGTH = 2;

/**
 * Place-scale features only. Streets and house numbers would be noise here —
 * nobody sets up a competition by street address — and leaving them out keeps
 * the six visible rows meaningful.
 */
const PLACE_TYPES = "country,region,district,place,locality,neighborhood";

const RESULT_LIMIT = 6;

/** The v6 response, narrowed to the fields read below. */
interface GeocodeFeature {
  properties?: {
    mapbox_id?: string;
    name?: string;
    place_formatted?: string;
    full_address?: string;
    coordinates?: { longitude?: number; latitude?: number };
    /** [west, south, east, north] */
    bbox?: number[];
  };
  geometry?: { coordinates?: number[] };
  /** Older/alternate placement of the same box. */
  bbox?: number[];
}

function toBounds(bbox: number[] | undefined): MapBounds | undefined {
  if (!bbox || bbox.length !== 4) return undefined;
  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every((n) => Number.isFinite(n))) return undefined;
  return { west, south, east, north };
}

function toResult(feature: GeocodeFeature, index: number): PlaceResult | null {
  const props = feature.properties ?? {};
  const lon = props.coordinates?.longitude ?? feature.geometry?.coordinates?.[0];
  const lat = props.coordinates?.latitude ?? feature.geometry?.coordinates?.[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = props.name ?? props.full_address;
  if (!name) return null;
  return {
    // The index keeps keys unique even if Mapbox ever repeats a mapbox_id
    // within one response — a duplicate key would silently drop a row.
    id: `${props.mapbox_id ?? name}-${index}`,
    name,
    context: props.place_formatted,
    lat: lat as number,
    lon: lon as number,
    bounds: toBounds(props.bbox ?? feature.bbox),
  };
}

/**
 * Search for places matching `query`. Throws on a network or API failure so the
 * caller can say "search failed" rather than show an empty list — an outage
 * that reads as "no such place" is a wrong answer, not a missing one.
 *
 * Deliberately NOT retried: the next keystroke is already a fresh request, and
 * a retry would double the cost of a rate-limited burst.
 */
export async function searchPlaces(
  query: string,
  options: { signal?: AbortSignal; proximity?: { lat: number; lon: number } } = {},
): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!MAPBOX_ACCESS_TOKEN || q.length < MIN_PLACE_QUERY_LENGTH) return [];

  const params = new URLSearchParams({
    q,
    access_token: MAPBOX_ACCESS_TOKEN,
    types: PLACE_TYPES,
    limit: String(RESULT_LIMIT),
  });
  if (options.proximity) {
    params.set("proximity", `${options.proximity.lon},${options.proximity.lat}`);
  }

  const res = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params}`, {
    signal: options.signal,
  });
  if (!res.ok) {
    throw new Error(`Place search failed (${res.status})`);
  }
  const data = (await res.json()) as { features?: GeocodeFeature[] };
  return (data.features ?? []).map(toResult).filter((r): r is PlaceResult => r !== null);
}
