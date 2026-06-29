// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Pure 2D geometry for the gaggle blob — convex hull (Andrew's monotone chain)
 * and a rounded offset outline (the convex hull Minkowski-summed with a circle).
 *
 * No Three.js / DOM here, so it is unit-testable in isolation. Coordinates are
 * the scene's horizontal ENU plane (x = East, z = South); the blob is drawn flat
 * at the members' mean altitude, so only x/z matter.
 *
 * The rounded outline gives one shape that degrades gracefully: 1 point → a
 * circle, 2 → a capsule, ≥3 → a rounded convex polygon. That means as a pilot
 * approaches a gaggle the envelope visibly reaches out and engulfs them.
 */

export interface Pt {
  x: number;
  z: number;
}

const EPS = 1e-6;

/**
 * Convex hull of XZ points via Andrew's monotone chain, returned
 * counter-clockwise with collinear points and duplicates removed. For 1–2
 * unique points returns them as-is (no hull is possible).
 */
export function convexHullXZ(points: Pt[]): Pt[] {
  // de-duplicate, then sort by x then z
  const uniq: Pt[] = [];
  const seen = new Set<string>();
  for (const p of points) {
    const key = `${Math.round(p.x / EPS)}:${Math.round(p.z / EPS)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(p);
  }
  uniq.sort((a, b) => (a.x === b.x ? a.z - b.z : a.x - b.x));
  if (uniq.length <= 2) return uniq;

  // cross product of OA × OB (z used as the 2D "y")
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const lower: Pt[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  // drop each list's last point (shared with the other's first)
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Outward unit normal of edge a→b, chosen to point away from `c` (the centroid). */
function outwardNormal(a: Pt, b: Pt, cx: number, cz: number): Pt {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  let nx = dz / len;
  let nz = -dx / len;
  // flip toward the side away from the centroid
  const mx = (a.x + b.x) / 2 - cx;
  const mz = (a.z + b.z) / 2 - cz;
  if (nx * mx + nz * mz < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { x: nx, z: nz };
}

function arc(cx: number, cz: number, pad: number, a0: number, sweep: number, segs: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= segs; k++) {
    const a = a0 + (sweep * k) / segs;
    out.push({ x: cx + pad * Math.cos(a), z: cz + pad * Math.sin(a) });
  }
  return out;
}

/**
 * Ordered ring of points outlining the convex hull of `points` offset outward by
 * `pad` (rounded at corners). `arcSeg` controls corner smoothness. The ring is
 * open (no duplicated closing point) — close it with a LINE_LOOP / fan.
 */
export function roundedHullOutline(points: Pt[], pad: number, arcSeg = 6): Pt[] {
  const hull = convexHullXZ(points);
  if (hull.length === 0) return [];
  if (hull.length === 1) return arc(hull[0].x, hull[0].z, pad, 0, Math.PI * 2, arcSeg * 4);
  if (hull.length === 2) return capsule(hull[0], hull[1], pad, arcSeg);

  const m = hull.length;
  let cx = 0;
  let cz = 0;
  for (const h of hull) {
    cx += h.x;
    cz += h.z;
  }
  cx /= m;
  cz /= m;

  const out: Pt[] = [];
  for (let i = 0; i < m; i++) {
    const v = hull[i];
    const prev = hull[(i - 1 + m) % m];
    const next = hull[(i + 1) % m];
    const nIn = outwardNormal(prev, v, cx, cz);
    const nOut = outwardNormal(v, next, cx, cz);
    const a0 = Math.atan2(nIn.z, nIn.x);
    const a1 = Math.atan2(nOut.z, nOut.x);
    let sweep = a1 - a0;
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
    const segs = Math.max(1, Math.round((sweep / (Math.PI / 2)) * arcSeg));
    out.push(...arc(v.x, v.z, pad, a0, sweep, segs));
  }
  return out;
}

/** Capsule outline around segment a–b, offset by `pad`. */
function capsule(a: Pt, b: Pt, pad: number, arcSeg: number): Pt[] {
  const ang = Math.atan2(b.z - a.z, b.x - a.x);
  const half = Math.PI;
  const segs = Math.max(3, arcSeg * 2);
  // semicircle around b (from ang-90° sweeping +180°), then around a
  return [
    ...arc(b.x, b.z, pad, ang - Math.PI / 2, half, segs),
    ...arc(a.x, a.z, pad, ang + Math.PI / 2, half, segs),
  ];
}
