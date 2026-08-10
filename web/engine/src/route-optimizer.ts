/**
 * S7F 2026 §7.1 route optimisation — the normative algorithm set:
 *
 * - GeodesicToCartesian / CartesianToGeodesic (§7.1.2, Annex A): a localised
 *   Transverse Mercator projection (LTM) centred on the task area, with the
 *   latitude-dependent scaling of §7.1.2. Translated from Annex A's
 *   "alternative implementation" (Daniel Dimov's Java, MIT-licensed), for
 *   systems without PROJ.
 * - PathFinder (§7.1.3): the shortest-path algorithm of Ding, Xie & Jiang
 *   (2018) — block coordinate descent with the odd/even sweep schedule and
 *   the reflection/crossing case split — extended to linear control zones
 *   per Annex B. Runs in the Cartesian plane, ε = 0.1 m.
 * - FindTaskAreaCentre (§7.1.6), with FindBoundingBox (§7.1.6.1) and
 *   FindCentrePointOfBox (§7.1.6.2), including their antimeridian handling.
 * - ProjectionCorrection (§7.1.7): the WGS84 projections of PathFinder's
 *   path points are snapped back onto their control-zone boundaries with
 *   InverseGeodesic + DirectGeodesic, so no projection distortion survives
 *   into the distance sum.
 * - RouteOptimizer (§7.1.8): the composition — project, PathFinder,
 *   unproject, correct, then sum EllipsoidDistance over the corrected path.
 *
 * The reference texts live in the repository:
 * docs/reference/fai-s7f-xc-scoring-2026/ (§7.1 + Annexes A and B) and
 * docs/reference/ding-2018-touring-n-circles/ (the PathFinder paper, with
 * an audit of its pseudocode). Two places the printed sources are followed
 * "as analysed, not as printed":
 *
 * - Ding et al.'s GetoptPi pseudocode contradicts the paper's own §3.1–§3.2
 *   analysis (its line 3 tests the tangent-apex point, and its lines 7–9
 *   invert the one-in-one-out case). This implementation follows the
 *   analysis: both neighbours strictly inside → reflection; otherwise a
 *   segment–circle intersection is the crossing case, and no intersection →
 *   reflection. See the audit in the transcription's companion document.
 * - §7.1.7 prints InverseGeodesic(point_i, element.point) but then walks
 *   DirectGeodesic from the element's CENTRE — the azimuth that makes that
 *   land beside the path point is centre→point, which is what is used here.
 *
 * Everything here is task-shape agnostic: FAI placement rules (launch
 * centre, ESS pin, goal handling) are the caller's business — see
 * task-optimizer.ts, which owns the route construction.
 */

import { ellipsoidDistance, inverseGeodesic, destinationPoint } from './geo';

/** A geographic point in this module's (lat, lon) degree convention. */
export type GeoPoint = { lat: number; lon: number };

/**
 * A control zone of the §7.1.1 geodesicRouteDefinition. A cylinder with
 * radius 0 is a fixed point (the path must pass through its centre). A
 * `pinned` cylinder's path point is the boundary point nearest the
 * PRECEDING path point, ignoring whatever follows — the caller's mechanism
 * for the mid-route ESS pin (see task-optimizer.ts).
 */
export type GeodesicRouteElement =
  | { kind: 'cylinder'; center: GeoPoint; radius: number; pinned?: boolean }
  | { kind: 'line'; point1: GeoPoint; point2: GeoPoint };

/**
 * §7.1.1 geodesicRouteDefinition: a fixed start point, control zones in
 * order, and optionally a fixed end point. `endPoint` is omitted when the
 * final element itself terminates the route (a goal LINE, whose path point
 * is the closest point on the line per Annex B.1.2 — there is nothing
 * beyond it to optimise against).
 */
export interface GeodesicRouteDefinition {
  startPoint: GeoPoint;
  elements: GeodesicRouteElement[];
  endPoint?: GeoPoint;
}

/* ------------------------------------------------------------------ *
 * §7.1.2 / Annex A — the LTM projection
 * ------------------------------------------------------------------ */

/** A prepared LTM projection about a task-area centre point. */
export interface LtmProjection {
  center: GeoPoint;
  /** GeodesicToCartesian (§7.1.2): WGS84 degrees → metres east/north of the centre. */
  toCartesian(lat: number, lon: number): { x: number; y: number };
  /** CartesianToGeodesic (§7.1.2): metres east/north of the centre → WGS84 degrees. */
  toGeodesic(x: number, y: number): GeoPoint;
}

