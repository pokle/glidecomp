/**
 * The competition scores as a CSV spreadsheets can actually work with.
 *
 * Deliberately LONG (tidy) rather than wide: one row per pilot per task, with
 * ONE `score` column and ONE `task` column naming the task — not a column per
 * task. A column-per-task table is what the page shows because a human reads
 * across it, but it is the wrong shape for a pivot table: every new task moves
 * the columns, and grouping by task is impossible without unpivoting first.
 * In this shape "average score per task", "each pilot's best day", "class ×
 * task" are all one pivot away, and adding a task adds rows, not columns.
 *
 * The pilot-level facts (rank, competition total) repeat on each of that
 * pilot's rows, so a pivot aggregates them with MAX/AVERAGE rather than SUM.
 * `counted_score` is the FTV-aware measure: under FTV it is what the task
 * actually contributed to the total (0 for a discarded task), and under plain
 * total scoring it equals `score` — so SUM(counted_score) per pilot reproduces
 * the published total either way.
 *
 * PURE (no React, no DOM) so both the download button and the Pages Function
 * that serves /comp/:id/scores.csv build the exact same bytes.
 */
import type { ClassStanding, TaskInfo } from "./scores-views";
import { slugify } from "./react/lib/slug";

/** The `/api/comp/:id/scores` fields this needs — CompScores satisfies it. */
export interface ScoresCsvInput {
  comp_id: string;
  tasks: TaskInfo[];
  standings: ClassStanding[];
}

export const SCORES_CSV_COLUMNS = [
  "competition",
  "comp_id",
  "pilot_class",
  "pilot_name",
  "comp_pilot_id",
  "team",
  "task",
  "task_id",
  "task_date",
  "score",
  "task_rank",
  "counted_score",
  "ftv_status",
  "pilot_rank",
  "pilot_total_score",
] as const;

/**
 * Serialise the whole-comp standings as one long CSV: every class, every
 * pilot, every task they were scored on. Scores are the published (rounded)
 * points, so a column of them adds up to what the scoreboard shows.
 *
 * A pilot with no scored task still gets a row — with the task columns empty —
 * because a roster that silently loses people is worse than a blank cell.
 */
export function buildScoresCsv(scores: ScoresCsvInput, compName: string): string {
  const taskNameById = new Map(scores.tasks.map((t) => [t.task_id, t.task_name]));
  const lines = [SCORES_CSV_COLUMNS.join(",")];

  for (const cls of scores.standings) {
    for (const pilot of cls.pilots) {
      const pilotCells = [
        compName,
        scores.comp_id,
        cls.pilot_class,
        pilot.pilot_name,
        pilot.comp_pilot_id,
        pilot.team_name ?? "",
      ];
      const tail = [pilot.rank, Math.round(pilot.total_score)];

      if (pilot.tasks.length === 0) {
        lines.push([...pilotCells, "", "", "", "", "", "", "", ...tail].map(csvEscape).join(","));
        continue;
      }

      // Comp task order, not the pilot's — so every pilot's rows read in the
      // same sequence and a sort by pilot alone keeps the days in order.
      const byId = new Map(pilot.tasks.map((t) => [t.task_id, t]));
      const ordered = [
        ...scores.tasks.map((t) => byId.get(t.task_id)).filter((t) => t != null),
        // Anything the tasks list doesn't name (shouldn't happen) still ships.
        ...pilot.tasks.filter((t) => !taskNameById.has(t.task_id)),
      ];

      for (const entry of ordered) {
        lines.push(
          [
            ...pilotCells,
            taskNameById.get(entry.task_id) ?? entry.task_id,
            entry.task_id,
            entry.task_date,
            Math.round(entry.score),
            entry.rank,
            Math.round(entry.ftv_counted_score ?? entry.score),
            entry.ftv_status ?? "",
            ...tail,
          ]
            .map(csvEscape)
            .join(",")
        );
      }
    }
  }

  return lines.join("\n") + "\n";
}

/** Download filename for a comp's scores CSV. */
export function scoresCsvFilename(compName: string): string {
  return `${slugify(compName) || "competition"}-scores.csv`;
}

function csvEscape(value: string | number): string {
  // Numbers pass through unguarded — a negative score must stay a number, and
  // it can't carry a formula anyway.
  if (typeof value === "number") return String(value);
  // A leading =/+/-/@ is a formula in Excel and Sheets; prefix with an
  // apostrophe so a pilot's name is never executed as one.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
