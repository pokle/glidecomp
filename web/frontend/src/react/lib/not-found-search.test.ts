import { describe, test, expect } from "vitest";
import {
  buildSuggestions,
  freeTextParams,
  lookupParams,
  matchScore,
  parsePathIdentity,
  MAX_SUGGESTIONS,
  type LookupResults,
} from "./not-found-search";

/** The URL from the bug report: a pilot score link after an id-shuffling reseed. */
const DEAD_PILOT_URL =
  "/comp/corryong-cup-2026-voqc/task/task-1-open-bqlf/pilot/harrison-rowntree-zujf";

const EMPTY: LookupResults = { comps: [], tasks: [], pilots: [] };

describe("parsePathIdentity", () => {
  const COMP = { id: "voqc", slug: "corryong-cup-2026" };
  const TASK = { id: "bqlf", slug: "task-1-open" };

  test("splits every segment of a pilot score URL", () => {
    expect(parsePathIdentity(DEAD_PILOT_URL)).toEqual({
      comp: COMP,
      task: TASK,
      pilot: { id: "zujf", slug: "harrison-rowntree" },
      page: "pilot",
    });
  });

  test("reads a task URL", () => {
    expect(parsePathIdentity("/comp/corryong-cup-2026-voqc/task/task-1-open-bqlf")).toEqual({
      comp: COMP,
      task: TASK,
      page: "task",
    });
  });

  test("both per-task analysis URLs — current and superseded — mean the report", () => {
    // The old shape redirects when it resolves, so a dead one is still asking
    // for the report, not for the task page.
    for (const path of [
      "/comp/corryong-cup-2026-voqc/analysis/task/task-1-open-bqlf",
      "/comp/corryong-cup-2026-voqc/task/task-1-open-bqlf/analysis",
    ]) {
      expect(parsePathIdentity(path)).toEqual({
        comp: COMP,
        task: TASK,
        page: "taskAnalysis",
      });
    }
  });

  test("each comp-level page is told apart, so it can be rebuilt as itself", () => {
    const cases = [
      ["", "comp"],
      ["/", "comp"],
      ["/scores", "scores"],
      ["/waypoints", "waypoints"],
      ["/analysis", "compAnalysis"],
      ["/pilots", "pilots"],
    ] as const;
    for (const [suffix, page] of cases) {
      expect(parsePathIdentity(`/comp/corryong-cup-2026-voqc${suffix}`)).toEqual({
        comp: COMP,
        page,
      });
    }
  });

  test("a bare-id URL yields ids but no words to search for", () => {
    expect(parsePathIdentity("/comp/voqc/task/bqlf")).toEqual({
      comp: { id: "voqc", slug: "" },
      task: { id: "bqlf", slug: "" },
      page: "task",
    });
  });

  test("anything that isn't a public comp URL yields nothing", () => {
    expect(parsePathIdentity("/settings")).toEqual({});
    expect(parsePathIdentity("/comp")).toEqual({});
    expect(parsePathIdentity("/comp/voqc/task/bqlf/pilot/zujf/extra")).toEqual({});
  });
});

describe("lookupParams", () => {
  test("sends the comp id as an anchor and each slug as its own search", () => {
    const params = lookupParams(parsePathIdentity(DEAD_PILOT_URL))!;
    expect(params.get("comp")).toBe("voqc");
    expect(params.get("comp_q")).toBe("corryong-cup-2026");
    expect(params.get("task_q")).toBe("task-1-open");
    expect(params.get("pilot_q")).toBe("harrison-rowntree");
  });

  test("a bare-id URL still asks about the comp, with no words", () => {
    const params = lookupParams(parsePathIdentity("/comp/voqc/task/bqlf"))!;
    expect(params.get("comp")).toBe("voqc");
    expect(params.has("task_q")).toBe(false);
  });

  test("an unrecognised path asks nothing", () => {
    expect(lookupParams(parsePathIdentity("/settings"))).toBeNull();
  });
});

describe("freeTextParams", () => {
  test("searches all three kinds at once", () => {
    const params = freeTextParams(" corryong ")!;
    expect(params.get("comp_q")).toBe("corryong");
    expect(params.get("task_q")).toBe("corryong");
    expect(params.get("pilot_q")).toBe("corryong");
  });

  test("a single character is not a search", () => {
    expect(freeTextParams("c")).toBeNull();
    expect(freeTextParams("   ")).toBeNull();
  });
});

describe("matchScore", () => {
  test("an exact slug match beats a partial one", () => {
    expect(matchScore("task-1-open", "Task 1 (Open)")).toBe(1);
    expect(matchScore("task-1-open", "Task 1 (Floater)")).toBeLessThan(1);
    expect(matchScore("task-1-open", "Task 1 (Floater)")).toBeGreaterThan(0);
  });

  test("more shared words scores higher", () => {
    expect(matchScore("corryong-cup-2026", "Corryong Cup 2026")).toBeGreaterThan(
      matchScore("corryong-cup-2026", "Corryong Cup 2020")
    );
  });

  test("nothing to match on scores zero", () => {
    expect(matchScore("", "Task 1 (Open)")).toBe(0);
    expect(matchScore("task-1-open", "Grand Loop")).toBe(0);
  });
});

