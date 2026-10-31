/**
 * The files the results record carries inside itself.
 *
 * The printed tables are for reading: rounded, abbreviated, laid out for a
 * page. Reading numbers BACK out of a PDF's text is unreliable — columns
 * interleave, rows split across pages, long names wrap — so the file also
 * carries the exact data as PDF attachments (the e-invoicing trick: a page
 * for people, the data for software). An organiser, a spreadsheet or an AI
 * agent gets the numbers from these, not from the layout.
 *
 * Tabular data is CSV, because every spreadsheet opens it. What is not a
 * table — the GAP parameters each class was scored with, the leading clock,
 * a stopped task's arithmetic — is JSON, and each route is the task's own
 * `.xctsk`, which XCTrack and the rest of the sport already read.
 *
 * NO FIXED FORMAT (owner decision, 2026-10-31). These are what the API
 * published on the day the file was made; field names follow the API and may
 * change in a later export. The README says so. Committing to a schema
 * forever is exactly the storage burden the results record exists to avoid.
 *
 * Pure: strings in, strings out.
 */
import { toXctskJSON } from "@glidecomp/engine";
import type { ResultsRecordLoaderData } from "../react/loaders";
import { compPath, pilotPath, slugify, taskPath } from "../react/lib/slug";
import { buildScoresCsv, csvEscape } from "../scores-csv";

export interface RecordFile {
  name: string;
  mimeType: string;
  /** One line, shown by PDF viewers and listed in README.txt. */
  description: string;
  content: string;
}

export interface RecordMeta {
  /** Origin the URLs are absolute against (the serving request's own). */
  origin: string;
  generatedAt: Date;
}

/** Engine-precision floats carry noise (812.4399999); three places is exact
 * enough for every quantity here and keeps the cells readable. */
const r3 = (x: number | null | undefined): number | string =>
  x == null || !Number.isFinite(x) ? "" : Math.round(x * 1000) / 1000;

