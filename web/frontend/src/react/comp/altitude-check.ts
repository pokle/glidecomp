/**
 * Comparing a waypoint set's altitudes against the map's terrain.
 *
 * The waypoints editor's "Check altitudes" review reads a ground elevation
 * for every waypoint and puts the two numbers side by side. The arithmetic
 * and the judgement calls live here, away from the grid, because what counts
 * as a disagreement worth a human's attention is the whole design:
 *
 *  - **A difference is not an error.** The DEM is a ~10 m grid, sampled as the
 *    median of a 3x3 (see analysis/elevation.ts), and published waypoint files are
 *    routinely rounded to the nearest 10 m — the bundled Corryong set encodes
 *    the altitude in the code itself ("4C-080" is 800 m). Listing every row
 *    that differs would list every row, so only a difference past
 *    {@link SUSPECT_DELTA_M} is offered for review.
 *  - **A big difference is usually a wrong COORDINATE**, not a wrong
 *    altitude: a mistyped degree lands the waypoint in the next valley, and
 *    accepting the terrain there would make it look fixed while leaving it in
 *    the wrong place. Past {@link COORD_SUSPECT_DELTA_M} the review says so
 *    rather than quietly offering the map's number.
 *  - **A whole file can be wrong the same way.** An elevation column in feet
 *    read as metres makes every altitude 3.28x too high, and the fix is one
 *    conversion, not a per-row decision made 187 times. {@link
 *    detectAltitudePattern} looks for that shape before the reader starts
 *    working down the list.
 *
 * Nothing here knows about Tabulator, React or Mapbox: it takes pairs of
 * numbers and returns findings.
 */

/**
 * Metres of disagreement below which a waypoint is not worth a second look.
 *
 * 50 m is comfortably above what the sampling and the rounding can produce
 * together (a 10 m DEM pixel on a steep slope, plus a file rounded to 10 m)
 * and comfortably below the smallest mistake worth an organiser's time.
 */
export const SUSPECT_DELTA_M = 50;

/**
 * Past this, doubt the coordinates before the altitude. 300 m of terrain
 * error inside one DEM pixel needs a cliff; 300 m between two valleys needs
 * only a typo.
 */
export const COORD_SUSPECT_DELTA_M = 300;

/** Feet → metres, for the whole-file unit mix-up. */
const FEET_TO_METRES = 0.3048;
const METRES_PER_FOOT = 1 / FEET_TO_METRES; // ~3.28084

/** One waypoint's two altitudes, each absent when unknown. */
export interface AltitudePair {
  /** What the waypoint file (or the admin) says, in metres. */
  fileAlt?: number;
  /** What the terrain DEM says, in metres. Absent = we could not read it. */
  mapAlt?: number;
}

/** How a single row came out of the comparison. */
export type AltitudeVerdict =
  /** No map elevation — bad coordinates, or the tile would not load. */
  | "unreachable"
  /** The file carries no altitude; the map's is simply an answer. */
  | "missing"
  /** The two agree closely enough to leave alone. */
  | "ok"
  /** They disagree enough to be worth a look. */
  | "suspect"
  /** They disagree so much that the coordinates are the likelier fault. */
  | "coords";

/**
 * `fileAlt - mapAlt`, or undefined when either side is unknown.
 *
 * Signed on purpose: which way a waypoint is wrong is a clue to why. A whole
 * set reading high is a unit or datum problem; one waypoint reading low is
 * a typo.
 */
export function altitudeDelta(pair: AltitudePair): number | undefined {
  const { fileAlt, mapAlt } = pair;
  if (!Number.isFinite(fileAlt) || !Number.isFinite(mapAlt)) return undefined;
  return (fileAlt as number) - (mapAlt as number);
}

/** Classify one row. */
export function altitudeVerdict(pair: AltitudePair): AltitudeVerdict {
  if (!Number.isFinite(pair.mapAlt)) return "unreachable";
  if (!Number.isFinite(pair.fileAlt)) return "missing";
  const delta = Math.abs(altitudeDelta(pair) as number);
  if (delta >= COORD_SUSPECT_DELTA_M) return "coords";
  if (delta >= SUSPECT_DELTA_M) return "suspect";
  return "ok";
}

/**
 * Whether a row belongs in the review list — the rows with something to
 * decide. An agreeing row is counted in the summary and left out of the list,
 * which is the difference between "12 to look at" and "145 differ".
 */
export function needsReview(pair: AltitudePair): boolean {
  const verdict = altitudeVerdict(pair);
  return verdict === "suspect" || verdict === "coords" || verdict === "missing";
}

/**
 * Sort key for the review, highest first: the biggest disagreement leads.
 *
 * A row the file has no altitude for sorts BELOW every disagreement. It still
 * needs a value, but it needs no judgement — nothing is being overwritten —
 * so it is not what the reader should spend their attention on first.
 */
export function reviewSortKey(pair: AltitudePair): number {
  const delta = altitudeDelta(pair);
  if (delta === undefined) return Number.isFinite(pair.mapAlt) ? -1 : -2;
  return Math.abs(delta);
}