/**
 * §7.1.2's latitude-dependent scale factor. Below |lat| = 55° the scaling is
 * a constant 0.99994; above, it grows linearly so the projection stays
 * accurate at high latitudes. (Annex A's two samples disagree on whether 55°
 * itself takes the constant; the formulas agree on the value there, so the
 * boundary choice is immaterial.)
 */
export function ltmScaling(centerLat: number): number {
  const la = Math.abs(centerLat);
  return la <= 55 ? 0.99994 : 0.99994 + ((la - 55) / 60) * 1.3e-4;
}

// Annex A.2 constants (Dimov). K1 is e'² (the second eccentricity squared,
// as √e'² = 0.0820944379); the 6399593.62x figures are the polar radius of
// curvature c = a²/b. Values kept exactly as printed in the annex.
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const LTM_K1 = 0.0820944379 * 0.0820944379;
const LTM_K1_2 = LTM_K1 / 2.0;
const LTM_E2 = 0.006739496742;
const LTM_K2 = LTM_E2 / 2.0;

/**
 * Build the two §7.1.2 converters about a centre point (Annex A.2's
 * CoordinateConverter). Valid for |lat| ≤ 80 and points within ~2° of the
 * centre — comfortably beyond the 100 km the spec promises accuracy for.
 */
export function createLtmProjection(centerLat: number, centerLon: number): LtmProjection {
  if (centerLat < -80 || centerLat > 80) {
    throw new Error(`LTM centre latitude out of range [-80, 80]: ${centerLat}`);
  }
  const scaling = ltmScaling(centerLat);
  const centerMeridian = centerLon;
  const centerMeridianR = centerLon * D2R;

  // Raw transverse-Mercator northing/easting about the centre meridian
  // (before the centre-northing shift that puts (0,0) at the centre point).
  const rawToCartesian = (latr: number, lonr: number): { x: number; y: number } => {
    const cla = Math.cos(latr);
    const cla2 = cla * cla;
    const s2la = Math.sin(2.0 * latr);
    const sdlo = Math.sin(lonr - centerMeridianR);
    const t = 0.5 * Math.log((1.0 + cla * sdlo) / (1.0 - cla * sdlo));
    const easting =
      (t * scaling * 6399593.62) / Math.sqrt(1.0 + LTM_K1 * cla2) *
      (1.0 + (LTM_K1_2 * t * t * cla2) / 3.0);
    const u = (3.0 * (latr + s2la / 2.0) + s2la * cla2) / 4.0;
    const northing =
      ((Math.atan(Math.tan(latr) / Math.cos(lonr - centerMeridianR)) - latr) *
        scaling * 6399593.625) /
        Math.sqrt(1.0 + LTM_E2 * cla2) *
        (1.0 + LTM_K2 * t * t * cla2) +
      scaling * 6399593.625 *
        (latr -
          0.005054622556 * (latr + s2la / 2.0) +
          4.258201531e-5 * u -
          (1.674057895e-7 * (5.0 * u + s2la * cla2 * cla2)) / 3.0);
    return { x: easting, y: northing };
  };

  const centerNorthing = rawToCartesian(centerLat * D2R, centerLon * D2R).y;

  return {
    center: { lat: centerLat, lon: centerLon },
    toCartesian(lat: number, lon: number): { x: number; y: number } {
      let l = lon;
      if (centerMeridian > 176.0 && lon < 0.0) l = lon + 360.0;
      if (centerMeridian < -176.0 && lon > 0.0) l = lon - 360.0;
      const p = rawToCartesian(lat * D2R, l * D2R);
      return { x: p.x, y: p.y - centerNorthing };
    },
    toGeodesic(x: number, y: number): GeoPoint {
      const northing = centerNorthing + y;
      const north = Math.abs(northing);
      const k1 = north / 6366197.724 / scaling;
      const ck1 = Math.cos(k1);
      const ck1_2 = ck1 * ck1;
      const k1a = LTM_E2 * ck1_2;
      const k1b = (LTM_E2 * 3.0) / 4.0;
      const s2k1 = Math.sin(2.0 * k1);
      const k2 = Math.sqrt(1 + k1a);
      const k3 = (scaling * 6399593.625) / k2;
      const k3a = x / k3;
      const k3b = (k1a * k3a * k3a) / 2.0;
      const k4 = 1.0 - k3b;
      const k5 = 1.0 - k3b / 3.0;
      const k6 = 3.0 * (k1 + s2k1 / 2.0) + s2k1 * ck1_2;
      const k7 =
        ((north -
          scaling * 6399593.625 *
            (k1 -
              k1b * (k1 + s2k1 / 2.0) +
              (k1b * k1b * k6 * 5.0) / 3.0 / 4.0 -
              (((k1b * k1b * k1b * 35.0) / 27.0) *
                ((k6 * 5.0) / 4.0 + s2k1 * ck1_2 * ck1_2)) / 3.0)) /
          k3) *
          k4 +
        k1;
      const lonr = Math.atan(
        (Math.exp((x / k3) * k5) - Math.exp((-x / k3) * k5)) / 2.0 / Math.cos(k7)
      );
      const k10 = Math.atan(Math.cos(lonr) * Math.tan(k7)) - k1;
      const latr =
        k1 + (1.0 + k1a - ((LTM_E2 * Math.sin(k1) * ck1 * k10 * 3.0) / 2.0)) * k10;
      let lon = (lonr + centerMeridianR) * R2D;
      if (lon > 180) lon -= 360;
      if (lon <= -180) lon += 360;
      return { lat: (northing < 0.0 ? -latr : latr) * R2D, lon };
    },
  };
}

