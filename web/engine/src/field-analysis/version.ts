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
export const FIELD_ANALYSIS_VERSION = 9;
