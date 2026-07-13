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
// v9: (a) weighted leading coefficient clamps per-fix times at the first
//     start gate — an HG jump-the-gun starter's pre-gate progress previously
//     contributed negative time once rebased to the gate, letting one early
//     starter undercut every honest leader and (at LC ≤ 0) zero the whole
//     field's leading points; "no valid LC in the field" is now signalled by
//     a non-finite minimum LC instead of conflating it with minLC ≤ 0.
//     (b) open distance is measured from the take-off cylinder EDGE to the
//     furthest fix (furthest distance from the centre minus the radius),
//     matching the manual-flight measurement — the cylinder only gates that
//     the pilot left; previously the origin was the LAST boundary exit, so a
//     mid-flight return through the launch cylinder erased all prior
//     distance. The open-distance geometry origin is now a derived edge
//     point with no fix index/time.
// v10: parsing hardening (2026-07-12 review §2 Parsing). (a) B records are
//     field-validated before parsing — a corrupted record previously fed NaN
//     coordinates / an Invalid Date into the fixes array, poisoning distance
//     and climb math. (b) xctsk v1 turnpoints with an explicit radius of 0
//     keep it instead of being coerced to 400 m (radius is a scoring input;
//     v2 and the encoder already preserved 0). (c) HP/HO H-records are
//     recognized (IGC source char F|O|P), so pilot names recorded as
//     HPPLT/HOPLT are no longer dropped. (d) fuzzy waypoint-name containment
//     requires a 3+ char DB name — an empty or 1-2 char name matched almost
//     any query and substituted the wrong radius/altitude into IGC-declared
//     tasks.
// v11: two-step tolerance-band penetrations anchor to the nominal radius —
//     when the fix pair that crosses the detection edge (outer band edge, or
//     inner for an EXIT start) doesn't straddle the nominal radius, the
//     crossing now anchors to the fix pair within the band episode that
//     does, instead of clamping to the band-edge fix and mislabelling the
//     crossing as tolerance-credited. Reaching times/positions shift by up
//     to one fix interval; toleranceCredited is only set when the pilot
//     genuinely never crossed the nominal radius.
// v12: goal LINE scoring (S7F §6.3.1) — a task whose goal is configured as
//     `goal.type: 'LINE'` is now scored against a goal line perpendicular to
//     the final leg (length = 2 × the goal turnpoint's radius) with its
//     control semicircle behind it, instead of being treated as a cylinder.
//     Goal is achieved by a track segment crossing the line or a fix inside
//     the semicircle; the optimised route ends at the closest point on the
//     line; land-out remaining distance is measured to the nearest point on
//     the line. Cylinder goals and tasks where no line can be constructed
//     (single turnpoint, zero radius) are unchanged.
export const SCORING_ENGINE_VERSION = 12;

/**
 * SHA-256 (hex) over the scoring-relevant engine sources, maintained by
 * tests/scoring-version.test.ts. Update it (and bump the version above)
 * when the test tells you to.
 */
export const SCORING_SOURCE_FINGERPRINT =
  "762719ef8081c30bdd33e652413e804fcc0fa66622c2a8ed9660c7ac851140d6";
