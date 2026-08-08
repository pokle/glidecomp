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
 * There is deliberately NO competition-total column: the total is
 * SUM(counted_score) over a pilot's rows, and a measure that must not be
 * summed sitting beside ones that must is the thing people get wrong in a
 * pivot. `counted_score` is the per-TASK FTV-aware measure — under FTV it is
 * what that task actually contributed (0 for a discarded task), and under
 * plain total scoring it equals `score` — so that sum is the published total
 * under either method. `pilot_rank` is the one pilot-level column left (a
 * classScores position isn't derivable from the rows), and it repeats on each
 * of that pilot's rows, so a pivot takes it with MAX rather than SUM.
 *
 * Known rounding drift: the columns carry the PUBLISHED (rounded) points, so a
 * summed total can sit a point either side of the site's, which sums the
 * unrounded scores and rounds once at the end.
 *
 * Ids appear as fully-qualified URLs, not bare sqids: a `wuhu` in a cell tells
 * a reader nothing and takes them nowhere, while the URL is both the identity
 * (it ends in that same id) and the way back to the page it names. The one
 * bare id kept is `comp_pilot_id` — it is what makes "group by pilot" safe
 * when two pilots share a name, and unlike the others it has no page of its
 * own (a pilot's page exists per task, which is `score_url`).
 *
 * PURE (no React, no DOM) so both the Pages Function that serves
 * /comp/:id/scores.csv and its dev-server mirror build the exact same bytes.
 */
import type { CompClassScore, TaskInfo } from "./scores-views";
import { compPath, pilotPath, slugify, taskPath } from "./react/lib/slug";

/** The `/api/comp/:id/scores` fields this needs — CompScores satisfies it. */
export interface ScoresCsvInput {
  comp_id: string;
  tasks: TaskInfo[];
  class_scores: CompClassScore[];
}

export interface ScoresCsvOptions {
  compName: string;
  /**
   * Origin the URL columns are absolute against, no trailing slash (e.g.
   * "https://glidecomp.com"). Pass the serving request's own origin so a
   * preview deploy's export links back to the preview. "" yields site-relative
   * paths, which are still valid — just not clickable out of a spreadsheet.
   */
  origin: string;
}

export const SCORES_CSV_COLUMNS = [
  "competition",
  "comp_url",
  "pilot_class",
  "pilot_name",
  "comp_pilot_id",
  "team",
  "task",
  "task_url",
  "task_date",
  "score",
  "task_rank",
  "counted_score",
  "ftv_status",
  "score_url",
  "pilot_rank",
] as const;

/** Blank task-side cells for a pilot with nothing scored yet. */
const EMPTY_TASK_CELLS = ["", "", "", "", "", "", "", ""];

/**
 * Serialise the whole-comp classScores as one long CSV: every class, every
 * pilot, every task they were scored on. Scores are the published (rounded)
 * points, so a column of them adds up to what the scoreboard shows.
 *
 * A pilot with no scored task still gets a row — with the task columns empty —
 * because a roster that silently loses people is worse than a blank cell.
 */
export function buildScoresCsv(
  scores: ScoresCsvInput,
  { compName, origin }: ScoresCsvOptions
): string {
  const taskById = new Map(scores.tasks.map((t) => [t.task_id, t]));
  const url = (path: string) => `${origin}${path}`;
  const compUrl = url(compPath(scores.comp_id, compName));
  const lines = [SCORES_CSV_COLUMNS.join(",")];

  for (const cls of scores.class_scores) {
    for (const pilot of cls.pilots) {
      const pilotCells = [
        compName,
        compUrl,
        cls.pilot_class,
        pilot.pilot_name,
        pilot.comp_pilot_id,
        pilot.team_name ?? "",
      ];
      const tail = [pilot.rank];

      if (pilot.tasks.length === 0) {
        lines.push([...pilotCells, ...EMPTY_TASK_CELLS, ...tail].map(csvEscape).join(","));
        continue;
      }

      // Comp task order, not the pilot's — so every pilot's rows read in the
      // same sequence and a sort by pilot alone keeps the days in order.
      const byId = new Map(pilot.tasks.map((t) => [t.task_id, t]));
      const ordered = [
        ...scores.tasks.map((t) => byId.get(t.task_id)).filter((t) => t != null),
        // Anything the tasks list doesn't name (shouldn't happen) still ships.
        ...pilot.tasks.filter((t) => !taskById.has(t.task_id)),
      ];

      for (const entry of ordered) {
        // A task the classScores name but the task list doesn't can still be
        // linked — the slug is decorative, the id is the identity.
        const taskName = taskById.get(entry.task_id)?.task_name ?? "";
        lines.push(
          [
            ...pilotCells,
            taskName || entry.task_id,
            url(taskPath(scores.comp_id, compName, entry.task_id, taskName)),
            entry.task_date,
            Math.round(entry.score),
            entry.rank,
            Math.round(entry.ftv_counted_score ?? entry.score),
            entry.ftv_status ?? "",
            url(
              pilotPath(
                scores.comp_id,
                compName,
                entry.task_id,
                taskName,
                pilot.comp_pilot_id,
                pilot.pilot_name
              )
            ),
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