const csv = (header: readonly string[], rows: Array<Array<string | number>>): string =>
  [header.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n") + "\n";

const iso = (ms: number | null | undefined) => (ms == null ? "" : new Date(ms).toISOString());

export const TASK_RESULTS_COLUMNS = [
  "competition",
  "task",
  "task_date",
  "task_url",
  "pilot_class",
  "rank",
  "pilot_name",
  "comp_pilot_id",
  "made_goal",
  "reached_ess",
  "flown_distance_m",
  "speed_section_time_s",
  "ess_time_utc",
  "arrival_position",
  "leading_coefficient",
  "distance_points",
  "distance_linear_points",
  "distance_difficulty_points",
  "time_points",
  "leading_points",
  "arrival_points",
  "penalty_points",
  "penalty_reason",
  "jump_the_gun_penalty",
  "early_start_s",
  "track_withheld",
  "track_withheld_reasons",
  "total_score",
  "score_url",
] as const;

/** Every pilot on every scored task, every component of their score. */
export function buildTaskResultsCsv(data: ResultsRecordLoaderData, origin: string): string {
  const { comp } = data;
  const rows: Array<Array<string | number>> = [];
  for (const { task, score } of data.tasks) {
    if (!score) continue;
    const taskUrl = origin + taskPath(comp.comp_id, comp.name, task.task_id, task.name);
    for (const cls of score.class_scores) {
      for (const p of cls.pilots) {
        rows.push([
          comp.name,
          task.name,
          task.task_date,
          taskUrl,
          cls.pilot_class,
          p.rank,
          p.pilot_name,
          p.comp_pilot_id,
          p.made_goal ? "yes" : "no",
          p.reached_ess ? "yes" : "no",
          r3(p.flown_distance),
          r3(p.speed_section_time),
          iso(p.ess_time_ms),
          p.arrival_position ?? "",
          r3(p.leading_coefficient),
          r3(p.distance_points),
          r3(p.distance_linear_points),
          r3(p.distance_difficulty_points),
          r3(p.time_points),
          r3(p.leading_points),
          r3(p.arrival_points),
          r3(p.penalty_points),
          p.penalty_reason ?? "",
          r3(p.jump_the_gun_penalty),
          r3(p.early_start_seconds),
          p.track_excluded ? "yes" : "no",
          p.track_excluded?.reasons.join("; ") ?? "",
          r3(p.total_score),
          origin +
            pilotPath(comp.comp_id, comp.name, task.task_id, task.name, p.comp_pilot_id, p.pilot_name),
        ]);
      }
    }
  }
  return csv(TASK_RESULTS_COLUMNS, rows);
}

export const TASK_VALIDITY_COLUMNS = [
  "task",
  "task_date",
  "pilot_class",
  "rules_edition",
  "launch_validity",
  "distance_validity",
  "time_validity",
  "stopped_validity",
  "task_validity",
  "available_distance",
  "available_time",
  "available_leading",
  "available_arrival",
  "available_total",
  "num_present",
  "num_flying",
  "num_in_goal",
  "num_reached_ess",
  "best_distance_m",
  "best_time_s",
  "goal_ratio",
  "task_distance_m",
  "mean_distance_over_minimum_m",
  "weight_distance",
  "weight_time",
  "weight_leading",
  "weight_arrival",
  "scores_computed_at",
  "stale",
  "engine_generation",
] as const;

/** One row per task per class: the day's validity and the points it offered. */
export function buildTaskValidityCsv(data: ResultsRecordLoaderData): string {
  const rows: Array<Array<string | number>> = [];
  for (const { task, score } of data.tasks) {
    if (!score) continue;
    for (const cls of score.class_scores) {
      const v = cls.task_validity;
      const ap = cls.available_points;
      const vi = cls.validity_inputs;
      rows.push([
        task.name,
        task.task_date,
        cls.pilot_class,
        cls.rules_edition ?? "",
        r3(v.launch),
        r3(v.distance),
        r3(v.time),
        r3(v.stopped),
        r3(v.task),
        r3(ap.distance),
        r3(ap.time),
        r3(ap.leading),
        r3(ap.arrival),
        r3(ap.total),
        vi?.num_present ?? "",
        vi?.num_flying ?? "",
        vi?.num_in_goal ?? "",
        vi?.num_reached_ess ?? "",
        r3(vi?.best_distance),
        r3(vi?.best_time),
        r3(vi?.goal_ratio),
        r3(vi?.task_distance),
        r3(vi?.mean_distance_over_minimum),
        r3(vi?.weights.distance),
        r3(vi?.weights.time),
        r3(vi?.weights.leading),
        r3(vi?.weights.arrival),
        score.computed_at,
        score.stale ? "yes" : "no",
        score.engine_generation ?? "",
      ]);
    }
  }
  return csv(TASK_VALIDITY_COLUMNS, rows);
}

export const AUDIT_LOG_COLUMNS = [
  "timestamp_utc",
  "actor",
  "subject_type",
  "subject",
  "description",
] as const;

export function buildAuditLogCsv(data: ResultsRecordLoaderData): string {
  return csv(
    AUDIT_LOG_COLUMNS,
    data.audit.map((e) => [
      e.timestamp,
      e.actor_name,
      e.subject_type,
      e.subject_name ?? "",
      e.description,
    ])
  );
}

/** What is not a table: the competition's settings, and per task and class
 * the resolved GAP parameters, leading clock and stopped-task outcome. */
export function buildCompetitionJson(data: ResultsRecordLoaderData, meta: RecordMeta): string {
  const { comp, scores } = data;
  return (
    JSON.stringify(
      {
        about:
          "GlideComp results record. Field names follow GlideComp's API on the day this " +
          "file was made and are not a fixed format.",
        generated_at: meta.generatedAt.toISOString(),
        competition: {
          comp_id: comp.comp_id,
          url: meta.origin + compPath(comp.comp_id, comp.name),
          name: comp.name,
          category: comp.category,
          scoring_format: comp.scoring_format,
          series_scoring: comp.series_scoring,
          ftv_factor: scores?.ftv_factor ?? comp.ftv_factor,
          pilot_classes: comp.pilot_classes,
          timezone: comp.timezone,
          creation_date: comp.creation_date,
          close_date: comp.close_date,
          pilot_count: comp.pilot_count,
          gap_params: comp.gap_params,
        },
        scores: scores
          ? { computed_at: scores.computed_at, stale: scores.stale, series_scoring: scores.series_scoring }
          : null,
        tasks: data.tasks.map(({ task, score }) => ({
          task_id: task.task_id,
          name: task.name,
          task_date: task.task_date,
          url: meta.origin + taskPath(comp.comp_id, comp.name, task.task_id, task.name),
          pilot_classes: task.pilot_classes,
          stop_announcement_time: task.stop_announcement_time,
          weather_notes: task.weather_notes || null,
          scored: score
            ? {
                scoring_format: score.scoring_format,
                computed_at: score.computed_at,
                stale: score.stale,
                engine_generation: score.engine_generation ?? null,
                classes: score.class_scores.map((cls) => ({
                  pilot_class: cls.pilot_class,
                  rules_edition: cls.rules_edition ?? null,
                  task_validity: cls.task_validity,
                  available_points: cls.available_points,
                  validity_inputs: cls.validity_inputs ?? null,
                  gap_params: cls.gap_params ?? null,
                  leading_times: cls.leading_times ?? null,
                  stopped: cls.stopped ?? null,
                })),
              }
            : null,
        })),
      },
      null,
      2
    ) + "\n"
  );
}

/** "route-03-corryong-to-khancoban.xctsk" — numbered so they sort by day. */
function routeFileName(index: number, name: string): string {
  return `route-${String(index + 1).padStart(2, "0")}-${slugify(name) || "task"}.xctsk`;
}

/**
 * Every attachment, README last (it lists the others). The order is the
 * order a viewer's attachments panel shows them in.
 */
export function buildRecordFiles(data: ResultsRecordLoaderData, meta: RecordMeta): RecordFile[] {
  const { comp } = data;
  const files: RecordFile[] = [
    {
      name: "scores.csv",
      mimeType: "text/csv",
      description:
        "Competition scores, one row per pilot per task, as published (one decimal). " +
        "SUM(counted_score) over a pilot's rows is their total.",
      content: buildScoresCsv(
        data.scores ?? { comp_id: comp.comp_id, tasks: [], class_scores: [] },
        { compName: comp.name, origin: meta.origin }
      ),
    },
    {
      name: "task-results.csv",
      mimeType: "text/csv",
      description:
        "Every pilot on every scored task with each component of the score: distance, " +
        "time, leading and arrival points, penalties and withheld tracks.",
      content: buildTaskResultsCsv(data, meta.origin),
    },
    {
      name: "task-validity.csv",
      mimeType: "text/csv",
      description:
        "One row per task and class: the validity factors, the numbers they were " +
        "computed from, and the points the task offered.",
      content: buildTaskValidityCsv(data),
    },
    {
      name: "audit-log.csv",
      mimeType: "text/csv",
      description:
        "The competition's public change log: every change that could move a score, " +
        "who made it and when." +
        (data.auditTruncated ? " Only the most recent 10,000 entries." : ""),
      content: buildAuditLogCsv(data),
    },
    {
      name: "competition.json",
      mimeType: "application/json",
      description:
        "Settings and per-task scoring parameters that are not a table: the GAP " +
        "parameters each class was scored with, the leading clock, stopped tasks.",
      content: buildCompetitionJson(data, meta),
    },
  ];

  data.tasks.forEach(({ task }, i) => {
    if (!task.xctsk) return;
    files.push({
      name: routeFileName(i, task.name),
      mimeType: "application/json",
      description: `${task.name} (${task.task_date}): the route as an XCTrack task file.`,
      content: JSON.stringify(toXctskJSON(task.xctsk), null, 2) + "\n",
    });
  });

  files.push({
    name: "README.txt",
    mimeType: "text/plain",
    description: "What each attached file holds.",
    content: buildReadme(data, meta, files),
  });
  return files;
}

function buildReadme(data: ResultsRecordLoaderData, meta: RecordMeta, files: RecordFile[]): string {
  const { comp } = data;
  const lines = [
    `${comp.name} — GlideComp results record`,
    "",
    `Generated ${meta.generatedAt.toISOString()} from ${meta.origin + compPath(comp.comp_id, comp.name)}`,
    "",
    "GlideComp re-scores a competition whenever its scoring engine changes, so the",
    "scores online can differ from these later. This file records them as they",
    "stood when it was generated.",
    "",
    "The tables in the PDF are rounded for reading. The files below hold the exact",
    "values. Field names follow GlideComp's API on the day this file was made; they",
    "are not a fixed format and may differ in a later export.",
    "",
    "Times are UTC (ISO 8601). Distances are metres, durations seconds.",
    "",
    "Files:",
    ...files.flatMap((f) => [`  ${f.name}`, `    ${f.description}`]),
    "",
  ];
  return lines.join("\n");
}
