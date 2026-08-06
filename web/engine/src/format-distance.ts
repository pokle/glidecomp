/**
 * Distance formatting, in fixed metric.
 *
 * Its own module rather than a helper on score-explanation-format so that the
 * two callers can share one spelling of the format without dragging the report
 * card into the scoring fingerprint. track-quality.ts is one of the scoring
 * roots hashed by tests/scoring-version.test.ts, and that hash walks the
 * transitive import closure — so importing km() from the explanation formatter
 * would put the report card's presentation inside the closure, and every tweak
 * to explanation copy would roll every scoring cache on the site. This file
 * holds the shared formatter alone and changes about as often as a unit.
 */

/** Options for {@link km}. */
export interface KmOptions {
  /**
   * At 100 km and above, print whole thousands-separated kilometres
   * ("2,186 km") instead of the fixed decimals.
   *
   * For prose about a distance that can run to thousands of kilometres — a
   * track-quality finding says how far from the course the track is — where
   * a tenth of a kilometre is noise. Off by default, so a scored distance
   * keeps its decimal at every magnitude.
   */
  wholeAbove100?: boolean;
}

/** A distance in kilometres at fixed metric precision. */
export function km(meters: number, decimals = 1, options?: KmOptions): string {
  const value = meters / 1000;
  if (options?.wholeAbove100 && value >= 100) {
    return `${Math.round(value).toLocaleString('en-GB')} km`;
  }
  return `${value.toFixed(decimals)} km`;
}
