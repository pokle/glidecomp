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
  taskAnalysisMetricPath,
  metricSegment,
  pilotPath,
  bareCompId,
  compUrlId,
  pathCarriesShareKey,
  redactShareKeys,
  submitTrackPath,
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

  test("a metric's full-size chart: its id as a dot-free segment under Metric details", () => {
    // No dot in the path: the dev and e2e servers treat a dotted path as a
    // file and never hand it to the app (isSpaRoute, src/dev-routing.ts).
    expect(metricSegment("climb.time_to_core")).toBe("climb-time-to-core");
    expect(
      taskAnalysisMetricPath("voqc", "Corryong Cup 2026", "zqfs", "Task 3 (Open)", "climb.time_to_core")
    ).toBe("/comp/corryong-cup-2026-voqc/task/task-3-open-zqfs/analysis/metrics/climb-time-to-core");
  });

  test("a missing name degrades to a bare-id segment", () => {
    expect(compPath("voqc", null)).toBe("/comp/voqc");
    expect(taskPath("voqc", null, "zqfs", undefined)).toBe("/comp/voqc/task/zqfs");
  });
});

describe("hidden competitions' share links", () => {
  const hidden = { comp_id: "vzuq", test: true, share_key: "7hq2m9xk4rwd" };

  test("the share key rides along as part of the id", () => {
    expect(idFromSegment("corryong-cup-2027-vzuq_7hq2m9xk4rwd")).toBe("vzuq_7hq2m9xk4rwd");
    expect(nameSlugFromSegment("corryong-cup-2027-vzuq_7hq2m9xk4rwd")).toBe("corryong-cup-2027");
    expect(compPath("vzuq_7hq2m9xk4rwd", "Corryong Cup 2027")).toBe(
      "/comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd"
    );
  });

  test("compUrlId: a hidden comp's URL carries its key, a public one's never does", () => {
    expect(compUrlId(hidden, "vzuq")).toBe("vzuq_7hq2m9xk4rwd");
    // A draft link still works after publishing, and settles on the clean URL.
    expect(compUrlId({ ...hidden, test: false }, "vzuq_7hq2m9xk4rwd")).toBe("vzuq");
    // No key in the payload (an old cached body): keep what the URL has.
    expect(compUrlId({ ...hidden, share_key: null }, "vzuq_aaaaaaaaaaaa")).toBe(
      "vzuq_aaaaaaaaaaaa"
    );
    expect(compUrlId(null, "vzuq")).toBe("vzuq");
  });

  test("submitTrackPath: the key goes to /submit with the comp id", () => {
    expect(submitTrackPath(compUrlId(hidden, "vzuq"), "t-1-abcd")).toBe(
      "/submit?comp=vzuq_7hq2m9xk4rwd&task=t-1-abcd"
    );
    expect(submitTrackPath("vzuq")).toBe("/submit?comp=vzuq");
    expect(submitTrackPath("vzuq", null)).toBe("/submit?comp=vzuq");
  });

  test("the key rides into a metric's full-size chart", () => {
    expect(
      taskAnalysisMetricPath(compUrlId(hidden, "vzuq"), "Corryong Cup 2027", "abcd", "Task 1", "glide.ld")
    ).toBe("/comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd/task/task-1-abcd/analysis/metrics/glide-ld");
  });

  test("bareCompId drops the key, for comparing ids", () => {
    expect(bareCompId("vzuq_7hq2m9xk4rwd")).toBe("vzuq");
    expect(bareCompId("vzuq")).toBe("vzuq");
  });

  test("pathCarriesShareKey looks at the comp segment only", () => {
    expect(pathCarriesShareKey("/comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd")).toBe(true);
    expect(pathCarriesShareKey("/comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd/task/t-1-abcd")).toBe(
      true
    );
    expect(pathCarriesShareKey("/comp/corryong-cup-2027-vzuq/task/t-1-abcd")).toBe(false);
    expect(pathCarriesShareKey("/comp")).toBe(false);
  });

  test("redactShareKeys masks every key and leaves the rest of the URL", () => {
    expect(
      redactShareKeys(
        "https://glidecomp.com/comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd/task/t-1-abcd"
      )
    ).toBe("https://glidecomp.com/comp/corryong-cup-2027-vzuq_[key]/task/t-1-abcd");
    expect(redactShareKeys("/analysis?compId=vzuq_7hq2m9xk4rwd&taskId=abcd")).toBe(
      "/analysis?compId=vzuq_[key]&taskId=abcd"
    );
    expect(redactShareKeys("/comp/corryong-cup-2027-vzuq")).toBe("/comp/corryong-cup-2027-vzuq");
  });
});
