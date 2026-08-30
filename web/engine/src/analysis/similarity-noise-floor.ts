// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * How high a similarity two pilots who flew NOTHING alike can reach, purely
 * because they happened to be compared over only a handful of behaviours.
 *
 * This is the same idea as `spearmanNoiseFloor` in ./stats.ts, which the
 * correlation tables already use so a weak finding reads as weak. It matters
 * more here, because the count varies per ROW rather than per report: a
 * missing value is dropped rather than imputed (see ./similarity.ts), so one
 * sheet can hold a pair compared over 22 behaviours next to a pair compared
 * over 3, both printed to three decimals and ranked against each other.
 *
 * The measured spread is not subtle. Two unrelated pilots sharing three
 * behaviours clear 0.67 one time in twenty; sharing twenty-two, they barely
 * reach 0.21. Without this, a sparse pilot gets a confident-looking neighbour
 * list made entirely of noise — on Corryong 2026 open T2, every row of John
 * Harriott's sheet (3 shared behaviours, best score 0.140) sits below its own
 * floor of 0.672.
 *
 * A table rather than a formula because Tanimoto has no tidy quantile to
 * invert: T = c / (r + 1/r − c) depends on both the cosine c and the
 * magnitude ratio r, and both are random. See
 * web/scripts/generate-similarity-noise-floor.ts, which produced these numbers
 * from a seeded simulation and reproduces them exactly on a re-run.
 */

/** The fewest behaviours the table covers — and the fewest a similarity is
 * defined over at all (see MIN_COSINE_METRICS). */
const MIN_N = 2;

/**
 * One-sided alpha = 0.05 critical similarity, indexed by (n - MIN_N).
 *
 * One-sided because the sheet ranks by similarity descending, so the question
 * a reader actually has is always "could this HIGH score have come up by
 * chance?".
 */
const NOISE_FLOOR: number[] = [
  /*  2 */ 0.818,
  /*  3 */ 0.672,
  /*  4 */ 0.574,
  /*  5 */ 0.504,
  /*  6 */ 0.451,
  /*  7 */ 0.411,
  /*  8 */ 0.379,
  /*  9 */ 0.352,
  /* 10 */ 0.330,
  /* 11 */ 0.313,
  /* 12 */ 0.297,
  /* 13 */ 0.283,
  /* 14 */ 0.270,
  /* 15 */ 0.259,
  /* 16 */ 0.250,
  /* 17 */ 0.242,
  /* 18 */ 0.233,
  /* 19 */ 0.226,
  /* 20 */ 0.220,
  /* 21 */ 0.213,
  /* 22 */ 0.208,
  /* 23 */ 0.203,
  /* 24 */ 0.198,
  /* 25 */ 0.194,
  /* 26 */ 0.189,
  /* 27 */ 0.185,
  /* 28 */ 0.181,
  /* 29 */ 0.177,
  /* 30 */ 0.174,
  /* 31 */ 0.170,
  /* 32 */ 0.167,
  /* 33 */ 0.164,
  /* 34 */ 0.162,
  /* 35 */ 0.159,
  /* 36 */ 0.157,
  /* 37 */ 0.155,
  /* 38 */ 0.152,
  /* 39 */ 0.149,
  /* 40 */ 0.148,
];

/**
 * The similarity two unrelated pilots exceed 5% of the time when compared over
 * `n` behaviours. A row at or below its own floor carries no information, and
 * the surface should say so rather than rank it as though it did.
 *
 * NaN below {@link MIN_N}, where no shape comparison is defined. Above the
 * table it clamps to the last entry, which is conservative — the true floor
 * keeps falling as n grows, so clamping can only ever overstate the noise and
 * never dress a chance result up as a real one.
 */
export function similarityNoiseFloor(n: number): number {
  if (!Number.isFinite(n) || n < MIN_N) return NaN;
  const i = Math.min(Math.floor(n) - MIN_N, NOISE_FLOOR.length - 1);
  return NOISE_FLOOR[i];
}
