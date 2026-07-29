import { describe, expect, test } from "vitest";
import {
  buildScoresCsv,
  scoresCsvFilename,
  SCORES_CSV_COLUMNS,
  type ScoresCsvInput,
} from "./scores-csv";
import type { ClassStanding, PilotStanding, TaskInfo } from "./scores-views";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function task(id: string, name: string, date = "2026-01-01"): TaskInfo {
  return { task_id: id, task_name: name, task_date: date, classes: ["open"] };
}

function pilot(
  name: string,
  id: string,
  entries: Array<{ task: string; score: number; rank: number }>,
  extra: Partial<PilotStanding> = {}
): PilotStanding {
  return {
    pilot_name: name,
    comp_pilot_id: id,
    team_name: null,
    rank: 1,
    total_score: entries.reduce((s, e) => s + e.score, 0),
    tasks: entries.map((e) => ({
      task_id: e.task,
      task_date: "2026-01-01",
      score: e.score,
      rank: e.rank,
    })),
    ...extra,
  };
}

function scores(standings: ClassStanding[], tasks: TaskInfo[]): ScoresCsvInput {
  return { comp_id: "abc", tasks, standings };
}

/** Split a CSV line, honouring quoted cells. */
function cells(line: string): string[] {
  return (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [])
    .slice(0, -1)
    .map((c) => c.replace(/,$/, ""))
    .map((c) => (c.startsWith('"') ? c.slice(1, -1).replace(/""/g, '"') : c));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildScoresCsv", () => {
  test("emits one row per pilot per task, long-form", () => {
    const csv = buildScoresCsv(
      scores(
        [
          {
            pilot_class: "open",
            pilots: [
              pilot("Ada", "p1", [
                { task: "t1", score: 900, rank: 1 },
                { task: "t2", score: 750, rank: 3 },
              ]),
              pilot("Bo", "p2", [{ task: "t1", score: 500, rank: 2 }], { rank: 2 }),
            ],
          },
        ],
        [task("t1", "Task 1"), task("t2", "Task 2", "2026-01-02")]
      ),
      "Test Cup"
    );

    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(SCORES_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4); // header + 2 + 1

    const row = cells(lines[1]);
    expect(row[SCORES_CSV_COLUMNS.indexOf("competition")]).toBe("Test Cup");
    expect(row[SCORES_CSV_COLUMNS.indexOf("pilot_name")]).toBe("Ada");
    expect(row[SCORES_CSV_COLUMNS.indexOf("comp_pilot_id")]).toBe("p1");
    expect(row[SCORES_CSV_COLUMNS.indexOf("task")]).toBe("Task 1");
    expect(row[SCORES_CSV_COLUMNS.indexOf("task_id")]).toBe("t1");
    expect(row[SCORES_CSV_COLUMNS.indexOf("score")]).toBe("900");
    expect(row[SCORES_CSV_COLUMNS.indexOf("task_rank")]).toBe("1");
    expect(row[SCORES_CSV_COLUMNS.indexOf("pilot_total_score")]).toBe("1650");

    // Every row carries the same column count — the thing a pivot needs most.
    for (const line of lines) {
      expect(cells(line)).toHaveLength(SCORES_CSV_COLUMNS.length);
    }
  });

  test("orders a pilot's rows by the comp's task order, not the pilot's", () => {
    const csv = buildScoresCsv(
      scores(
        [
          {
            pilot_class: "open",
            pilots: [
              pilot("Ada", "p1", [
                { task: "t2", score: 750, rank: 3 },
                { task: "t1", score: 900, rank: 1 },
              ]),
            ],
          },
        ],
        [task("t1", "Task 1"), task("t2", "Task 2")]
      ),
      "Test Cup"
    );
    const taskCol = SCORES_CSV_COLUMNS.indexOf("task");
    const names = csv.trimEnd().split("\n").slice(1).map((l) => cells(l)[taskCol]);
    expect(names).toEqual(["Task 1", "Task 2"]);
  });

  test("counted_score mirrors score without FTV and the discard with it", () => {
    const p = pilot("Ada", "p1", [
      { task: "t1", score: 900, rank: 1 },
      { task: "t2", score: 400, rank: 5 },
    ]);
    p.tasks[0].ftv_status = "full";
    p.tasks[0].ftv_counted_score = 900;
    p.tasks[1].ftv_status = "discarded";
    p.tasks[1].ftv_counted_score = 0;
    p.total_score = 900;

    const csv = buildScoresCsv(
      scores([{ pilot_class: "open", pilots: [p] }], [task("t1", "T1"), task("t2", "T2")]),
      "Test Cup"
    );
    const rows = csv.trimEnd().split("\n").slice(1).map(cells);
    const counted = SCORES_CSV_COLUMNS.indexOf("counted_score");
    const status = SCORES_CSV_COLUMNS.indexOf("ftv_status");
    expect(rows.map((r) => r[counted])).toEqual(["900", "0"]);
    expect(rows.map((r) => r[status])).toEqual(["full", "discarded"]);
    // SUM(counted_score) reproduces the published total.
    expect(rows.reduce((s, r) => s + Number(r[counted]), 0)).toBe(900);
  });

  test("keeps a pilot with no scored task, with empty task cells", () => {
    const csv = buildScoresCsv(
      scores([{ pilot_class: "open", pilots: [pilot("Ada", "p1", [])] }], []),
      "Test Cup"
    );
    const rows = csv.trimEnd().split("\n").slice(1).map(cells);
    expect(rows).toHaveLength(1);
    expect(rows[0][SCORES_CSV_COLUMNS.indexOf("pilot_name")]).toBe("Ada");
    expect(rows[0][SCORES_CSV_COLUMNS.indexOf("task")]).toBe("");
    expect(rows[0]).toHaveLength(SCORES_CSV_COLUMNS.length);
  });

  test("escapes commas and quotes, and defuses a formula-looking name", () => {
    const csv = buildScoresCsv(
      scores(
        [
          {
            pilot_class: "open",
            pilots: [
              pilot('Smith, "Ace"', "p1", [{ task: "t1", score: 900, rank: 1 }]),
              pilot("=cmd|calc", "p2", [{ task: "t1", score: 1, rank: 2 }]),
            ],
          },
        ],
        [task("t1", "Task 1, day one")]
      ),
      "Test Cup"
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[1]).toContain('"Smith, ""Ace"""');
    expect(lines[1]).toContain('"Task 1, day one"');
    expect(cells(lines[2])[SCORES_CSV_COLUMNS.indexOf("pilot_name")]).toBe("'=cmd|calc");
  });

  test("rounds to the published points", () => {
    const csv = buildScoresCsv(
      scores(
        [
          {
            pilot_class: "open",
            pilots: [pilot("Ada", "p1", [{ task: "t1", score: 899.6, rank: 1 }])],
          },
        ],
        [task("t1", "Task 1")]
      ),
      "Test Cup"
    );
    const row = cells(csv.trimEnd().split("\n")[1]);
    expect(row[SCORES_CSV_COLUMNS.indexOf("score")]).toBe("900");
  });
});

describe("scoresCsvFilename", () => {
  test("slugs the comp name", () => {
    expect(scoresCsvFilename("Corryong Cup 2026")).toBe("corryong-cup-2026-scores.csv");
  });

  test("falls back when the name has nothing to slug", () => {
    expect(scoresCsvFilename("···")).toBe("competition-scores.csv");
  });
});