/* ------------------------------------------------------------------ *
 * §7.1.3 / Annex B — PathFinder, in the Cartesian plane
 * ------------------------------------------------------------------ */

/** §7.1.3: iterate until the path length changes by no more than 10 cm. */
export const PATHFINDER_EPSILON_M = 0.1;

type XY = { x: number; y: number };

type CartesianElement =
  | { kind: 'cylinder'; x: number; y: number; radius: number; pinned?: boolean }
  | { kind: 'line'; p1: XY; p2: XY };

function planarDistance(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * First intersection of segment A→B with the circle, as the smallest
 * t ∈ [0, 1], or null when the segment misses. Ding et al.'s crossing case
 * takes "the first point of intersection of line p_{i−1}p_{i+1} and circle".
 */
function firstSegmentCircleIntersection(
  a: XY,
  b: XY,
  cx: number,
  cy: number,
  r: number
): number | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - cx;
  const fy = a.y - cy;
  const qa = dx * dx + dy * dy;
  const qc = fx * fx + fy * fy - r * r;
  if (qa === 0) return Math.abs(qc) < 1e-9 ? 0 : null;
  const qb = 2 * (fx * dx + fy * dy);
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t1 = (-qb - sq) / (2 * qa);
  const t2 = (-qb + sq) / (2 * qa);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2; // A inside the circle: t1 is behind it
  return null;
}

/**
 * The reflection situation: the boundary point minimising |A−P| + |P−B|.
 * The cost over the angle can carry TWO local minima (the path may round
 * the circle on either side — the reason Ding et al.'s closed-form PCP
 * enumerates eight candidates), so a coarse scan locates the global basin
 * before golden-section refines within it.
 */
function reflectionPoint(a: XY, b: XY, cx: number, cy: number, r: number): XY {
  const at = (theta: number): XY => ({
    x: cx + r * Math.cos(theta),
    y: cy + r * Math.sin(theta),
  });
  const cost = (theta: number): number => {
    const p = at(theta);
    return planarDistance(a, p) + planarDistance(p, b);
  };

  const SAMPLES = 96;
  let bestTheta = 0;
  let bestCost = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const theta = (i / SAMPLES) * 2 * Math.PI;
    const c = cost(theta);
    if (c < bestCost) {
      bestCost = c;
      bestTheta = theta;
    }
  }

  const step = (2 * Math.PI) / SAMPLES;
  let lo = bestTheta - step;
  let hi = bestTheta + step;
  const resphi = 2 - (1 + Math.sqrt(5)) / 2;
  let x1 = lo + resphi * (hi - lo);
  let x2 = hi - resphi * (hi - lo);
  let f1 = cost(x1);
  let f2 = cost(x2);
  // 48 golden-section steps shrink the 2·(2π/96) bracket below 1e-10 rad —
  // sub-millimetre placement at any competition cylinder radius.
  for (let i = 0; i < 48 && hi - lo > 1e-12; i++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = lo + resphi * (hi - lo);
      f1 = cost(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = hi - resphi * (hi - lo);
      f2 = cost(x2);
    }
  }
  return at((lo + hi) / 2);
}