export interface AltitudeCheckSummary {
  /** Rows with an altitude on both sides. */
  compared: number;
  /** Rows within tolerance — the ones deliberately not listed. */
  ok: number;
  /** Rows past SUSPECT_DELTA_M but under COORD_SUSPECT_DELTA_M. */
  suspect: number;
  /** Rows past COORD_SUSPECT_DELTA_M — check the coordinates first. */
  coords: number;
  /** Rows the file has no altitude for, where the map has one. */
  missing: number;
  /** Rows with no map elevation at all (bad coordinates, or a failed tile). */
  unreachable: number;
  /** suspect + coords + missing — what the review lists. */
  reviewable: number;
}

/** Count each verdict across a whole set. */
export function summariseAltitudeCheck(pairs: AltitudePair[]): AltitudeCheckSummary {
  const summary: AltitudeCheckSummary = {
    compared: 0,
    ok: 0,
    suspect: 0,
    coords: 0,
    missing: 0,
    unreachable: 0,
    reviewable: 0,
  };
  for (const pair of pairs) {
    const verdict = altitudeVerdict(pair);
    if (verdict === "ok" || verdict === "suspect" || verdict === "coords") summary.compared++;
    if (verdict === "ok") summary.ok++;
    if (verdict === "suspect") summary.suspect++;
    if (verdict === "coords") summary.coords++;
    if (verdict === "missing") summary.missing++;
    if (verdict === "unreachable") summary.unreachable++;
  }
  summary.reviewable = summary.suspect + summary.coords + summary.missing;
  return summary;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A systematic disagreement one bulk fix would cure, rather than a list of
 * individual mistakes.
 *
 * `feet`: the file's elevations are feet that were read as metres, so every
 * altitude is ~3.28x the terrain. `offset`: everything is out by roughly the
 * same number of metres, which is a datum or a pressure-altitude reference
 * rather than a set of typos.
 */
export type AltitudePattern =
  | { kind: "feet"; count: number; total: number; ratio: number }
  | { kind: "offset"; count: number; total: number; metres: number };

/** At least this many comparable rows before a "whole file" claim is credible. */
const MIN_PATTERN_ROWS = 5;
/** And at least this share of them must fit the pattern. */
const PATTERN_SHARE = 0.7;

/**
 * Look for a whole-file problem.
 *
 * Only rows well clear of sea level take part: near 0 m the ratio of two
 * altitudes says nothing (and divides by almost nothing), so a coastal set
 * would otherwise produce a confident nonsense answer.
 */
export function detectAltitudePattern(pairs: AltitudePair[]): AltitudePattern | null {
  const comparable = pairs.filter(
    (p) =>
      Number.isFinite(p.fileAlt) &&
      Number.isFinite(p.mapAlt) &&
      Math.abs(p.mapAlt as number) >= 20
  );
  if (comparable.length < MIN_PATTERN_ROWS) return null;
  const needed = Math.ceil(comparable.length * PATTERN_SHARE);

  // Feet first: a multiplicative error also spreads the offsets wide, so
  // testing offsets first would find nothing and stop.
  const ratios = comparable.map((p) => (p.fileAlt as number) / (p.mapAlt as number));
  const ratioFits = ratios.filter((r) => Math.abs(r - METRES_PER_FOOT) <= 0.25).length;
  if (ratioFits >= needed) {
    return {
      kind: "feet",
      count: ratioFits,
      total: comparable.length,
      ratio: median(ratios.filter((r) => Math.abs(r - METRES_PER_FOOT) <= 0.25)),
    };
  }

  // A constant offset, big enough to matter and consistent enough to be one
  // cause rather than a coincidence of unrelated errors.
  const offsets = comparable.map((p) => altitudeDelta(p) as number);
  const centre = median(offsets);
  if (Math.abs(centre) >= SUSPECT_DELTA_M) {
    const offsetFits = offsets.filter((o) => Math.abs(o - centre) <= 25).length;
    if (offsetFits >= needed) {
      return { kind: "offset", count: offsetFits, total: comparable.length, metres: Math.round(centre) };
    }
  }
  return null;
}

/** One line naming the pattern, for the review banner. */
export function describeAltitudePattern(pattern: AltitudePattern): string {
  if (pattern.kind === "feet") {
    return (
      `${pattern.count} of ${pattern.total} altitudes are about ` +
      `${pattern.ratio.toFixed(2)}x the terrain below them — this set looks like it is in feet.`
    );
  }
  const direction = pattern.metres > 0 ? "above" : "below";
  return (
    `${pattern.count} of ${pattern.total} altitudes sit about ` +
    `${Math.abs(pattern.metres)} m ${direction} the terrain — the whole set is offset, ` +
    `which is a datum or reference difference rather than a set of mistakes.`
  );
}

/** Convert a set of feet-as-metres altitudes to metres. */
export function feetToMetres(altitude: number): number {
  return Math.round(altitude * FEET_TO_METRES);
}

/** A signed delta for display: "+120", "-45", "0". */
export function formatAltitudeDelta(delta: number): string {
  const rounded = Math.round(delta);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}