describe("buildSuggestions", () => {
  const results: LookupResults = {
    comps: [{ comp_id: "newc", name: "Corryong Cup 2026", category: "hg" }],
    tasks: [
      {
        comp_id: "newc",
        comp_name: "Corryong Cup 2026",
        task_id: "newt",
        name: "Task 1 (Open)",
        task_date: "2026-01-05",
      },
    ],
    pilots: [
      {
        comp_id: "newc",
        comp_name: "Corryong Cup 2026",
        task_id: "newt",
        task_name: "Task 1 (Open)",
        task_date: "2026-01-05",
        comp_pilot_id: "newp",
        name: "Harrison Rowntree",
      },
    ],
  };

  test("rebuilds the dead URL with the ids that exist now", () => {
    const suggestions = buildSuggestions(parsePathIdentity(DEAD_PILOT_URL), results);
    // The page that was asked for, first.
    expect(suggestions[0]).toEqual({
      kind: "pilot",
      path: "/comp/corryong-cup-2026-newc/task/task-1-open-newt/pilot/harrison-rowntree-newp",
      label: "Harrison Rowntree",
      context: "Task 1 (Open) · Corryong Cup 2026",
    });
    // …with the task and the comp behind it as fallbacks.
    expect(suggestions.map((s) => s.kind)).toEqual([
      "pilot",
      "task",
      "comp",
      "scores",
      "analysis",
    ]);
  });

  // A URL differing from a live one ONLY by its id is the same request, so the
  // page it names must lead — not merely something nearby in the same comp.
  // The reported bug was landing on a dead /scores and being offered the comp
  // hub first, with Scores buried below it.
  test.each([
    ["scores", "/comp/corryong-cup-2026-voqc/scores", "/comp/corryong-cup-2026-newc/scores", "Scores"],
    ["waypoints", "/comp/corryong-cup-2026-voqc/waypoints", "/comp/corryong-cup-2026-newc/waypoints", "Waypoints"],
    ["field analysis", "/comp/corryong-cup-2026-voqc/analysis", "/comp/corryong-cup-2026-newc/analysis", "Field analysis"],
  ])("a dead %s URL is rebuilt as itself, first", (_what, dead, live, label) => {
    const suggestions = buildSuggestions(parsePathIdentity(dead), results);
    // Same page, live id — not merely something nearby in the same comp.
    expect(suggestions[0]).toMatchObject({ label, path: live });
  });

  test("a dead per-task analysis URL leads with the report, not the task page", () => {
    const suggestions = buildSuggestions(
      parsePathIdentity("/comp/corryong-cup-2026-voqc/analysis/task/task-1-open-bqlf"),
      results
    );
    expect(suggestions[0]).toEqual({
      kind: "analysis",
      path: "/comp/corryong-cup-2026-newc/analysis/task/task-1-open-newt",
      label: "Field analysis",
      context: "Task 1 (Open) · Corryong Cup 2026",
    });
  });

  test("a dead comp URL leads with the comp", () => {
    const suggestions = buildSuggestions(
      parsePathIdentity("/comp/corryong-cup-2026-voqc"),
      results
    );
    expect(suggestions[0]).toEqual({
      kind: "comp",
      path: "/comp/corryong-cup-2026-newc",
      label: "Corryong Cup 2026",
    });
  });

  test("the admin roster has no public page, so it falls back to the comp", () => {
    const suggestions = buildSuggestions(
      parsePathIdentity("/comp/corryong-cup-2026-voqc/pilots"),
      results
    );
    expect(suggestions[0].kind).toBe("comp");
  });

  test("ranks the candidate whose name matches the dead slug first", () => {
    const twoTasks: LookupResults = {
      ...results,
      pilots: [],
      tasks: [
        { ...results.tasks[0], task_id: "flot", name: "Task 1 (Floater)" },
        { ...results.tasks[0], task_id: "opnt", name: "Task 1 (Open)" },
      ],
    };
    const suggestions = buildSuggestions(
      parsePathIdentity("/comp/corryong-cup-2026-voqc/task/task-1-open-bqlf"),
      twoTasks
    );
    expect(suggestions[0].label).toBe("Task 1 (Open)");
  });

  test("no results, no suggestions", () => {
    expect(buildSuggestions(parsePathIdentity(DEAD_PILOT_URL), EMPTY)).toEqual([]);
  });

  test("caps the list, and keeps a link at every level while doing it", () => {
    const many: LookupResults = {
      comps: Array.from({ length: 5 }, (_, i) => ({
        comp_id: `c${i}`,
        name: `Comp ${i}`,
        category: "hg",
      })),
      tasks: Array.from({ length: 10 }, (_, i) => ({
        comp_id: "newc",
        comp_name: "Corryong Cup 2026",
        task_id: `t${i}`,
        name: `Task ${i} (Open)`,
        task_date: "2026-01-05",
      })),
      pilots: Array.from({ length: 10 }, (_, i) => ({
        comp_id: "newc",
        comp_name: "Corryong Cup 2026",
        task_id: "newt",
        task_name: "Task 1 (Open)",
        task_date: "2026-01-05",
        comp_pilot_id: `p${i}`,
        name: `Pilot ${i}`,
      })),
    };
    const suggestions = buildSuggestions(parsePathIdentity(DEAD_PILOT_URL), many);
    expect(suggestions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
    const kinds = new Set(suggestions.map((s) => s.kind));
    expect(kinds.has("pilot")).toBe(true);
    expect(kinds.has("task")).toBe(true);
    expect(kinds.has("comp")).toBe(true);
  });

  test("never offers the same URL twice", () => {
    const suggestions = buildSuggestions(parsePathIdentity(DEAD_PILOT_URL), results);
    expect(new Set(suggestions.map((s) => s.path)).size).toBe(suggestions.length);
  });
});
