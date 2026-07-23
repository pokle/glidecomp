import { describe, expect, test } from "vitest";
import {
  aggregateTeams,
  buildClassGroups,
  computeTop3Rows,
  tasksForGroup,
  OVERALL_LABEL,
  type ClassStanding,
  type PilotStanding,
  type TaskInfo,
} from "./scores-views";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let nextId = 1;
function pilot(
  name: string,
  scores: Record<string, number>,
  team?: string | null
): PilotStanding {
  const tasks = Object.entries(scores).map(([task_id, score]) => ({
    task_id,
    task_date: "2026-01-01",
    score,
    rank: 0,
  }));
  return {
    pilot_name: name,
    comp_pilot_id: `cp${nextId++}`,
    team_name: team ?? null,
    rank: 0,
    total_score: tasks.reduce((sum, t) => sum + t.score, 0),
    tasks,
  };
}

function task(task_id: string, classes: string[]): TaskInfo {
  return { task_id, task_name: task_id.toUpperCase(), task_date: "2026-01-01", classes };
}

// ── buildClassGroups ──────────────────────────────────────────────────────────

describe("buildClassGroups", () => {
  test("flat classes get an Overall rollup", () => {
    const standings: ClassStanding[] = [
      { pilot_class: "open", pilots: [pilot("A", { t1: 100 })] },
      { pilot_class: "floater", pilots: [pilot("B", { t1: 80 })] },
    ];
    const groups = buildClassGroups(standings);
    expect(groups.map((g) => g.label)).toEqual(["open", "floater", OVERALL_LABEL]);
    expect(groups[2].classes).toEqual(["open", "floater"]);
    expect(groups[2].pilots.map((p) => p.pilot_name)).toEqual(["A", "B"]);
  });

  test("slash-delimited classes roll up to their top-level ancestor", () => {
    const standings: ClassStanding[] = [
      { pilot_class: "open/a-grade", pilots: [pilot("A", { t1: 100 })] },
      { pilot_class: "open/b-grade", pilots: [pilot("B", { t1: 120 })] },
      { pilot_class: "open/recreational", pilots: [pilot("C", { t1: 50 })] },
      { pilot_class: "floater/vetran", pilots: [pilot("D", { t1: 90 })] },
      { pilot_class: "floater/novice", pilots: [pilot("E", { t1: 70 })] },
    ];
    const groups = buildClassGroups(standings);
    expect(groups.map((g) => g.label)).toEqual([
      "open/a-grade",
      "open/b-grade",
      "open/recreational",
      "floater/vetran",
      "floater/novice",
      "open",
      "floater",
      OVERALL_LABEL,
    ]);

    const open = groups.find((g) => g.label === "open")!;
    expect(open.classes).toEqual(["open/a-grade", "open/b-grade", "open/recreational"]);
    // Merged pilots are re-ranked by total score across the rollup
    expect(open.pilots.map((p) => [p.pilot_name, p.rank])).toEqual([
      ["B", 1],
      ["A", 2],
      ["C", 3],
    ]);

    const overall = groups.find((g) => g.label === OVERALL_LABEL)!;
    expect(overall.pilots).toHaveLength(5);
    expect(overall.pilots[0].pilot_name).toBe("B");
  });

  test("deeper hierarchies produce a rollup per ancestor level", () => {
    const standings: ClassStanding[] = [
      { pilot_class: "hg/open/rigid", pilots: [pilot("A", { t1: 10 })] },
      { pilot_class: "hg/open/flex", pilots: [pilot("B", { t1: 20 })] },
      { pilot_class: "hg/sport", pilots: [pilot("C", { t1: 30 })] },
    ];
    const labels = buildClassGroups(standings).map((g) => g.label);
    expect(labels).toContain("hg/open");
    expect(labels).toContain("hg");
    // "hg" spans every class, so a separate Overall would be a duplicate
    expect(labels).not.toContain(OVERALL_LABEL);
  });

  test("single-child rollups and duplicate groups are dropped", () => {
    const standings: ClassStanding[] = [
      { pilot_class: "floater/novice", pilots: [pilot("A", { t1: 10 })] },
      { pilot_class: "open", pilots: [pilot("B", { t1: 20 })] },
    ];
    const labels = buildClassGroups(standings).map((g) => g.label);
    // "floater" would contain exactly floater/novice — dropped
    expect(labels).toEqual(["floater/novice", "open", OVERALL_LABEL]);
  });

  test("a single class yields no rollups", () => {
    const standings: ClassStanding[] = [
      { pilot_class: "open", pilots: [pilot("A", { t1: 10 })] },
    ];
    expect(buildClassGroups(standings).map((g) => g.label)).toEqual(["open"]);
  });
});

// ── computeTop3Rows ───────────────────────────────────────────────────────────

