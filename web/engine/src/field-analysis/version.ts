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
// v3: day.wind's Dir cell now renders "<deg>° <compass> <arrow>" (compass
//     point + wind-travel arrow) instead of bare degrees. Presentation-only,
//     but the stored table strings change, so bump to reroll cached reports.
export const FIELD_ANALYSIS_VERSION = 3;
