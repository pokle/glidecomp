/**
 * Which mark is nearest a point — the arithmetic behind selecting a dot or a
 * line by pointing near it (`use-nearest-pointer.ts`). Pure, in whatever
 * units the caller draws in.
 */

export interface XY {
  x: number;
  y: number;
}

/** The nearest mark, and how far away it is, in the caller's units. */
export interface Nearest {
  index: number;
  distance: number;
}

/** The point nearest (x, y), or null when there are none. A tie goes to the
 * first, so the answer does not depend on float noise. */
export function nearestPoint(points: readonly XY[], x: number, y: number): Nearest | null {
  let best = -1;
  let bestD = Infinity;
  points.forEach((p, i) => {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best < 0 ? null : { index: best, distance: Math.sqrt(bestD) };
}

/** Squared distance from (x, y) to the segment a–b. */
function segmentDistanceSq(a: XY, b: XY, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len)) : 0;
  return (a.x + t * dx - x) ** 2 + (a.y + t * dy - y) ** 2;
}

/**
 * The line that passes nearest (x, y), or null when there are none.
 *
 * A line is its drawn pieces: each piece a run of joined points, so a line
 * with a gap in it (a value missing in the middle) is not measured across the
 * gap, where nothing is drawn. A piece of one point is that point.
 */
export function nearestLine(
  lines: readonly (readonly (readonly XY[])[])[],
  x: number,
  y: number
): Nearest | null {
  let best = -1;
  let bestD = Infinity;
  lines.forEach((pieces, i) => {
    for (const piece of pieces) {
      for (let k = 0; k < piece.length; k++) {
        const d =
          k === 0
            ? (piece[0].x - x) ** 2 + (piece[0].y - y) ** 2
            : segmentDistanceSq(piece[k - 1], piece[k], x, y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  });
  return best < 0 ? null : { index: best, distance: Math.sqrt(bestD) };
}
