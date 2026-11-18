/**
 * How wide a label will be drawn, without asking the DOM.
 *
 * SVG has no layout, so the only exact answer needs a live DOM measurement —
 * which these charts deliberately avoid (they render identically in a test,
 * on a server, and in a browser). A chart that sizes a margin for its widest
 * tick, staggers axis labels that would touch, or keeps one label off
 * another needs the width near enough, and needs the same answer in all
 * three places.
 *
 * Moved here from the weather charts' `met-shared.ts` when the task-analysis
 * charts needed it too (issue #860).
 */

/** Per-character widths as a fraction of the font size, for the UI sans at
 * label sizes. Four buckets is enough: the caller only needs to know roughly
 * where a label starts and ends. */
const CHAR_EM: { chars: string; em: number }[] = [
  { chars: "iltfIj.,:;'`!|()[]{}", em: 0.33 },
  { chars: " ", em: 0.3 },
  { chars: "mwMW@", em: 0.92 },
  { chars: "ABCDEFGHJKLNOPQRSTUVXYZ0123456789%°", em: 0.65 },
];
const DEFAULT_EM = 0.6;

/**
 * How wide `text` will render at `fontPx`, near enough to place something
 * beside it.
 *
 * The table is calibrated against `getComputedTextLength()` for the labels
 * these charts actually draw, and deliberately tuned to run a hair WIDE (0–3
 * units on those strings), so the error shows up as a slightly generous gap
 * rather than as an overlap.
 */
export function approxTextWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) {
    em += CHAR_EM.find((bucket) => bucket.chars.includes(ch))?.em ?? DEFAULT_EM;
  }
  return em * fontPx;
}

/**
 * `text`, cut short with an ellipsis if it is wider than `maxWidth` at
 * `fontPx`. A label drawn in an `<svg>` that runs past the edge is sliced off
 * there with no mark that anything is missing; this says so.
 */
export function truncateToWidth(text: string, fontPx: number, maxWidth: number): string {
  if (approxTextWidth(text, fontPx) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const cut = `${chars.join("").trimEnd()}…`;
    if (approxTextWidth(cut, fontPx) <= maxWidth) return cut;
  }
  return "…";
}

/**
 * `text` broken into lines no wider than `maxWidth` at `fontPx`, at spaces.
 * SVG text does not wrap, so an axis title longer than its chart is cut off
 * at both ends unless it is given its lines. A single word wider than the
 * line keeps a line to itself.
 */
export function wrapToWidth(text: string, fontPx: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && approxTextWidth(next, fontPx) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}