/**
 * GetoptPi (Ding et al., Algorithm 1) for one circle, following the paper's
 * §3.1–§3.2 analysis (its printed pseudocode contradicts it — see the module
 * doc): both neighbours strictly inside → reflection; otherwise a segment
 * intersection is the crossing case; no intersection → reflection.
 */
function circleTag(a: XY, b: XY, el: CartesianElement & { kind: 'cylinder' }): XY {
  const r = el.radius;
  if (r <= 0) return { x: el.x, y: el.y };
  const dA = Math.hypot(a.x - el.x, a.y - el.y);
  const dB = Math.hypot(b.x - el.x, b.y - el.y);
  if (!(dA < r && dB < r)) {
    const t = firstSegmentCircleIntersection(a, b, el.x, el.y, r);
    if (t !== null) {
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    }
  }
  return reflectionPoint(a, b, el.x, el.y, r);
}

/**
 * The boundary point nearest an outside (or inside) point — the pinned and
 * terminal cylinder placement. Degenerate direction (point at the centre)
 * falls back to due east; the choice is arbitrary and the cost identical.
 */
function nearestOnCircle(a: XY, el: CartesianElement & { kind: 'cylinder' }): XY {
  if (el.radius <= 0) return { x: el.x, y: el.y };
  const dx = a.x - el.x;
  const dy = a.y - el.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return { x: el.x + el.radius, y: el.y };
  return { x: el.x + (dx / d) * el.radius, y: el.y + (dy / d) * el.radius };
}

/** Closest point on segment p1–p2 from a (Annex B.1.2's processLine). */
function closestPointOnSegment(a: XY, p1: XY, p2: XY): XY {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: p1.x, y: p1.y };
  let t = ((a.x - p1.x) * dx + (a.y - p1.y) * dy) / len2;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return { x: p1.x + t * dx, y: p1.y + t * dy };
}

/** Proper intersection of segments a1–a2 and b1–b2, or null. */
function segmentSegmentIntersection(a1: XY, a2: XY, b1: XY, b2: XY): XY | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null; // parallel or collinear: endpoint case decides
  const s = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
  if (s < 0 || s > 1 || u < 0 || u > 1) return null;
  return { x: a1.x + s * d1x, y: a1.y + s * d1y };
}

/**
 * Annex B.1.1 — the optimal point on a line control zone in the middle of
 * the route: the A–B crossing if there is one; else the crossing of A–B′
 * (B reflected over the line); else the cheaper endpoint.
 */
function lineTag(a: XY, b: XY, el: CartesianElement & { kind: 'line' }): XY {
  const { p1, p2 } = el;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: p1.x, y: p1.y };

  const direct = segmentSegmentIntersection(a, b, p1, p2);
  if (direct) return direct;

  // Reflect B over the infinite line through p1–p2.
  const t = ((b.x - p1.x) * dx + (b.y - p1.y) * dy) / len2;
  const footX = p1.x + t * dx;
  const footY = p1.y + t * dy;
  const reflected = { x: 2 * footX - b.x, y: 2 * footY - b.y };
  const mirrored = segmentSegmentIntersection(a, reflected, p1, p2);
  if (mirrored) return mirrored;

  const costP1 = planarDistance(a, p1) + planarDistance(p1, b);
  const costP2 = planarDistance(a, p2) + planarDistance(p2, b);
  return costP1 <= costP2 ? { x: p1.x, y: p1.y } : { x: p2.x, y: p2.y };
}

function initialTag(el: CartesianElement): XY {
  if (el.kind === 'cylinder') return { x: el.x, y: el.y };
  return { x: (el.p1.x + el.p2.x) / 2, y: (el.p1.y + el.p2.y) / 2 };
}

/**
 * PathFinder (§7.1.3): the shortest path from `start` via the control zones
 * to `end`, in the plane. Returns one path point per element. `end` is null
 * when the final element terminates the route (see
 * {@link GeodesicRouteDefinition}); that element's point is then placed by
 * the incoming leg alone.
 *
 * The sweep schedule is the paper's: update every odd-numbered circle with
 * the even ones held fixed, then the evens with the odds fixed, until a full
 * round moves the path length by no more than ε = 0.1 m. The iteration cap
 * is a safety net far above what any real task needs — block coordinate
 * descent's length is monotone non-increasing, so the ε test terminates.
 */
