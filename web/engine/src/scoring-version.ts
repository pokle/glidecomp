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
// v5: cylinder tolerance band (S7F §8.1) — crossing detection now applies the
//     full tolerance band (percentage OR a 5 m absolute minimum, whichever is
//     larger) and extends it inward for the EXIT start as well as outward for
//     entry cylinders, instead of an outward-only percentage expansion. Small
//     cylinders get the 5 m floor and EXIT starts are credited at the inner
//     edge; near-misses credited by the band are flagged for explanation.
// v6: xctsk v2 QR `z` decoding — the polyline tuple is read in the spec's
//     (longitude, latitude, altitude, radius) order instead of latitude-first
//     (https://xctrack.org/Competition_Interfaces.html), and each value is
//     decoded standalone (no delta accumulation). Tasks imported from compact
//     QR payloads without explicit lat/lon fields previously had their
//     coordinates transposed.
// v7: presence-based turnpoint reaching (S7F §8 / FS semantics) — a pilot who
//     is already inside a cylinder when the previous turnpoint is reached is
//     credited at that same moment ('already_inside'), instead of requiring a
//     boundary crossing at or after it. Fixes a turnpoint nested inside a
//     larger following cylinder (e.g. a big ESS/goal ring around the final
//     TP): a finisher who tagged the nested TP from inside and never exited
//     was scored landed-out, and an exit/re-entry after the nested TP was
//     credited late, inflating the speed-section time.
// v8: post-2015 HFDTEDATE long-form header parsing — the modern
//     `HFDTEDATE:150124,01` date header is now recognized. Previously it
//     failed both date regexes, leaving header.date undefined so every fix
//     was stamped with the parse-day's date (non-deterministic), corrupting
//     start gates, task-date checks, and timezone display for such files.
export const SCORING_ENGINE_VERSION = 8;

/**
 * SHA-256 (hex) over the scoring-relevant engine sources, maintained by
 * tests/scoring-version.test.ts. Update it (and bump the version above)
 * when the test tells you to.
 */
export const SCORING_SOURCE_FINGERPRINT =
  "94bef4e997b09bdadf3dac0aff3a0879be125e8490ce18692194f77252270380";
