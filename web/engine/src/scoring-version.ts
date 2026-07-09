/**
 * Version of the scoring engine's observable behaviour.
 *
 * The competition API folds this into every scoring cache key (task scores,
 * comp standings, per-track analysis, per-pilot transparency), so results
 * computed by two different engine generations can never be served side by
 * side: a deploy that changes scoring behaviour rolls every key at once.
 * Because the engine is deterministic, a cached score and a cached analysis
 * under the same version + inputs are guaranteed to agree — this is what
 * lets the score-details page present the narrative as exact, with no
 * "may not match the published score" hedging.
 *
 * Bump this whenever scoring behaviour changes. You cannot forget: the
 * scoring-version fingerprint test hashes every scoring-relevant source
 * file and fails the build when they change without a bump here. After a
 * bump, update SCORING_SOURCE_FINGERPRINT to the hash the test prints.
 */
// v2: start gates (S7F §6.3.3/§8.3.1) — gated races time the speed section
//     from the start gate taken, drop pre-gate start crossings, anchor the
//     leading-coefficient clock at the first gate, and apply the §12.2
//     early-start rules (PG launch→SSS, HG jump-the-gun penalty).
// v3: goal detection when ESS and goal are the same cylinder — a pilot who
//     enters the shared ESS/goal cylinder once (and lands inside) now makes
//     goal. The single boundary crossing emits one crossing per task index
//     at the identical timestamp; the forward-path search now accepts a
//     co-located turnpoint at that same time instead of requiring a strictly
//     later crossing, which had reported goal pilots as "landed out".
// v4: pilot totals rounded to one decimal place (S7F §11) instead of whole
//     points, with the rounding done after penalties (§12.4). The engine
//     total keeps the 0.1 precision through the jump-the-gun penalty; the
//     backend re-rounds after the scorekeeper's absolute penalty.
export const SCORING_ENGINE_VERSION = 4;

/**
 * SHA-256 (hex) over the scoring-relevant engine sources, maintained by
 * tests/scoring-version.test.ts. Update it (and bump the version above)
 * when the test tells you to.
 */
export const SCORING_SOURCE_FINGERPRINT =
  "fa51d240e8d52c48a4aa896b84344f1c26718febe0d07348fdc092ecde0ab360";