function pathFinder(start: XY, elements: CartesianElement[], end: XY | null): XY[] {
  const n = elements.length;
  if (n === 0) return [];
  const tags: XY[] = elements.map(initialTag);

  const solve = (i: number): XY => {
    const el = elements[i];
    const a = i === 0 ? start : tags[i - 1];
    const b = i === n - 1 ? end : tags[i + 1];
    if (el.kind === 'cylinder') {
      if (el.pinned || b === null) return nearestOnCircle(a, el);
      return circleTag(a, b, el);
    }
    if (b === null) return closestPointOnSegment(a, el.p1, el.p2);
    return lineTag(a, b, el);
  };

  const pathLength = (): number => {
    let len = planarDistance(start, tags[0]);
    for (let i = 1; i < n; i++) len += planarDistance(tags[i - 1], tags[i]);
    if (end) len += planarDistance(tags[n - 1], end);
    return len;
  };

  let prevLen = Infinity;
  const maxRounds = 50 + n * 10;
  for (let round = 0; round < maxRounds; round++) {
    for (let i = 0; i < n; i += 2) tags[i] = solve(i); // odd circles (1-based)
    for (let i = 1; i < n; i += 2) tags[i] = solve(i); // even circles
    const len = pathLength();
    if (Math.abs(prevLen - len) <= PATHFINDER_EPSILON_M) break;
    prevLen = len;
  }
  return tags;
}

/* ------------------------------------------------------------------ *
 * §7.1.6 — FindTaskAreaCentre
 * ------------------------------------------------------------------ */

/**
 * §7.1.6.1 FindBoundingBox: the smallest lat/lon rectangle containing the
 * points. Longitudes are normalised to (−180, 180] and the antimeridian is
 * handled by the spec's largest-gap rule: when the biggest gap between
 * adjacent sorted longitudes exceeds 180°, the box wraps through ±180 (its
 * SW longitude is then numerically greater than its NE longitude).
 */
export function findBoundingBox(points: GeoPoint[]): { sw: GeoPoint; ne: GeoPoint } {
  if (points.length === 0) throw new Error('findBoundingBox: no points');
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  // Longitudes already in (−180, 180] are kept bit-exact — the modulo
  // arithmetic is for out-of-range inputs only (it costs ~1e-13° of noise).
  const normalized = points
    .map((p) =>
      p.lon > 180 || p.lon <= -180 ? ((((p.lon + 180) % 360) + 360) % 360) - 180 : p.lon
    )
    .sort((a, b) => a - b);
  let maxGap = -Infinity;
  let maxGapIndex = -1;
  for (let i = 1; i < normalized.length; i++) {
    const gap = normalized[i] - normalized[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      maxGapIndex = i;
    }
  }
  let minLon: number;
  let maxLon: number;
  if (maxGap > 180) {
    minLon = normalized[maxGapIndex];
    maxLon = normalized[maxGapIndex - 1];
  } else {
    minLon = normalized[0];
    maxLon = normalized[normalized.length - 1];
  }
  return { sw: { lat: minLat, lon: minLon }, ne: { lat: maxLat, lon: maxLon } };
}

/** §7.1.6.2 FindCentrePointOfBox, wrapping through the antimeridian when the box does. */
export function findCentrePointOfBox(box: { sw: GeoPoint; ne: GeoPoint }): GeoPoint {
  const lat = (box.sw.lat + box.ne.lat) / 2;
  let lon: number;
  if (box.sw.lon > box.ne.lon) {
    lon = ((box.sw.lon + box.ne.lon + 360) / 2) % 360;
    if (lon > 180) lon -= 360;
  } else {
    lon = (box.sw.lon + box.ne.lon) / 2;
  }
  return { lat, lon };
}

/** Every WGS84 point a route definition names: start, centres, line endpoints, end. */
function definitionPoints(route: GeodesicRouteDefinition): GeoPoint[] {
  const points: GeoPoint[] = [route.startPoint];
  for (const el of route.elements) {
    if (el.kind === 'cylinder') points.push(el.center);
    else points.push(el.point1, el.point2);
  }
  if (route.endPoint) points.push(route.endPoint);
  return points;
}

/**
 * §7.1.6 FindTaskAreaCentre: a provisional centre from the route
 * definition's own bounding box, one PathFinder solve about it, and the
 * final centre from the corrected path's bounding box. Compute once per
 * task and reuse for every projection of that task's routes — including
 * the §9.3 per-fix remaining-distance routes (task-optimizer.ts caches it).
 */
