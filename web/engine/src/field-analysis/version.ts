// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Version of the field-analysis metrics' observable behaviour.
 *
 * The competition API stores it on every materialized `task_field_analysis`
 * row and treats a mismatch as staleness, so a deploy that changes what a
 * metric measures rolls every stored report with no migration step —
 * recomputes then spread over organic traffic instead of stampeding.
 *
 * This is deliberately SEPARATE from SCORING_ENGINE_VERSION. The stored row
 * checks both: scoring changes move the GAP ranks every correlation is
 * measured against, and metric changes move the values. Bump this one
 * whenever a MetricComputer's compute() changes, a metric is added or
 * removed, or the shared foundation (context/resample/shared-thermals/
 * phase-partition/working-band/stats/evaluate) changes a number.
 *
 * Unlike SCORING_ENGINE_VERSION there is no fingerprint guard here: these
 * metrics are exploratory and not a scoring input, so a missed bump costs a
 * stale admin report, not a wrong score.
 */
// v1: initial release — 26 metrics across 6 families (day profile & wind,
//     climbing, gliding, decision-making, gaggle, race craft), each ranked
//     by Spearman correlation against GAP rank.
// v2: race.time_behind and race.leg_time_lost additionally emit extraSeries
//     (structured horserace/waterfall data for the UI's charts) alongside
//     their extraTables. No metric VALUE changed; the bump exists so stored
//     reports regain the new field on their next lazy revalidation.
// v3: day-profile & climbing hour/clock LABELS render in the competition's
//     time zone (FieldContext.timeZone) instead of always UTC. No metric
//     value changed — only the "HH:00 UTC" row/summary text — but the bump
//     rolls stored reports so their labels pick up the comp zone.
// v4: report tables emit times of day as machine-readable instants
//     (ReportCell `{ t: ISO }`) instead of pre-formatted "HH:00 UTC" strings,
//     and the two prose "by hour"/"takeoffs … UTC" summaries became tables —
//     so the consumer (web in comp time, CLI in the task's local time) renders
//     the zone. No metric value changed; the bump rolls stored reports onto
//     the new shape.
// v5: day.wind split into two tables — "Wind by hour" (time view: whole-task
//     total + per-hour) and "Wind by leg" (course view) — instead of one table
//     mixing hour and leg rows in a single "Scope" column. The leg table gains
//     a "When" column: a `{ from, to }` instant-range cell (new ReportCell
//     variant) showing the field's circling window for that leg. No metric
//     value changed; the bump rolls stored reports onto the new shape.
// v6: day.launch_timing "Best conditions" is now an hour RANGE (not a bare
//     hour-start instant) and ignores sparse hours (< 20% of the busiest
//     hour's climbs) when picking the best — a thin sliver right after launch
//     no longer wins and then reads as predating the earliest takeoff.
// v7: the day-profile metrics emit charting series alongside their tables —
//     day.wind → 'wind-hourly' + 'wind-legs', day.climb_by_hour →
//     'climb-hourly' (full p10/p25/median/p75/p90 fan), day.launch_timing →
//     'day-timing' (best hour, every takeoff, resolved start gates / launch
//     window / goal deadline) — feeding the UI's shared-time-axis day-profile
//     panel. No metric value changed; the bump rolls stored reports so they
//     regain the new series on their next lazy revalidation.
// v8: correlation verdicts are n-aware. Every MetricCorrelation carries the
//     α = 0.05 noise floor for its n (spearmanNoiseFloor), and a coefficient
//     under it earns the new verdict 'within noise' regardless of magnitude —
//     at n = 10 shuffled ranks routinely produce |ρ| ≈ 0.63, so the old
//     n-blind thresholds could brand luck "strong". ρ values are unchanged;
//     the bump rolls stored reports so their verdicts and noise floors
//     recompute on the next lazy revalidation.
// v9: two metrics made honest (explanation ↔ computation parity).
//     glide.track_efficiency now sums only NON-CLIMB path distance per leg —
//     it previously included every thermal circle, so it mostly re-measured
//     climb count while claiming line choice; values drop toward 1.0 and the
//     known constant offset from circling disappears. day.launch_timing is
//     renamed day.airtime_quality with direction 'neutral': the computed
//     quantity is the non-sinking airtime share (which launch timing feeds
//     but does not determine), and its old 'higher' prior flipped sign on
//     ~half of real tasks. The bump rolls stored reports onto the new
//     values/id on their next lazy revalidation.
// v10: gaggle.departure_winrate comparator validity. Stayers must (a) still
//     be in the gaggle at the snapshot after the split — a same-split
//     co-leaver is not a stayer — and (b) have reached the leaver's next
//     turnpoint AFTER the departure: on out-and-return tasks, outbound and
//     returning pilots share thermals while on different legs, and a
//     returner who tagged that turnpoint before the split decided the
//     "race" on course position, not on the departure. With typical 1–3
//     departures per pilot, one mislabelled outcome flipped a pilot between
//     0% and 100%. The bump rolls stored reports on lazy revalidation.
// v11: the basis reports a climb/glide/search phase SPLIT instead of
//     phaseCoveragePct. Coverage was 100% on every task by construction —
//     partitionPhases tiles takeoff→landing with no gaps or overlaps, so the
//     fact restated its own invariant (now guarded by the phase-partition
//     tests alone) rather than describing the day. The split is pooled over
//     the field: total seconds per phase / total phase seconds. No metric
//     value changed; the bump rolls stored reports so they carry the new
//     basis field on their next lazy revalidation. Consumers must tolerate
//     its absence — a v10 row is served stale while it revalidates.
// v12: tracklogs that fail a HARD data-quality check (engine
//     track-quality.ts) are excluded from the analysed field and listed in
//     the report's basis with the reason, alongside the manual-flight and
//     unreadable-track entries. Such a track corrupts far more than its own
//     row: the hour-bucketed metrics and the 'day-timing' series work in
//     ABSOLUTE instants, so one track ten days off its task stretched the
//     shared day-profile axis from ~5 hours to 262 (the resample grid was
//     already capped by MAX_GRID_HOURS, so the fault is in those metrics, not
//     the grid — fix the right layer), and its air polluted the wind and
//     working-band estimates. Every metric's n drops by the excluded pilots,
//     so the correlations move; the bump rolls stored reports onto the new
//     values on their next lazy revalidation.
// v13: the v11 basis field is renamed `phaseSplit` → `airtimeSplit` (type
//     FieldPhaseSplit → FieldAirtimeSplit), and both surfaces label it
//     "airtime split" with gerund phase names ("38% climbing"). "Phase" named
//     the partition rather than the measure, so nothing said the percentages
//     were of TIME — on a page this full of distance-derived metrics, a split
//     of distance is an equally plausible reading. No value changed; the bump
//     rolls stored reports onto the new field name, and v11/v12 rows render
//     without the split until they revalidate.
// v14: the basis gains `analysisWindow` (first takeoff → last landing, ISO
//     instants, zone rendered by the consumer) and both surfaces pair it with
//     the airtime total: "82 h (13:05–18:40 AEDT)". A bare total can't say
//     whether 80 hours was a long day or a crowded one. The grid step moves
//     out of the UI's basis box to the metric glossary — it is fixed at 10 s
//     for every task and comp, so it was permanent furniture saying nothing,
//     but it is still part of how the numbers were made and so still stated.
//     No metric value changed; the bump rolls stored reports so they gain the
//     window on their next lazy revalidation.
// v15: every metric renamed to say what it MEANS rather than how it is
//     computed (issue #454), and two metrics reshaped because no name could
//     rescue their units. Names now lead with the family's own vocabulary
//     ("Gliding wide of the optimal course line", "Climbing faster than the
//     pilots sharing the thermal") and carry no parenthesised explainer — a
//     name that needs a gloss in brackets is a name that has not landed. Each
//     explanation now opens with the insight in pilots' own words (coring,
//     topping out, marker, low save, speed to fly, dolphin flying, final
//     glide) before the method. The two reshaped metrics:
//       · decision.climbs_per_100km → decision.km_between_climbs. "Climbs per
//         100 km" made the reader do arithmetic to reach the question it was
//         answering — how far do you get between stops? That is now the value
//         itself, in km, direction 'higher'. Reciprocal, so |ρ| is unchanged
//         and the sign flips with the direction. Zero climbs after the start
//         is now null (a glide-out with nothing to measure) instead of 0,
//         which under the old 'lower is better' read as the BEST score.
//       · glide.track_efficiency → glide.extra_distance, a percentage EXCESS
//         over the optimised line (12% = flew 12% further than required)
//         instead of a bare ratio (1.12). Monotone linear, so ρ is unchanged.
//     The bump rolls stored reports onto the new labels/ids on their next lazy
//     revalidation.
// v16: glide.extra_distance stops counting SEARCH meander as line deviation.
//     Only a glide is measured at its full path length now; every other phase
//     (climb and search alike) contributes its entry-to-exit displacement.
//     This is the v9 fix finished — v9 removed circling path for exactly this
//     reason and left searching in, which turned out to be the larger half: a
//     scratching pilot's path runs 1.6–2.0× its own displacement and search
//     fills 17–44% of a leg, so most of the "extra distance" the metric
//     reported was hunting for lift (collinear with decision.search_fraction)
//     rather than the line choice the name promised. On Corryong 2021 open T1
//     the field's readings drop from 24–220% to 9–78% and |ρ| against rank
//     RISES 0.62 → 0.64: the removed distance was noise, not signal. Metric
//     values change, so the bump rolls stored reports on lazy revalidation.
//
//     Note for the record, since v15's shipped text said otherwise: the
//     metric's ZERO POINT was never offset. A pilot flown down
//     calculateOptimizedTaskLine scores 0.00%, and there is now a test that
//     says so ("reads 0% for a pilot who flies the optimizer's own line").
//     The ">1 even for a straight flier" offset noted in the plan doc is a
//     property of the synthetic TEST FIXTURE, whose reachings are pinned at
//     arbitrary east offsets instead of the optimizer's tag points — not of
//     the measurement. Absolute readings are meaningful.
// v17: day.wind's per-leg view carries the leg's FLOWN window beside its
//     circling window, plus the pilot count behind each. The two were
//     conflated: one window ("When") bounded the circle estimates, and the
//     Gantt drew it in the visual grammar of occupancy — so on Corryong 2026
//     open T1 the final leg into ESS drew at 16:28–16:30 while the leg before
//     it drew at 16:56–18:01, reading as the course flown out of order. Both
//     were right: the leaders glided KANGCK→CUDG without circling, and the
//     whole ESS-leg bar was ONE pilot's four circles over 112 seconds, shown
//     with the same weight as an 807-estimate leg. Legs now emit flownFrom/
//     flownTo/pilotsOnLeg (first entry → last exit, over pilots who started
//     and completed the leg, so the circling window always nests inside it)
//     and pilotsWithEstimates; the table splits "When" into "Flown" +
//     "Circling" with both counts. No wind value changed; the bump rolls
//     stored reports so they gain the windows on their next lazy
//     revalidation, and a v16 row renders with the circling window alone
//     until it does.
// v18: six metric LABELS rewritten to name the quantity the number is, rather
//     than to ask a question about it or to describe the behaviour in a
//     gerund clause — climb.time_to_core, climb.exit_decay,
//     climb.departure_band, glide.speed, glide.ld_vs_field and
//     glide.dolphin_fraction. Part of the Simplified Technical English pass
//     over the field analysis; the method text of every metric was rewritten
//     in the same change, but explanations are read live from the registry
//     and only labels are stored on the row. No metric value changed; the
//     bump rolls stored reports onto the new labels on their next lazy
//     revalidation, exactly as v3 and v15 did.
// v19: decision.altitude_floor is named, explained AND computed as the same
//     thing. It was labelled "How high the pilot commits to the next climb"
//     (Commit%) and explained as the height still in hand "at the moment they
//     commit to a climb", but the computation never looked at a climb: it swept
//     the 30 s-smoothed altitude trace for local minima with 100 m of
//     prominence either side. It is now "How low the pilot gets between climbs"
//     (Floor%), and it walks each consecutive PAIR of post-start climbs and
//     takes the lowest fix between them, keeping gaps that descended ≥ 100 m.
//     "Between climbs" is the loop bound rather than a property the prominence
//     sweep happened to produce, so the run out to the first climb, the glide to
//     goal and a sled run are excluded because nothing was climbed after them —
//     no smoothing, no prominence, and the reported low is a real fix altitude
//     instead of a 30 s mean that flattens a deep save upward.
//     Audited over the whole archive (184 tasks, 4,762 pilot-tasks). The two
//     definitions agree closely — Spearman 0.87 on pilot ordering, median 40.6%
//     of band against 38.2% — and separate the leaderboard equally: median |ρ|
//     0.43 against 0.40, stronger on 51% of tasks, a coin flip. The change is
//     made for explainability, not for signal. Coverage rises to 85.0% of
//     started pilots from 83.7%, but shifts WHICH pilots qualify: three climbs
//     are needed for two gaps where two dips used to do.
//     Direction also drops from 'higher' to 'neutral', the v9 treatment: over
//     147 archived tasks only 69% of ρ take the assumed sign, 16 are
//     wrong-signed at |ρ| ≥ 0.3, and two of those are large fields where it is
//     emphatic — Bright 2023 open T3 (85 pilots, ρ +0.73, top ten at 33% of
//     band against the bottom ten at 78%) and Bright 2024 open T2 (95 pilots,
//     ρ +0.52). Whether height in reserve pays is a property of the day, so the
//     sign is the finding, not a failure to match a prior.
//     Values move, so the bump rolls stored reports onto the new label,
//     direction and numbers on their next lazy revalidation.
// v20: the report gains an optional `thermals` field — shape summaries of the
//     task's shared thermals (altitude-banded cores, radii, sector lift roses,
//     sub-cores, lean and track-measured wind; point clouds stripped), from
//     field-analysis/thermal-shape.ts. Purely additive: no metric moves. The
//     bump rolls stored reports so they gain the field on their next lazy
//     revalidation instead of appearing thermal-less forever.
export const FIELD_ANALYSIS_VERSION = 20;
