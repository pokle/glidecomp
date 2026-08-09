/**
 * Version of the scoring engine's observable behaviour.
 *
 * The competition API folds this into every scoring cache key (task scores,
 * comp scores, per-track analysis, per-pilot transparency), so results
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
//     the line. Goal crossings credited by a semicircle fix (no line
//     crossing in the tracklog) are flagged goalSemicircleCredited so the
//     score explanation can say why. Cylinder goals and tasks where no line
//     can be constructed (single turnpoint, zero radius) are unchanged.
// v13: official per-category default GAP parameters (issue #343). A comp that
//     hasn't saved its scoring settings is now scored from defaultsFor(category)
//     — the current FAI S7F formula: leading (departure) points on for both PG
//     and HG, arrival on for HG, distance difficulty on for HG, nominal goal
//     30% — instead of the raw HG-shaped engine baseline (leading/arrival off,
//     nominal goal 20%). A PG comp with no saved params is now scored as PG
//     rather than HG. Comps with saved gap_params are unaffected (the stored
//     values still win); the version bump invalidates cached scores for the
//     null-params comps whose effective formula changed.
// v14: track-less pilots (manual flights, issue #306) earn no leading points
//     instead of crashing the scorer. A manual flight has no tracklog, so it
//     carries no leading aggregate/fixes/sequence; scoreFlights now treats such
//     a flight as LC = Infinity (0 leading points) rather than throwing. Only
//     affects leading-enabled tasks with manual flights — which the new
//     per-category HG default (leading on) made reachable.
// v15: exit turnpoints (issue #347). A turnpoint whose cylinder the optimized
//     route reaches from inside (its boundary contains the previous tag
//     point — e.g. the big ring of a concentric out-and-return) is now an
//     EXIT cylinder: reached at the first OUTWARD boundary crossing at/after
//     the previous reaching (or credited 'already_outside' when the pilot
//     tagged the previous turnpoint beyond it), detected against the inner
//     tolerance edge (§8.1) like the EXIT start. Previously it was credited
//     'already_inside' at the previous reaching — on the concentric task
//     every starter was instantly credited the ring AND the enclosing ESS,
//     zeroing every speed section and scoring never-exited pilots near full
//     distance. Land-out distance now routes to an un-reached exit
//     cylinder's boundary from inside (radius − distance-to-centre), and to
//     the nearest edge of the ENTER turnpoint right after a reached inferred
//     exit cylinder (the optimizer's tag bearing is arbitrary on a
//     rotationally symmetric task); measurement after the declared-EXIT
//     start is unchanged (AirScore parity). The SSS keeps its declared
//     direction; the goal (a destination) is always ENTER. Manual flights
//     route with the same rules.
// v16: no behaviour change — documentation only. defaultsFor() gained a doc
//     comment recording the FAI-class mapping (PG = Class 3; HG = Classes
//     1/2/5 all score under the HG profile), which touches a hashed scoring
//     source, so the fingerprint guard requires a bump. The extra cache roll
//     is harmless (scores recompute identically).
// v17: HG "ESS but not goal" penalty (S7F §12.1, issue #256). A hang-glider
//     pilot who reaches ESS but lands before goal now keeps only the new
//     per-comp essNotGoalFactor share of their time AND arrival points
//     (default 0.8, the spec's recommended value; configurable by local
//     regulations). Previously such a pilot kept 100% of both. PG is
//     unchanged (the spec fixes its factor at 0 — no goal, no time points —
//     which the engine already enforced). The factor also selects the best
//     time source, matching AirScore's pilot_speed: factor > 0 → fastest
//     ESS pilot (the previous HG behaviour); factor 0 (and always PG) →
//     fastest pilot in goal per §11.2.1.
// v18: task deadline + launch window enforcement (issue #260, S7F §8.3.c,
//     §8.6.1, §11.1). The xctsk goal deadline is now enforced: boundary
//     crossings after it are excluded from sequence resolution (so a
//     turnpoint/ESS/goal tagged too late no longer counts, and the goal
//     ratio only counts pre-deadline goals per §10), and a landed-out
//     pilot's best distance is measured only up to the deadline. Start
//     crossings before the launch window opens (takeoff.timeOpen) can no
//     longer validate a start — a pre-window crossing proves the pilot was
//     airborne before launching was allowed. Mis-set tasks are guarded: a
//     deadline at/before the first start gate, or a window open at/after
//     the deadline or after the first gate, is treated as unset. The result
//     carries deadline/launchWindow transparency fields and the score
//     explanation narrates the cutoff and each ignored crossing.
// v19: sport-correct leading/time-points pairing (issue #258). The
//     time-points exponent (S7F §11.2) is now an independent GAPParameters
//     knob (timePointsExponent) instead of being implied by the
//     leading-coefficient variant, and the per-category defaults adopt the
//     2024-spec pairing: HG → classic squared-distance LC + 5/6 exponent,
//     PG → weighted-area LC + 5/6 exponent (previously both categories
//     defaulted to the weighted LC, and 'classic' forced a 2/3 exponent).
//     An HG comp with no saved formula therefore switches from the weighted
//     LC to the classic LC (both at 5/6); comps that saved an explicit
//     leadingFormula keep the exponent it used to imply (classic → 2/3,
//     weighted → 5/6), so their scores are unchanged. The bump invalidates
//     cached scores for the null-/default-formula comps whose LC variant
//     changed.
// v20: paragliding leading-weight formula generation (issue #257). A new
//     `leadingWeightFormula` param ('gap2020' | 's7f2024') and
//     `leadingTimeRatio` (0–0.5, default 0.26) let a PG comp score its
//     leading↔time weight split under either the GAP2020/AirScore formula or
//     the FAI S7F 2024 §10 LeadingTimeRatio formula (leading =
//     LeadingTimeRatio × (1 − DW) at goal, and the whole non-distance weight
//     when nobody makes goal). The default is date-based (resolveCompGapParams):
//     PG comps created on/after 2026-07-15 default to 's7f2024', earlier comps
//     to 'gap2020' — so no pre-existing comp's scores move. Hang-gliding
//     weights are untouched. Bump rolls caches so new-default comps recompute.
// v21: no behaviour change — internal refactor only (engine complexity review).
//     Order-sensitive scoring signatures became options objects, the longest
//     scoring/sequence functions were split into named helpers, the four
//     oversized modules were broken into per-concern files (re-exported from
//     the same entry modules), and the FAI validity/arrival cubics were pulled
//     into named constants via a poly3 helper (identical arithmetic). Every
//     scoring number is unchanged; the fingerprint moved because the hashed
//     sources were reorganised, so the guard requires a bump. The cache roll is
//     harmless — scores recompute identically.
// v22: stopped tasks (issue #264, S7F §12.3). A task with a recorded stop
//     announcement time is now scored as stopped: the announcement is scored
//     back to the task stop time (§12.3.1 — PG minus the new scoreBackTime
//     comp parameter, default 300 s; HG minus one start-gate interval, or 15
//     minutes with a single gate); every pilot is scored only for the scored
//     time window (§12.3.4 — start→stop for single-gate races; the last
//     starter's duration for multi-gate/elapsed), with crossings after it
//     excluded; a pilot at/after ESS at the window end keeps their complete
//     flight (§12.3.5) and every goal pilot's time points are reduced by the
//     points of a hypothetical pilot reaching ESS exactly at the stop; pilots
//     still flying at the stop earn the §12.3.6 altitude bonus (GNSS height
//     above goal × 5.0 HG / 4.0 PG, folded into flown distance); a fourth
//     validity factor (§12.3.3) applies, and a stopped task that ran less
//     than min(1 h, nominalTime/2) after the start scores zero (§12.3.2).
//     Tasks without a stop announcement are scored exactly as before.
// v23: no behaviour change — documentation only. Comparing the engine against
//     the FAI S7F PDFs and the AirScore source showed the PG leading-weight
//     mode stored as 'gap2020' is really the GAP2016/2018 formula (the true
//     S7F 2020–2022 generation uses PWC-derived weights GlideComp doesn't
//     implement); the gap-params/gap-formulas doc comments now say so. The
//     comments touch hashed scoring sources, so the fingerprint guard
//     requires a bump. The cache roll is harmless (scores recompute
//     identically).
// v24: S7F 2020–2022 PG weight generation (AirScore history import). A third
//     `leadingWeightFormula` value 's7f2020' implements the PWC-derived PG
//     weights of the S7F 2020–2022 editions (AirScore's gap2020/gap2021/
//     gap2022 presets): distance weight fixed at 0.838 when nobody makes
//     goal, else 0.805 − 1.374·GR + 1.413·GR² − 0.484·GR³; leading weight
//     fixed at 0.162 (LeadingTimeRatio ignored); arrival 0; time the
//     remainder (exactly 0 at goal ratio 0). Never a default — selected
//     explicitly in settings or by the AirScore formula importer — so no
//     existing comp's scores move; the guard fires on the added branch.
// 25: fixAltitude helper added to igc-parser (GNSS→pressure fallback on the
//     zero sentinel). Scoring behaviour itself is unchanged — the helper is
//     consumed by the flight-phase detectors and field analysis, not the
//     scorers — so this bump is the guard's "harmless extra cache roll".
// 26: altitude cleaning — parseIGC now runs a plausibility pass (GNSS-vs-
//     baro rolling-residual cross-check, vertical-rate excursion rule for
//     single-channel tracks) that repairs glitch fixes into
//     IGCFix.cleanedAltitude, and every altitude consumer (detectors,
//     turnpoint crossings/altitude bonus, takeoff/landing, glide speed)
//     reads through fixAltitude(). Scores only move where a track carried a
//     GPS altitude glitch on a fix that mattered.
// v27: track data-quality validation (FAI S7A §4.4.2, §4.4.6). A new module,
//     track-quality.ts, assesses every submitted tracklog against its task
//     before it is scored; the backend withholds a HARD-failed track from
//     scoring AND from field analysis, seating the pilot last at zero with the
//     reasons attached rather than letting them vanish from the results.
//     §4.4.2 puts this obligation on the verification software — "all points
//     used to verify the flight occurred at reasonable times (e.g. on the day
//     in question)" — and nothing checked it, because time-gates.ts resolves
//     the task's gates near an instant taken from the FLIGHT, so a tracklog
//     from another day silently relocated the task onto its own calendar day
//     and scored normally.
//     Two HARD checks: the fixes fall wholly outside the task's LOCAL day by
//     more than a day (the local day, resolved in the comp's zone, is what
//     lets an Australian task flown 00:09–04:13 UTC pass; the one-day grace is
//     because a recorder set a day out is a real recurring fault — three
//     Bright Open 2020 pilots, one of whom placed 4th in goal), or no fix
//     comes within 100 km of ANY turnpoint. Three SOFT checks only annotate —
//     never left the take-off cylinder, no sign of flight, implausible
//     sustained speed — because a short honest flight still earns the §5.3 /
//     §8.6.1 minimum distance and that behaviour is correct.
//     §4.4.6 makes rejecting a track log the organiser's judgement, so the
//     verdict is overridable per track (task_track.quality_override).
//     Withholding a track changes numPresent, hence launch validity and every
//     distance ratio on an affected task; tasks with no hard-failed track
//     recompute identically.
// v28: NO behaviour change — a payload roll. The scored body now carries the
//      transparency fields the score-details page needs to show its working:
//      per-class `validity_inputs` (the field counts, best distance/time, goal
//      ratio, weights and the mean distance over minimum that the validity and
//      weight formulas were evaluated from), the fully-resolved `gap_params`
//      the class was actually scored with (comp settings AND the task's own
//      migration-0021 overrides, "auto" nominal distance already resolved),
//      and each pilot's `leading_coefficient`. Every point on the page is
//      unchanged; only what the page can explain about them changes.
//      Bumped deliberately even though scoring is identical: the fields are
//      optional and every consumer degrades without them, but the stale-first
//      store would otherwise serve pre-change bodies for settled comps
//      indefinitely — and a settled comp is exactly the one a pilot reads.
// v29: NO behaviour change — a second payload roll, same shape as v28. Each
//      pilot's ESS arrival position and ESS time are now carried on
//      PilotScore, so the report card can substitute the §11.4 arrival
//      formula instead of asserting its output. The scorer computed the
//      position all along (essPositionMap) and discarded it, which left
//      arrival as the one component whose arithmetic could not be shown —
//      and, more importantly, left unsaid that the order is by wall-clock
//      time at ESS rather than by speed.
// v30: NO score change on well-formed tracks — algorithmic hardening against
//      adversarial IGC files (#470 SEC-32, #471 SEC-33). The cross-channel
//      rolling residual median is now maintained incrementally by an exact
//      order-statistic structure (same window multiset → same two middle
//      values → identical float baseline), the never-airborne glide check
//      takes its window minimum from a monotone deque, and rateClean's
//      excursion return-scan stops at a non-forward timestamp. All three were
//      quadratic when a crafted file stamped tens of thousands of fixes into
//      one small time span — a per-upload CPU sink, since cleaning runs
//      inside parseIGC on every upload. Only tracks whose timestamps jump
//      backwards — already corrupt — can score differently, and only via the
//      rate path.
// v31: NO behaviour change — the 2026-08-06 engine code quality review. The
//      scorer's three derived predicates (distance difficulty, the effective
//      ESS-not-goal factor, the best-time source) are exported and called by
//      the explainers instead of being re-typed by hand in each of them; the
//      WGS84 metres-per-degree series and the radians→compass conversion each
//      collapse to one definition in geo.ts; resolveSequenceOnce becomes the
//      named pipeline its FAI-citing comments already described; and the eight
//      inline S7F §11 roundings in the scorer call the helper that file
//      defined. Every arithmetic expression was carried across unchanged, and
//      the two coarse metres-per-degree approximations (the circle fit, the
//      crossings bounding-box pre-filter) were deliberately KEPT rather than
//      made accurate — the bbox one is load-bearing, since a denominator that
//      is too LARGE would shrink the box and could discard a fix the exact
//      distance check accepts.
//      scoreFlights' seven numbered step comments likewise became five named
//      steps, and the 2,128-line score-explanation-sections.ts became eleven
//      per-concern modules behind the same entry module.
//      FlightScoringData's four correlated optionals (leadingAggregate, fixes,
//      sequence, trackless) are now one required discriminated union,
//      FlightLeadingInput — 'aggregate' | 'track' | 'none'. The runtime throw
//      that described the invariant in prose is gone, because the invariant is
//      now in the type. The stored per-track payload is UNCHANGED: it was
//      always the backend's own flat CachedFlightAnalysis rather than
//      FlightScoringData, and the worker converts at the boundary in both
//      directions, so no revive step was needed and no D1 row changes shape.
//      The fingerprint also moves because the guard's own root list grew:
//      manual-flight.ts measures a track-less pilot's distance and the backend
//      calls it directly, so it reached published scores while sitting outside
//      every root's import closure. The cache roll is harmless — scores
//      recompute identically, verified byte-for-byte over 376,405 scored
//      fields spanning every bundled task across 14 parameter variants.
// v32: S7F §6.4 distance definitions (2024 edition), verified against the
//      211-comp archive. Four related changes to the optimiser and the
//      flown-distance measurement:
//      (a) Launch centre (Annex A §2.2) — every route is measured from the
//      first turnpoint's CENTRE "regardless of whether it has been given a
//      radius", not just when it is typed TAKEOFF. Tasks whose route begins
//      at the start cylinder (common in AirScore imports — ~60 archive
//      tasks) previously lost exactly the start radius: 5–10 km of task and
//      flown distance. The one deliberate exception is the trimmed task
//      behind distanceOrigin 'start' (scored distance there begins at the
//      start crossing), marked by the new XCTask.firstTurnpointAtBoundary.
//      (b) ESS pin (Annex A §3.2.4) — a mid-route ESS fix is "pinned to the
//      preceding points": the nearest boundary point toward the incoming
//      leg, never dragged toward goal. The task path now kinks at ESS, and
//      its launch→ESS prefix equals the §6.4.2 launchToESSPath by
//      construction, so the sliced speed-section length feeding the leading
//      coefficient and the §12.3.3 stopped validity is the spec's number
//      (2.5 km long on the worst archive task before).
//      (c) §8.6.1 flown distance — a landed-out pilot's remaining distance
//      is now a fresh shortest-path optimisation from each candidate fix
//      through the un-reached zones to goal (branch-and-bound over the
//      track, 5 m tolerance), replacing the frozen-tag approximation; the
//      measured route is carried on BestProgress.remainingRoute so the map
//      draws exactly what was scored. Manual flights measure the same way.
//      Against AirScore's published per-pilot distances (Corryong Cup 2026
//      T1) the mean error drops from 66 m to under 50 m with the worst
//      pilot inside 100 m (was 385 m).
//      (d) Deterministic tag on a crossed cylinder — when a leg passes
//      straight through a cylinder every chord point ties; the tag now sits
//      at the boundary point nearest the chord (the spec's construction,
//      matching AirScore's published cumulatives) instead of wherever the
//      numeric search landed. Also: nearest-boundary points are computed
//      from the centre's bearing (the reversed-bearing shortcut drifted by
//      meridian convergence — tens of metres on long legs), a converged
//      pass is adopted rather than discarded, and the optimised task line
//      is cached per task object (content-keyed), which pays for the extra
//      §8.6.1 optimisations.
// v33: NO score change — explanation copy and comment corrections. The
//      land-out "best progress" narrative now describes the marked point as
//      the one with the least distance still to fly, measured as the
//      shortest route through the remaining turnpoints to goal — the v32
//      §8.6.1 measurement — instead of "where the track came closest to the
//      next turnpoint", which the exact measure no longer guarantees. Doc
//      comments that still described the frozen-tag approximation as the
//      scored measurement (NextTPMeasure, computeTaskGeometry,
//      nextTPMeasurer) and the distanceOrigin claim that SSS-first tasks
//      score identically under both origins (false since the v32 launch-
//      centre rule — they differ by the start radius) are corrected. Every
//      point is unchanged; the bump rolls the stale-first store so settled
//      comps serve the corrected narrative rather than the old wording
//      indefinitely.
// v34: the task's declared cylinder tolerance is honoured (issue #577).
//      parseXCTask now reads the xctsk file's `cylinderTolerance` field —
//      the XCTask type, the API validator, the AirScore importer (which
//      writes the comp's error_margin into it) and the route editor all
//      already carried it, but the parser dropped it, so every task scored
//      with the 0.5% engine default (§8.1 Cat 2 maximum) instead of the
//      band the comp declared (0.05% on most imported comps — 10× tighter).
//      Scores move only where a crossing decision fell between the two
//      bands. The found case is bright-open-2025-open-t3: the takeoff sits
//      INSIDE the 33.5 km ENTER start ring, pilots exit past the boundary
//      by ~100 m and re-enter to start, and the default band (167.5 m at
//      that radius) never saw them outside — no enter crossing, no start,
//      the whole field scored landed out at ~14 km instead of the published
//      101.66 km. With the declared 0.05% band the field resolves to goal.
// v35: the leading coefficient's land-out tail runs to the spec's field-level
//      `maxTime` (issue #585, S7F §11.3.1):
//
//        maxTime = min(max(lastOutlandingTime, lastESStime), taskDeadline)
//
//      Both variants inherited AirScore's tail instead. The classic (HG) one
//      ran to max(lastESStime, the pilot's OWN last fix) — per-pilot, so a
//      pilot who landed early was never carried out to the field's last
//      land-out; the weighted (PG) one ran to lastESStime alone and never
//      extended at all for the pilots the prose is about ("for pilots who land
//      out after the last pilot reached ESS, the calculation keeps going until
//      they land"). Neither capped anything at the task deadline.
//      `maxTime` is now resolved once per class from the whole field — the
//      last land-out is the latest tracklog end among started pilots who never
//      reached ESS — and capped at the goal deadline (§8.3.c) and, on a
//      stopped task, at the stop time (§12.3.1), since nothing after either is
//      scored and a recorder left running would otherwise stretch every
//      pilot's tail. A deadline at or before the first start is ignored, the
//      same task-setting mistake resolveTimingWindow already ignores. Both
//      tails are floored at zero: the cap can land maxTime before a very late
//      starter's own crossing, and a negative tail would hand that pilot the
//      field's best coefficient.
//      Measured over the 58 leading-scored tasks of the 211-comp archive
//      (1,521 scored pilots): 12.5% of pilots' leading points move, mean
//      |Δ| 1.9 points, p95 4.9, and 2.7% change rank. Distance, time and
//      arrival points are untouched. A task where the last land-out came
//      before the last ESS is bit-identical — 32 of the 58.
//      The movement is NOT uniform: it concentrates on the 9 archive tasks
//      where NOBODY reached ESS, and there it is a correction, not a
//      perturbation. With no last-ESS time the old tail fell back to each
//      pilot's OWN last fix, so a pilot was charged for the whole time they
//      stayed up and credited for landing early — the leading order came out
//      close to the landing order. On Forbes 2022 task 7 the pilot with the
//      old best coefficient (1.63, full leading points) is the first to land;
//      under one shared maxTime they hold the WORST of the field (7.93) and
//      the pilot who got nearest ESS takes the points. Those tasks also moved
//      CLOSER to AirScore's published totals (Forbes 2025 task 4: mean
//      |Δtotal| 34.7 → 25.6), despite the change being a deliberate departure
//      from AirScore.
//      The scored payload also carries the resolved clock per class
//      (`leading_times`: first start, last ESS, last land-out, deadline, stop,
//      and the maxTime they produce), because `maxTime` is the one input to a
//      landed-out pilot's coefficient that lives entirely outside their own
//      flight — the report card now names it and says which field time set it.
export const SCORING_ENGINE_VERSION = 35;

/**
 * SHA-256 (hex) over the scoring-relevant engine sources, maintained by
 * tests/scoring-version.test.ts. Update it (and bump the version above)
 * when the test tells you to.
 */
export const SCORING_SOURCE_FINGERPRINT =
  "2ceb0936f78dea40af7ecbd583d2140f26db596b14a271e564486366eced1ec7";
