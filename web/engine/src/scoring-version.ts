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
// v35: NO pilot's points change — the S7F §10 "nobody reaches ESS" rule
//      (issue #583). On a hang-gliding task where numReachedESS is 0, the
//      spec's HG box sets AvailableTimePoints and AvailableArrivalPoints to
//      zero, and redistributes nothing: distance and leading keep their usual
//      weights and the remainder of the day is left unallocated. GlideComp
//      published the normal non-zero figures, so the scoreboard and the report
//      card advertised points nobody could win — time points require an ESS
//      crossing and the arrival position map is empty, so both components were
//      already zero for every pilot.
//      calculateWeights now takes the ESS count and returns zeroed time and
//      arrival fractions in that case; availablePoints follows, while
//      availablePoints.total stays 1000 × task validity (the day's worth), so
//      the components deliberately fall short of it by the unallocated
//      remainder. Every explanation that compares a pilot against "the day"
//      now names that remainder rather than presenting it as points they left
//      untaken.
//      Bumped because availablePoints and validity_inputs.weights are part of
//      the cached payload: without a roll the stale-first store would serve
//      the pre-change figures for settled comps indefinitely.
// v36: the PG early-start distance is the flat launch→SSS value (issue #584).
//      §12.2 scores a paraglider pilot who jumps the gun "for the distance
//      between the launch point and the SSS control zone, as calculated when
//      determining the complete task distance (see 6.4.1)" — a fixed award.
//      applyEarlyStarts capped it at the pilot's own flown distance, which is
//      stricter than the spec for the one case where the two differ: an early
//      starter who then landed short of their own start. That cap is gone.
//      Scores move only for such a pilot (the §11.1 minimum-distance floor
//      still applies underneath). The report card's distance section now
//      prints which value applied — the launch→start leg beside what was
//      actually flown, or the minimum when the leg falls below it.
// v37: HG leading weight follows the S7F §10 HG box on a no-goal day (the
//      adjacent deviation found while fixing #583). The spec gives hang
//      gliding ONE formula, (1 − DistanceWeight) ÷ 8 × 1.4, with no GoalRatio
//      case; the "0.1 × BestDist ÷ TaskDist when nobody makes goal" rule is
//      the PARAGLIDING GAP2016/2018 legacy weight (stored as 'gap2020', kept
//      for AirScore parity). The branch testing it never tested the sport, so
//      it caught HG too — handing a no-goal HG day a leading weight that
//      scaled with how far the field flew, up to 0.1, where the spec offers
//      0.0175. It also made the weight JUMP discontinuously the moment the
//      first pilot reached goal.
//      This MOVES POINTS, unlike v35. Over the 211-comp archive: 184 GAP
//      tasks scored with their own stored formula, 9 affected (all HG, no
//      goal, leading enabled), 70 pilot totals changed, largest 82.4 points
//      — a Dalby Big Air 2022 sports-class leader whose available leading
//      points fall from 99.9 to 17.5. Every affected task also had nobody at
//      ESS, so under v35 those points are not redistributed: the day now caps
//      at the spec's 900 + 18 = 918. The 41 HG tasks with leading on and
//      pilots in goal, and all 30 PG tasks, are unchanged.
// v38: the leading coefficient's land-out tail runs to the spec's field-level
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
//      (1,521 scored pilots), against a master that already carries v37:
//      12.6% of pilots' leading points move, mean |Δ| 0.6 points, p95 3.3,
//      largest 17.8, and 2.0% change rank. Distance, time and arrival points
//      are untouched, and 34 of the 58 tasks are unchanged — every one whose
//      last land-out came before the last ESS.
//      The movement concentrates on the 9 archive tasks where NOBODY reached
//      ESS, and there it is a correction, not a perturbation. With no last-ESS
//      time the old tail fell back to each pilot's OWN last fix, so a pilot
//      was charged for the whole time they stayed up and credited for landing
//      early — the leading order came out close to the landing order. On
//      Forbes 2022 task 7 the pilot with the old best coefficient (1.63, all
//      17.5 leading points on offer) is the first to land; under one shared
//      maxTime they hold the WORST of the field (7.93) at 0 points, and the
//      pilot who got nearest ESS takes the 17.5. Those tasks also moved CLOSER
//      to AirScore's published totals (Forbes 2022 task 7: mean |Δtotal|
//      33.7 → 25.8; Forbes 2025 task 4: 27.6 → 25.5), despite the change being
//      a deliberate departure from AirScore.
//      v37 is why the numbers are small: it cut a no-goal HG day's leading
//      offer from up to 100 points to the spec's 17.5, and those are exactly
//      the days this changes most. Against the pre-v37 master the same run
//      moved a pilot by as much as 93 points.
//      The scored payload also carries the resolved clock per class
//      (`leading_times`: first start, last ESS, last land-out, deadline, stop,
//      and the maxTime they produce), because `maxTime` is the one input to a
//      landed-out pilot's coefficient that lives entirely outside their own
//      flight — the report card now names it and says which field time set it.