export function findTaskAreaCentre(route: GeodesicRouteDefinition): GeoPoint {
  const provisional = findCentrePointOfBox(findBoundingBox(definitionPoints(route)));
  const projection = createLtmProjection(provisional.lat, provisional.lon);
  const path = optimizePath(route, projection);
  return findCentrePointOfBox(findBoundingBox(path));
}

/* ------------------------------------------------------------------ *
 * §7.1.7 — ProjectionCorrection
 * ------------------------------------------------------------------ */

/**
 * §7.1.7 ProjectionCorrection: move each control zone's path point onto the
 * zone's true WGS84 boundary — for a cylinder, the boundary point on the
 * centre→point geodesic; for a line, the point's geodesic projection onto
 * the line. Fixed points (radius 0) are already exact. Takes and returns
 * the element path points only (the fixed start/end need no correction).
 */
export function projectionCorrection(
  tags: GeoPoint[],
  elements: GeodesicRouteElement[]
): GeoPoint[] {
  return elements.map((el, i) => {
    const p = tags[i];
    if (el.kind === 'cylinder') {
      if (el.radius <= 0) return el.center;
      const inv = inverseGeodesic(el.center.lat, el.center.lon, p.lat, p.lon);
      if (inv.distance === 0) {
        return destinationPoint(el.center.lat, el.center.lon, el.radius, 0);
      }
      return destinationPoint(el.center.lat, el.center.lon, el.radius, inv.azimuth);
    }
    const line = inverseGeodesic(el.point1.lat, el.point1.lon, el.point2.lat, el.point2.lon);
    if (line.distance === 0) return el.point1;
    const toPoint = inverseGeodesic(el.point1.lat, el.point1.lon, p.lat, p.lon);
    let along = toPoint.distance * Math.cos(toPoint.azimuth - line.azimuth);
    if (along < 0) along = 0;
    if (along > line.distance) along = line.distance;
    return destinationPoint(el.point1.lat, el.point1.lon, along, line.azimuth);
  });
}

/* ------------------------------------------------------------------ *
 * §7.1.8 — RouteOptimizer
 * ------------------------------------------------------------------ */

/** Project the route, run PathFinder, unproject, correct: the corrected full path. */
function optimizePath(route: GeodesicRouteDefinition, projection: LtmProjection): GeoPoint[] {
  const start = projection.toCartesian(route.startPoint.lat, route.startPoint.lon);
  const elements: CartesianElement[] = route.elements.map((el) =>
    el.kind === 'cylinder'
      ? {
          kind: 'cylinder' as const,
          ...projection.toCartesian(el.center.lat, el.center.lon),
          radius: el.radius,
          pinned: el.pinned,
        }
      : {
          kind: 'line' as const,
          p1: projection.toCartesian(el.point1.lat, el.point1.lon),
          p2: projection.toCartesian(el.point2.lat, el.point2.lon),
        }
  );
  const end = route.endPoint
    ? projection.toCartesian(route.endPoint.lat, route.endPoint.lon)
    : null;

  const cartesianTags = pathFinder(start, elements, end);
  const geodesicTags = cartesianTags.map((t) => projection.toGeodesic(t.x, t.y));
  const corrected = projectionCorrection(geodesicTags, route.elements);

  const path: GeoPoint[] = [route.startPoint, ...corrected];
  if (route.endPoint) path.push(route.endPoint);
  return path;
}

/**
 * §7.1.8 RouteOptimizer: the corrected shortest path through the route about
 * the given task-area centre, and its distance as the §7.1.5
 * EllipsoidDistance sum over the corrected points.
 *
 * The path is {startPoint, one corrected point per element, endPoint if the
 * route has one}. Callers that model a terminal cylinder by ending the route
 * at its CENTRE (so the element's path point is the nearest boundary point —
 * see task-optimizer.ts) drop the trailing endPoint from the path and sum
 * their own distance over what remains.
 */
export function routeOptimizer(
  route: GeodesicRouteDefinition,
  projection: LtmProjection
): { path: GeoPoint[]; distance: number } {
  const path = optimizePath(route, projection);
  let distance = 0;
  for (let i = 1; i < path.length; i++) {
    distance += ellipsoidDistance(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
  }
  return { path, distance };
}