describe("computeTop3Rows", () => {
  const standings: ClassStanding[] = [
    {
      pilot_class: "open",
      pilots: [
        pilot("A", { t1: 100, t2: 40 }),
        pilot("B", { t1: 90, t2: 95 }),
        pilot("C", { t1: 80 }),
        pilot("D", { t1: 70, t2: 60 }),
      ],
    },
    { pilot_class: "floater", pilots: [pilot("E", { t3: 55 })] },
  ];
  const tasks = [
    task("t1", ["open"]),
    task("t2", ["open"]),
    task("t3", ["floater"]),
  ];

  test("takes the top 3 scores per task plus a Total row", () => {
    const groups = buildClassGroups(standings);
    const open = groups.find((g) => g.label === "open")!;
    const rows = computeTop3Rows(open, tasks);

    // floater's t3 is not shown for the open group
    expect(rows.map((r) => r.label)).toEqual(["T1", "T2", "Total"]);
    expect(rows[0].entries.map((e) => [e.pilot_name, e.score])).toEqual([
      ["A", 100],
      ["B", 90],
      ["C", 80],
    ]);
    expect(rows[1].entries.map((e) => e.pilot_name)).toEqual(["B", "D", "A"]);
    expect(rows[2].entries.map((e) => [e.pilot_name, e.score])).toEqual([
      ["B", 185],
      ["A", 140],
      ["D", 130],
    ]);
  });

  test("rows shrink when fewer than 3 pilots flew", () => {
    const groups = buildClassGroups(standings);
    const floater = groups.find((g) => g.label === "floater")!;
    const rows = computeTop3Rows(floater, tasks);
    expect(rows.map((r) => r.label)).toEqual(["T3", "Total"]);
    expect(rows[0].entries).toHaveLength(1);
  });

  test("the Overall group spans every task", () => {
    const groups = buildClassGroups(standings);
    const overall = groups.find((g) => g.label === OVERALL_LABEL)!;
    expect(tasksForGroup(overall, tasks).map((t) => t.task_id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });
});

// ── aggregateTeams ────────────────────────────────────────────────────────────

describe("aggregateTeams", () => {
  test("sums scores per task and total, ranked by total", () => {
    const standings: ClassStanding[] = [
      {
        pilot_class: "open",
        pilots: [
          pilot("A", { t1: 100, t2: 40 }, "Condors"),
          pilot("B", { t1: 90, t2: 95 }, "Eagles"),
          pilot("C", { t1: 80 }, "Condors"),
          pilot("D", { t1: 70 }, null),
        ],
      },
      {
        pilot_class: "floater",
        pilots: [pilot("E", { t2: 55 }, "Eagles")],
      },
    ];

    const teams = aggregateTeams(standings);
    expect(teams.map((t) => t.team_name)).toEqual(["Eagles", "Condors"]);

    const eagles = teams[0];
    expect(eagles.rank).toBe(1);
    expect(eagles.pilots).toEqual(["B", "E"]);
    expect(eagles.task_scores).toEqual({ t1: 90, t2: 150 });
    expect(eagles.total_score).toBe(240);

    const condors = teams[1];
    expect(condors.pilots).toEqual(["A", "C"]);
    expect(condors.task_scores).toEqual({ t1: 180, t2: 40 });
    expect(condors.total_score).toBe(220);
  });

  test("a pilot entered in two classes is listed once, ordered by contribution", () => {
    const standings: ClassStanding[] = [
      { pilot_class: "open", pilots: [pilot("A", { t1: 50 }, "Condors"), pilot("B", { t1: 60 }, "Condors")] },
      { pilot_class: "floater", pilots: [pilot("A", { t2: 30 }, "Condors")] },
    ];
    const teams = aggregateTeams(standings);
    // A contributes 80 total across both classes, B only 60
    expect(teams[0].pilots).toEqual(["A", "B"]);
    expect(teams[0].total_score).toBe(140);
  });

  test("returns empty when no pilot has a team", () => {
    const standings: ClassStanding[] = [
      { pilot_class: "open", pilots: [pilot("A", { t1: 10 }), pilot("B", { t1: 20 }, "  ")] },
    ];
    expect(aggregateTeams(standings)).toEqual([]);
  });
});

// ── Shared ranks on ties (S7A §5.2.4/§5.2.5) ──────────────────────────────────

describe("shared ranks on ties", () => {
  test("buildClassGroups: equal totals share a rank, next rank skips (1,2,2,4)", () => {
    const standings: ClassStanding[] = [
      {
        pilot_class: "open",
        pilots: [
          pilot("A", { t1: 100 }), // 100
          pilot("B", { t1: 60, t2: 20 }), // 80
          pilot("C", { t1: 80 }), // 80
          pilot("D", { t1: 50 }), // 50
        ],
      },
    ];
    const group = buildClassGroups(standings).find((g) => g.label === "open")!;
    expect(group.pilots.map((p) => [p.pilot_name, p.rank])).toEqual([
      ["A", 1],
      ["B", 2],
      ["C", 2],
      ["D", 4],
    ]);
  });

  test("buildClassGroups: ties are on the published whole-point total", () => {
    // 700.4 and 699.6 both display as 700 → tie; 699.4 displays as 699.
    const standings: ClassStanding[] = [
      {
        pilot_class: "open",
        pilots: [
          pilot("A", { t1: 700.4 }),
          pilot("B", { t1: 699.6 }),
          pilot("C", { t1: 699.4 }),
        ],
      },
    ];
    const group = buildClassGroups(standings).find((g) => g.label === "open")!;
    expect(group.pilots.map((p) => p.rank)).toEqual([1, 1, 3]);
  });

  test("aggregateTeams: teams with equal totals share a rank", () => {
    const standings: ClassStanding[] = [
      {
        pilot_class: "open",
        pilots: [
          pilot("A", { t1: 100 }, "Eagles"),
          pilot("B", { t1: 100 }, "Condors"),
          pilot("C", { t1: 40 }, "Hawks"),
        ],
      },
    ];
    const teams = aggregateTeams(standings);
    expect(Object.fromEntries(teams.map((t) => [t.team_name, t.rank]))).toEqual({
      Eagles: 1,
      Condors: 1,
      Hawks: 3,
    });
  });
});