// v39: goal-line tolerance and crossing direction (issue #359, S7F §8.2,
//      §8.5.2). Two changes at a LINE goal, both at the margins of the line:
//      (a) §8.2 line tolerance — the goal line now carries the same
//      percentage band a cylinder gets (§8.1), with the same 5 m floor,
//      taken over the line's length. At a goal line what the band buys is
//      LENGTH: a crossing that lands up to the tolerance past an endpoint is
//      credited, flagged toleranceCredited so the report card says so. The
//      band never moves a crossing's time or position — a pilot who clipped
//      the end is credited where their track met the line's plane. §8.4's
//      other half (a fix closer to the line than the tolerance reaches it
//      without crossing) is deliberately NOT applied at goal: §8.5.2 requires
//      the goal line be crossed in flight, and that clause is the only part
//      of the band that could shift an ordinary goal TIME. The control
//      semicircle behind the line gets the §8.1 cylinder band too, which
//      §8.5.2 mandates in as many words ("the same tolerance calculations
//      apply as for full cylinders") — so its radius grows by max(0.5%, 5 m).
//      (b) §8.5.2 direction — a track segment crossing the goal line the
//      WRONG way (both fixes outside the control zone, the pilot leaving
//      across the line) no longer records a crossing. It used to emit an
//      instantaneous enter+exit pair, and the goal task position accepts the
//      first crossing of either direction, so flying out across the line
//      could credit goal to a pilot heading away from it.
//      Only tasks with a LINE goal can move, and only pilots within a few
//      metres of an endpoint or crossing the line backwards; every bundled
//      comp scores identically.

// v40: FAI S7F 2026 edition, phase 1 — parameter model + constants
//      (docs/2026-08-09-s7f-2026-migration-plan.md). GlideComp now scores
//      every task under the 2026 edition; the pre-2026 formula variants are
//      deleted, not selectable. In this phase:
//      - Launch validity linear coefficient 0.027 → 0.028 (§10.1; the 2025
//        edition fixed a typo dating from ~2014). Every task's launch
//        validity moves by up to ~0.0005.
//      - Nominal Launch (96%) and Nominal Goal (30%) are fixed spec values,
//        no longer parameters (§10.1, §10.2). Comps that stored other values
//        (engine baseline nominalGoal 0.2 included) are now scored at the
//        fixed ones.
//      - The PG leading-weight generations ('gap2020' GAP2016/2018,
//        's7f2020' PWC, 's7f2024') are gone; §11 is the one formula for both
//        disciplines: LeadingWeight = (1 − DW) · LeadingTimeRatio, with the
//        whole non-distance weight to leading on a no-goal PG day. HG gains
//        LeadingTimeRatio as a settable task parameter (default 17.5%,
//        numerically identical to the old hard-wired (1 − DW)/8 · 1.4).
//      - LeadingTimeRatio range 0–26% (§11; was 0–50%).
//      - The 2/3 time-points exponent is gone; §12.2's 5/6 is the only curve.
//      - The LC variant (classic/weighted) is pinned per discipline
//        (§12.3.1), no longer a parameter.
//      - Best time (§9.4.1) is discipline-pinned: HG from all ESS pilots,
//        PG goal-validated — no longer keyed off essNotGoalFactor.
//      - Stopped tasks: score-back fixed at HG 15 min / PG 5 min (§13.4.1;
//        the PG scoreBackTime parameter and the HG gate-interval rule are
//        gone); PG has no minimum-duration requirement (§13.4.2); the PG
//        altitude-bonus glide ratio is 2.5 (§13.4.6; was 4.0).
//      Historical comps and AirScore imports are rescored under these rules
//      by design (owner decision, 2026-08-09): GlideComp keeps no
//      multi-edition support, and pre-2026 comps carry an "indicative
//      scores" notice in the UI instead.

// v41: FAI S7F 2026 edition, phase 2 — the new PG leading coefficient
//      (§12.3.1, introduced by the 2025 edition). The weighted leadingArea
//      is now minToESS(tpᵢ) · taskTime(tpᵢ) · ∫ weight(x) dx over each
//      fix interval's done-fraction span, with the envelope integral in
//      exact closed form (leadWeightIntegral — the (1−10^{9p−9})⁵(1−10^{−3p})²
//      product expands to 18 integrable exponential terms). The missingArea
//      tail is minToESS(best) · maxTime · ∫ weight over the never-flown
//      remainder, replacing the old weightFalling(best)·maxTime·best term.
//      The previous implementation was the AirScore weightedarea form
//      (weight(p)·Δbest·time — a point-sampled Riemann sum with progress as
//      the amplitude); the 2026 form weights by REMAINING distance instead,
//      so every PG leading coefficient moves and land-out tails shift most.
//      HG (classic) is unchanged. The LeadingAggregate cache split
//      (weightedTimeSum/weightedDeltaSum) keeps the same rebasing shape, so
//      cached aggregates recompute under the new contribution formula via
//      the version bump alone.

