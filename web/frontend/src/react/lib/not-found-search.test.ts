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
  test("splits every segment of a pilot score URL", () => {
    expect(parsePathIdentity(DEAD_PILOT_URL)).toEqual({
      comp: { id: "voqc", slug: "corryong-cup-2026" },
      task: { id: "bqlf", slug: "task-1-open" },
      pilot: { id: "zujf", slug: "harrison-rowntree" },
    });
  });

  test("reads a task URL, in both the current and the superseded analysis shape", () => {
    const expected = {
      comp: { id: "voqc", slug: "corryong-cup-2026" },
      task: { id: "bqlf", slug: "task-1-open" },
    };
    expect(parsePathIdentity("/comp/corryong-cup-2026-voqc/task/task-1-open-bqlf")).toEqual(
      expected
    );
    expect(
      parsePathIdentity("/comp/corryong-cup-2026-voqc/analysis/task/task-1-open-bqlf")
    ).toEqual(expected);
    expect(
      parsePathIdentity("/comp/corryong-cup-2026-voqc/task/task-1-open-bqlf/analysis")
    ).toEqual(expected);
  });

  test("reads the comp-level pages", () => {
    const comp = { comp: { id: "voqc", slug: "corryong-cup-2026" } };
    for (const suffix of ["", "/", "/scores", "/waypoints", "/analysis", "/pilots"]) {
      expect(parsePathIdentity(`/comp/corryong-cup-2026-voqc${suffix}`)).toEqual(comp);
    }
  });

  test("a bare-id URL yields ids but no words to search for", () => {
    expect(parsePathIdentity("/comp/voqc/task/bqlf")).toEqual({
      comp: { id: "voqc", slug: "" },
      task: { id: "bqlf", slug: "" },
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
    comps: [{ comp_id: "voqc", name: "Corryong Cup 2026", category: "hg" }],
    tasks: [
      {
        comp_id: "voqc",
        comp_name: "Corryong Cup 2026",
        task_id: "newt",
        name: "Task 1 (Open)",
        task_date: "2026-01-05",
      },
    ],
    pilots: [
      {
        comp_id: "voqc",
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
    // Deepest first: the pilot page the visitor was actually after.
    expect(suggestions[0]).toEqual({
      kind: "pilot",
      path: "/comp/corryong-cup-2026-voqc/task/task-1-open-newt/pilot/harrison-rowntree-newp",
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
        comp_id: "voqc",
        comp_name: "Corryong Cup 2026",
        task_id: `t${i}`,
        name: `Task ${i} (Open)`,
        task_date: "2026-01-05",
      })),
      pilots: Array.from({ length: 10 }, (_, i) => ({
        comp_id: "voqc",
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
