/**
 * Which routes to offer first when an organiser copies a route from another
 * competition: the ones flown nearest this competition.
 *
 * "Near" is measured from each route's FIRST turnpoint (its take-off, in
 * practice: the point that says which hill it was flown from) to the nearest
 * point this competition already knows about: one of its waypoints, or a
 * turnpoint of one of its routes. The nearest point, not a centre: a regional
 * waypoint file can cover 300 km, and a route flown at its far edge is as much
 * "here" as one in the middle.
 *
 * It orders the list. It never filters it: a competition at a new site has
 * nothing near it, and its organiser may still want last year's route from
 * the old one. With no points at all, the list is simply newest first.
 *
 * Distances are WGS84 geodesics (geo.ts), as everywhere in GlideComp. They
 * score nothing: they are a sort key and a "12 km away" for the reader.
 */
import { chordLowerBound, ecefOnEllipsoid, ellipsoidDistance, type EcefPoint } from "@glidecomp/engine";

export interface LatLon {
  lat: number;
  lon: number;
}

interface RefPoint extends LatLon {
  ecef: EcefPoint;
}

/** Points that mean the same place, for the purpose of a sort key. */
function placeKey(p: LatLon): string {
  // 1e-4 degrees is about 11 m.
  return `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
}

/** Usable coordinates, or null for anything a stored row should not hold. */
export function asLatLon(lat: unknown, lon: unknown): LatLon | null {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * A function giving the geodesic distance (m) from a point to the nearest of
 * `refs`, or null when there are no refs. Repeated places are measured once.
 *
 * Exact, not approximate: the straight-line chord through the ellipsoid is a
 * lower bound on the geodesic (geo.ts `chordLowerBound`), so after measuring
 * the point with the shortest chord, only points whose chord is shorter than
 * that geodesic can be nearer, and only those get a Vincenty call.
 */
export function nearestDistance(refs: LatLon[]): ((p: LatLon) => number) | null {
  const unique = new Map<string, RefPoint>();
  for (const r of refs) {
    const key = placeKey(r);
    if (!unique.has(key)) unique.set(key, { ...r, ecef: ecefOnEllipsoid(r.lat, r.lon) });
  }
  const points = [...unique.values()];
  if (points.length === 0) return null;

  const memo = new Map<string, number>();
  return (p: LatLon) => {
    const key = placeKey(p);
    const known = memo.get(key);
    if (known !== undefined) return known;

    const here = ecefOnEllipsoid(p.lat, p.lon);
    const chords = points.map((r) => chordLowerBound(here, r.ecef));
    let first = 0;
    for (let i = 1; i < chords.length; i++) if (chords[i] < chords[first]) first = i;
    let best = ellipsoidDistance(p.lat, p.lon, points[first].lat, points[first].lon);
    for (let i = 0; i < points.length; i++) {
      if (i === first || chords[i] >= best) continue;
      const d = ellipsoidDistance(p.lat, p.lon, points[i].lat, points[i].lon);
      if (d < best) best = d;
    }
    memo.set(key, best);
    return best;
  };
}

/** A route the picker may offer, before it is ordered. */
export interface RouteCandidate {
  task_id: number;
  task_date: string;
  /** The route's first turnpoint, or null when the stored route has none. */
  start: LatLon | null;
}

/**
 * Order candidates: nearest first when there are reference points (a route
 * with no usable first turnpoint goes last), newest first among equals and
 * when there are none. Returns each with its distance (null when unknown).
 */
export function orderCandidates<T extends RouteCandidate>(
  candidates: T[],
  refs: LatLon[]
): Array<T & { distance_m: number | null }> {
  const measure = nearestDistance(refs);
  const withDistance = candidates.map((cand) => ({
    ...cand,
    distance_m: measure && cand.start ? measure(cand.start) : null,
  }));
  const newestFirst = (a: T, b: T) =>
    b.task_date.localeCompare(a.task_date) || b.task_id - a.task_id;
  return withDistance.sort((a, b) => {
    if (measure) {
      if (a.distance_m === null && b.distance_m !== null) return 1;
      if (b.distance_m === null && a.distance_m !== null) return -1;
      if (a.distance_m !== null && b.distance_m !== null && a.distance_m !== b.distance_m) {
        // Within a kilometre is the same place for this purpose: newest
        // first among them, so this year's version of a route comes before
        // last year's.
        const ka = Math.round(a.distance_m / 1000);
        const kb = Math.round(b.distance_m / 1000);
        if (ka !== kb) return ka - kb;
      }
    }
    return newestFirst(a, b);
  });
}
