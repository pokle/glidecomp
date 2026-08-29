import { describe, test, expect } from "vitest";
import {
  slugify,
  slugSegment,
  idFromSegment,
  nameSlugFromSegment,
  compPath,
  compScoresPath,
  compAnalysisPath,
  compSettingsPath,
  taskPath,
  taskAnalysisPath,
  pilotPath,
} from "./slug";

describe("slugify", () => {
  test("lowercases and dash-joins words", () => {
    expect(slugify("Corryong Cup 2026")).toBe("corryong-cup-2026");
  });

  test("drops punctuation and collapses separators", () => {
    expect(slugify("Task 3 (Open)")).toBe("task-3-open");
    expect(slugify("  A  --  B  ")).toBe("a-b");
  });

  test("strips accents to their ASCII base", () => {
    expect(slugify("Épreuve Française")).toBe("epreuve-francaise");
  });

  test("a name with no slug-able characters is the empty string", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!! ??? ---")).toBe("");
  });

  test("caps length and never leaves a trailing dash", () => {
    const s = slugify("word ".repeat(40));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("slugSegment / idFromSegment round-trip", () => {
  const id = "voqc";
  for (const name of ["Corryong Cup 2026", "Task 3 (Open)", "", "!!!", null]) {
    test(`id survives ${JSON.stringify(name)}`, () => {
      const seg = slugSegment(id, name);
      expect(idFromSegment(seg)).toBe(id);
    });
  }

  test("builds the expected segments", () => {
    expect(slugSegment("voqc", "Corryong Cup 2026")).toBe("corryong-cup-2026-voqc");
    expect(slugSegment("zqfs", "Task 3 (Open)")).toBe("task-3-open-zqfs");
    expect(slugSegment("voqc", null)).toBe("voqc");
  });

  test("extracts the id from a bare or slugged segment", () => {
    expect(idFromSegment("voqc")).toBe("voqc");
    expect(idFromSegment("corryong-cup-2026-voqc")).toBe("voqc");
    expect(idFromSegment("task-3-open-zqfs")).toBe("zqfs");
    expect(idFromSegment("corryong-cup-2026-voqc".replace(/-/g, "%2D"))).toBe("voqc");
  });

  test("recovers the name slug — what a dead URL still says it wanted", () => {
    expect(nameSlugFromSegment("corryong-cup-2026-voqc")).toBe("corryong-cup-2026");
    expect(nameSlugFromSegment("task-3-open-zqfs")).toBe("task-3-open");
    expect(nameSlugFromSegment("jane-doe-abcd")).toBe("jane-doe");
    // A bare-id segment carries no name to recover.
    expect(nameSlugFromSegment("voqc")).toBe("");
    expect(nameSlugFromSegment("corryong-cup-2026-voqc".replace(/-/g, "%2D"))).toBe(
      "corryong-cup-2026"
    );
  });

  test("slug and id together reconstruct the segment", () => {
    const seg = slugSegment("voqc", "Corryong Cup 2026");
    expect(`${nameSlugFromSegment(seg)}-${idFromSegment(seg)}`).toBe(seg);
  });
});

describe("path builders", () => {
  test("comp-level paths", () => {
    expect(compPath("voqc", "Corryong Cup 2026")).toBe("/comp/corryong-cup-2026-voqc");
    expect(compScoresPath("voqc", "Corryong Cup 2026")).toBe(
      "/comp/corryong-cup-2026-voqc/scores"
    );
    expect(compAnalysisPath("voqc", "Corryong Cup 2026")).toBe(
      "/comp/corryong-cup-2026-voqc/analysis"
    );
    expect(compSettingsPath("voqc", "Corryong Cup 2026")).toBe(
      "/comp/corryong-cup-2026-voqc/settings"
    );
    expect(compSettingsPath("voqc", "Corryong Cup 2026", "scoring")).toBe(
      "/comp/corryong-cup-2026-voqc/settings/scoring"
    );
  });

  test("task and pilot paths nest the comp slug", () => {
    expect(taskPath("voqc", "Corryong Cup 2026", "zqfs", "Task 3 (Open)")).toBe(
      "/comp/corryong-cup-2026-voqc/task/task-3-open-zqfs"
    );
    expect(taskAnalysisPath("voqc", "Corryong Cup 2026", "zqfs", "Task 3 (Open)")).toBe(
      "/comp/corryong-cup-2026-voqc/task/task-3-open-zqfs/analysis"
    );
    expect(pilotPath("voqc", "Corryong Cup 2026", "zqfs", "Task 3 (Open)", "abcd", "Jane Doe")).toBe(
      "/comp/corryong-cup-2026-voqc/task/task-3-open-zqfs/pilot/jane-doe-abcd"
    );
  });

  test("a missing name degrades to a bare-id segment", () => {
    expect(compPath("voqc", null)).toBe("/comp/voqc");
    expect(taskPath("voqc", null, "zqfs", undefined)).toBe("/comp/voqc/task/zqfs");
  });
});