// v42: FAI S7F 2026 edition, phase 3 — stopped tasks (§13.4.5, §13.4.6).
//      Three changes to stopped-task scoring:
//      (a) §13.4.5 truncation: EVERY pilot is scored only up to the task
//          stop time. The 2024 exemption — a pilot at/after ESS at the stop
//          scored for the complete flight, including a goal crossing after
//          the stop — is gone; such a pilot is now scored as between ESS
//          and goal (distance + leading + their ESS time, no goal).
//      (b) §13.4.5 points scheme: with nobody in goal at the stop the task
//          offers no time points at all; with goal pilots, the reduction is
//          the standard §12.2 time points the best pilot between ESS and
//          goal would have received (falling back to the hypothetical
//          ESS-at-window-end pilot when nobody is between), every goal
//          pilot's time points are docked by it, and the SAME AMOUNT is
//          added to the day's available distance points — the published
//          availablePoints.distance now carries the boost.
//      (c) §13.4.6 bonus position: the altitude bonus is computed only for
//          the pilot's position at the task stop time (the last in-window
//          fix), not as the best over every fix; the scored distance is
//          max(best distance up to the stop, stop position + bonus).

// v43: FAI S7F 2026 edition, phase 4 — task evaluation (§9.1, §6.2.3.1).
//      (a) Tolerances are the fixed 2026 values: 0% relative + 5 m absolute
//          for cylinders (§9.1.1, decided at the 2025 Plenary), a flat 5 m
//          for lines and the goal-line band (§9.1.2, §9.1.3). A task file's
//          declared `cylinderTolerance` is now IGNORED by scoring (owner
//          decision, 2026-08-09 — supersedes issue #580's behaviour); the
//          field still parses and round-trips, and the route editor no
//          longer edits it. Tasks that scored under the old 0.5% default
//          (or a declared value) get narrower bands, so tolerance-credited
//          reachings at band edges can change.
//      (b) Goal line orientation (§6.2.3.1, changed by the 2025 edition):
//          the line is perpendicular to the OPTIMISED route's previous
//          point p on the last control zone before goal — computed from a
//          route with the goal treated as its centre — instead of the
//          previous turnpoint centre. Angled final legs rotate the line by
//          the difference between the centre-to-centre bearing and the
//          optimised approach.

// v44: FAI S7F 2026 edition, phase 5 — geodesic distances (§7.1.4, §7.1.5).
//      The engine's one inverse-distance function is now the Vincenty
//      (1975) inverse — one of §7.1.4's three sanctioned InverseGeodesic
//      algorithms — replacing Andoyer-Lambert, which §7.1.5 relegates to
//      navigation devices ("scoring software shall calculate this distance
//      by using the InverseGeodesic algorithm"). andoyerDistance is gone;
//      ellipsoidDistance (the spec's own name) is the export, with Andoyer
//      retained only as the non-convergence fallback that task-scale
//      geometry cannot reach. Every distance in the engine moves by up to
//      ~2 ppm (centimetres at task scale); snapshot values corrected to the
//      published Vincenty references (e.g. the 1° meridian arc is now
//      110 574.39 m, exact). Best-progress eligibility also changed from
//      strictly-after to at-or-after the last reaching time: a crossing
//      that interpolates exactly onto a fix (a fix landing precisely on a
//      cylinder's nominal radius — now possible, since Vincenty inverse
//      round-trips Vincenty direct exactly) no longer costs that fix its
//      measurement.
//      The §7.1.3 PathFinder route optimisation (LTM projection + Ding et
//      al. 2018) is NOT yet adopted: the existing corpus-verified optimiser
//      stands in, as a documented deviation on /scoring/gap.

// v45: FAI S7F 2026 edition, phase 7 — transparency. NO numeric change:
//      every spec citation in the scoring sources (comments and the
//      explanation strings the report card prints) is renumbered from the
//      2024 edition's section numbers to the 2026 edition's (§8→§9 task
//      evaluation, §9→§10 validity, §10→§11 allocation, §11→§12 pilot
//      score, §12→§13 special cases, §15→§16 FTV, Annex A→§7.2), and the
//      published payload now carries `rules_edition: "s7f-2026"` so every
//      consumer can say which edition scored it. The bump exists because
//      the explanation strings live inside scoring sources; recomputation
//      changes only those strings.
export const SCORING_ENGINE_VERSION = 45;

/**
 * SHA-256 (hex) over the scoring-relevant engine sources, maintained by
 * tests/scoring-version.test.ts. Update it (and bump the version above)
 * when the test tells you to.
 */
export const SCORING_SOURCE_FINGERPRINT =
  "281f72a3853a29035d44f83d3d3cce1d8e98d5133a3486c35c77bf0c25caf0e0";
