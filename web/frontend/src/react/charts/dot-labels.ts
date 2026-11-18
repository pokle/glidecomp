/**
 * Which dots of a scatter are named in place, and where each name goes.
 * Pure geometry: the caller has already mapped its data to its own pixels.
 *
 * The consistency map named fourteen of its twenty dots, every name to the
 * right of its dot, and then pushed the names apart vertically until none
 * touched. At 5.7px that worked. At a size a phone can read the pushed-apart
 * column is taller than the cluster it names, and a name ends up three dots
 * away from its own (issue #860).
 *
 * So a name here stays BESIDE its dot or is not drawn. Each wanted name, in
 * the caller's order of importance, takes the first of six places around its
 * dot that is clear of every other dot, every name already placed and every
 * box the caller has blocked. A name with no clear place is dropped: an
 * unreadable pile helps no one, and the chart names any dot that is selected.
 *
 * The order is what makes a later name safe to add: names are placed one
 * after another and never moved, so a caller can append the selected dot's
 * name without the standing names shifting under the reader.
 *
 * `score-curve-layout.ts` is the same idea for a curve, where names step
 * away vertically and take a leader line. Here they do not travel.
 */
import { approxTextWidth } from "./text-width";

export interface LabelBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface DotLabel {
  key: string;
  text: string;
  /** The text's x and its baseline. */
  x: number;
  y: number;
  anchor: "start" | "end";
  box: LabelBox;
}

/**
 * The places tried, in order: `side` is right (1) or left (-1) of the dot,
 * `rise` is how far the name is lifted, in ems (negative is lower).
 *
 * Level and to the right first, because that is where a reader looks for a
 * dot's name. Then below-right and above-left before the rest: the dots of
 * a scatter that trends upwards lie along a rising diagonal, and those two
 * places are the ones on either side of it.
 */
const PLACES: { side: 1 | -1; rise: number }[] = [
  { side: 1, rise: 0 },
  { side: 1, rise: -0.8 },
  { side: -1, rise: 0.8 },
  { side: -1, rise: 0 },
  { side: 1, rise: 0.8 },
  { side: -1, rise: -0.8 },
];

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Does a box come within `radius` of a point? */
function touchesDot(box: LabelBox, x: number, y: number, radius: number): boolean {
  const nx = Math.min(box.x1, Math.max(box.x0, x));
  const ny = Math.min(box.y1, Math.max(box.y0, y));
  return (nx - x) ** 2 + (ny - y) ** 2 < radius * radius;
}

export function placeDotLabels({
  dots,
  wanted,
  fontSize,
  dotRadius,
  bounds,
  blocked = [],
}: {
  /** Every dot drawn, named or not: a name keeps clear of all of them. */
  dots: readonly { key: string; x: number; y: number }[];
  /** The dots to name, most important first. */
  wanted: readonly { key: string; text: string }[];
  fontSize: number;
  dotRadius: number;
  /** Where a name may be drawn. */
  bounds: LabelBox;
  /** Boxes already taken — a note printed in the plot. */
  blocked?: readonly LabelBox[];
}): DotLabel[] {
  const byKey = new Map(dots.map((d) => [d.key, d]));
  // Clear of the dot, and of the ring a chart draws round a selected one.
  const gap = dotRadius + fontSize * 0.45;
  const placed: DotLabel[] = [];
  for (const { key, text } of wanted) {
    const dot = byKey.get(key);
    if (!dot) continue;
    const width = approxTextWidth(text, fontSize);
    for (const { side, rise } of PLACES) {
      const baseline = dot.y + fontSize * 0.35 - rise * fontSize;
      const x = dot.x + side * gap;
      const box: LabelBox = {
        x0: side === 1 ? x : x - width,
        x1: side === 1 ? x + width : x,
        // A full line: ascenders above the baseline, descenders below it,
        // and a little leading, so two names stacked are not touching.
        y0: baseline - fontSize * 0.85,
        y1: baseline + fontSize * 0.3,
      };
      if (
        box.x0 < bounds.x0 ||
        box.x1 > bounds.x1 ||
        box.y0 < bounds.y0 ||
        box.y1 > bounds.y1
      ) {
        continue;
      }
      if (placed.some((l) => overlaps(l.box, box))) continue;
      if (blocked.some((b) => overlaps(b, box))) continue;
      if (dots.some((d) => d.key !== key && touchesDot(box, d.x, d.y, dotRadius + 1))) continue;
      placed.push({ key, text, x, y: baseline, anchor: side === 1 ? "start" : "end", box });
      break;
    }
  }
  return placed;
}
