/**
 * Every `/comp` page the router has gets an answer from the SSR Function.
 *
 * The router (routes.tsx) and the Function's tables (comp-routes.ts) are two
 * lists of the same URLs, and a page in the first but not the second works in
 * dev — which serves the SPA shell for everything — and is a real 404 in
 * production. That is how a routed editor ships broken, and it is invisible
 * until someone hard-reloads it there. So this reads routes.tsx as text (the
 * way no-overlays.test.ts reads source files) and asks the tables, in the
 * Function's own order, what each of its `/comp` paths gets.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TASK_ANALYSIS_SECTIONS } from "./analysis/sections";
import {
  COMP_REDIRECT_ROUTES,
  COMP_SHELL_ROUTES,
  COMP_SSR_ROUTES,
  compRouteRegExp,
  compRouteVariants,
  fillCompRoute,
  type CompRoute,
} from "./comp-routes";
import * as slug from "./lib/slug";

// vitest runs with the workspace root as cwd (web/frontend).
const ROUTES_TSX = readFileSync(join(process.cwd(), "src", "react", "routes.tsx"), "utf8");

/** Every `path="…"` under /comp in the router, in declaration order. */
const ROUTER_PATHS = [...ROUTES_TSX.matchAll(/\bpath="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((p) => p === "/comp" || p.startsWith("/comp/"));

/** The Function's order: redirects, then the shell list, then the SSR list. */
const TABLES = [
  ["redirect", COMP_REDIRECT_ROUTES],
  ["shell", COMP_SHELL_ROUTES],
  ["ssr", COMP_SSR_ROUTES],
] as const satisfies ReadonlyArray<readonly [string, readonly CompRoute[]]>;

/**
 * The shell entries that deliberately share an SSR route's shape and are
 * answered first because they are tried first: a static segment where the
 * public route has an id. Any OTHER overlap is a shell entry swallowing a
 * public page (or a public pattern catching an editor), and fails below.
 */
const SHADOWS: Record<string, string> = {
  "/comp/new": "/comp/:compId",
  "/comp/:compId/task/new": "/comp/:compId/task/:taskId",
};

/**
 * Example values for a router path's params. The comp's is a hidden comp's
 * share-keyed id, so this also proves a keyed URL is answered like a bare one.
 */
const SAMPLE: Record<string, string> = {
  compId: "corryong-cup-2027-vzuq_7hq2m9xk4rwd",
  taskId: "task-1-abcd",
  pilotId: "jane-doe-wxyz",
  rowId: "3",
  group: "scoring",
  metric: "climb-time-to-core",
};

/** The URLs a router path is tried with: `:section` is a route only for the
 * listed slugs (anything else is NotFound in both), so it takes each. */
function samples(path: string): string[] {
  const slugs: string[] = path.includes(":section")
    ? TASK_ANALYSIS_SECTIONS.map((s) => s.slug)
    : [""];
  return slugs.map((slug) =>
    fillCompRoute(path, (name) => (name === "section" ? slug : (SAMPLE[name] ?? "abcd")))
  );
}

/** What each table has for a URL, in the order the Function asks them. */
function lookup(url: string) {
  return TABLES.map(([kind, table]) => ({
    kind,
    entries: table.filter((r) => compRouteRegExp(r.path).test(url)) as CompRoute[],
  })).filter((hit) => hit.entries.length > 0);
}

describe("the SSR Function answers every /comp route in routes.tsx", () => {
  it("finds the router's /comp routes, all as literal paths", () => {
    // A `path={…}` expression is a route this test cannot read.
    expect(ROUTES_TSX).not.toMatch(/\bpath=\{/);
    expect(ROUTER_PATHS).toContain("/comp");
    expect(ROUTER_PATHS.length).toBeGreaterThan(30);
  });

  it.each(ROUTER_PATHS)("%s is answered exactly once", (path) => {
    for (const url of samples(path)) {
      const hits = lookup(url);
      // Nothing answers: a real 404 in production, though dev serves it.
      expect(hits, `${url} matches no table in comp-routes.ts`).not.toHaveLength(0);
      const [first, ...later] = hits;
      expect(
        first.entries.map((e) => e.path),
        `${url} matches more than one ${first.kind} entry`
      ).toHaveLength(1);
      for (const hit of later) {
        expect(
          { path, answeredBy: first.kind, alsoMatches: hit.entries.map((e) => e.path) },
          `${url} is answered by a ${first.kind} entry but a ${hit.kind} entry matches it too`
        ).toEqual({
          path,
          answeredBy: "shell",
          alsoMatches: SHADOWS[path] ? [SHADOWS[path]] : [],
        });
      }
    }
  });

  it.each(Object.entries(SHADOWS))("%s is a shell route, ahead of %s", (shell, ssr) => {
    expect(ROUTER_PATHS).toContain(shell);
    expect(COMP_SHELL_ROUTES.map((r) => r.path)).toContain(shell);
    expect(COMP_SSR_ROUTES.map((r) => r.path as string)).toContain(ssr);
  });
});

describe("every entry in the tables answers a real route", () => {
  // Each sample URL, with the one entry that answers it.
  const answered = ROUTER_PATHS.flatMap(samples).map((url) => ({
    url,
    entry: lookup(url)[0]?.entries[0],
  }));

  const entries = TABLES.flatMap(([kind, table]) =>
    table.map((entry) => [`${kind} ${entry.path}`, entry] as const)
  );

  it.each(entries)("%s", (_label, entry) => {
    expect(entry.why.trim()).not.toBe("");
    // Every spelt-out form of it, so a dead branch of `(a|b)` or a dead
    // optional tail is caught too — and answered by THIS entry, so one that
    // an earlier entry always beats is dead as well.
    for (const variant of compRouteVariants(entry.path)) {
      const re = compRouteRegExp(variant);
      expect(
        answered.some((a) => a.entry === entry && re.test(a.url)),
        `${variant} answers no route in routes.tsx`
      ).toBe(true);
    }
  });
});

describe("the path builders land where the tables say", () => {
  const c = ["vzuq_7hq2m9xk4rwd", "Corryong Cup 2027"] as const;
  const t = [...c, "abcd", "Task 1"] as const;
  const p = [...t, "wxyz", "Jane Doe"] as const;
  const cases: Array<[string, "shell" | "ssr" | "redirect"]> = [
    [slug.compPath(...c), "ssr"],
    [slug.compScoresPath(...c), "ssr"],
    [slug.compWaypointsPath(...c), "ssr"],
    [slug.compAnalysisPath(...c), "ssr"],
    [slug.taskPath(...t), "ssr"],
    [slug.taskDiagramPath(...t), "ssr"],
    [slug.pilotPath(...p), "ssr"],
    [slug.taskAnalysisPath(...t), "ssr"],
    [slug.taskAnalysisSectionPath(...t, "thermals"), "ssr"],
    [slug.taskAnalysisMetricPath(...t, "climb.time_to_core"), "ssr"],
    [slug.newCompPath(), "shell"],
    [slug.compPilotsPath(...c), "shell"],
    [slug.compPilotPath(...c, "new"), "shell"],
    [slug.compPilotPath(...c, "wxyz", "Jane Doe"), "shell"],
    [slug.compPilotsImportPath(...c), "shell"],
    [slug.compPilotsCivlFillPath(...c), "shell"],
    [slug.compSettingsPath(...c), "shell"],
    [slug.compSettingsPath(...c, "scoring"), "shell"],
    [slug.compWaypointPath(...c, 3), "shell"],
    [slug.compWaypointsNewPath(...c), "shell"],
    [slug.compWaypointsMapPath(...c), "shell"],
    [slug.compAltitudeReviewPath(...c), "shell"],
    [slug.compAltitudeReviewPath(...c, 3), "shell"],
    [slug.compNewTaskPath(...c), "shell"],
    [slug.taskSettingsPath(...t), "shell"],
    [slug.taskRoutePath(...t), "shell"],
    [slug.taskRouteTurnpointPath(...t, 3), "shell"],
    [slug.taskRouteQuickPath(...t), "shell"],
    [slug.taskRouteXContestPath(...t), "shell"],
    [slug.taskRouteAddWaypointPath(...t), "shell"],
    [slug.taskWeatherPath(...t), "shell"],
    [slug.taskTestIgcPath(...t), "shell"],
    [slug.taskQrPath(...t), "shell"],
    [slug.taskSimilarityPath(...t), "shell"],
    [slug.taskThermalMapPath(...t), "shell"],
    [slug.manualFlightPath(...p), "shell"],
  ];

  it.each(cases)("%s is %s", (url, kind) => {
    expect(lookup(url)[0]?.kind).toBe(kind);
  });
});

describe("the pattern syntax", () => {
  it("matches the router's own syntax, anchored, with an optional trailing slash", () => {
    const re = compRouteRegExp("/comp/:compId/task/:taskId/qr");
    expect(re.test("/comp/c-abcd/task/t-wxyz/qr")).toBe(true);
    expect(re.test("/comp/c-abcd/task/t-wxyz/qr/")).toBe(true);
    expect(re.test("/comp/c-abcd/task/t-wxyz/qr/more")).toBe(false);
    expect(re.test("/x/comp/c-abcd/task/t-wxyz/qr")).toBe(false);
    // A param is one segment, never two.
    expect(re.test("/comp/c/abcd/task/t-wxyz/qr")).toBe(false);
  });

  it("captures params and groups left to right, the order a loader reads them", () => {
    const m = "/comp/c-abcd/analysis/task/t-wxyz/similar".match(
      compRouteRegExp("/comp/:compId/analysis/task/:taskId(/similar)?")
    );
    expect(m?.slice(1)).toEqual(["c-abcd", "t-wxyz", "/similar"]);
    const bare = "/comp/c-abcd/analysis/task/t-wxyz".match(
      compRouteRegExp("/comp/:compId/analysis/task/:taskId(/similar)?")
    );
    expect(bare?.slice(1)).toEqual(["c-abcd", "t-wxyz", undefined]);
  });

  it("spells out alternations and optional tails", () => {
    expect(compRouteVariants("/comp/:compId/settings(/:group)?")).toEqual([
      "/comp/:compId/settings/:group",
      "/comp/:compId/settings",
    ]);
    expect(compRouteVariants("/comp/:c/task/:t/(settings|route|weather)")).toEqual([
      "/comp/:c/task/:t/settings",
      "/comp/:c/task/:t/route",
      "/comp/:c/task/:t/weather",
    ]);
    const re = compRouteRegExp("/comp/:c/task/:t/(settings|route|weather)");
    expect(re.test("/comp/a/task/b/route")).toBe(true);
    expect(re.test("/comp/a/task/b/qr")).toBe(false);
  });

  it("refuses anything outside it", () => {
    expect(() => compRouteRegExp("/comp/(a|b")).toThrow();
    expect(() => compRouteRegExp("/comp/a)")).toThrow();
    expect(() => compRouteRegExp("/comp/*")).toThrow();
    expect(() => compRouteRegExp("/comp/scores.csv")).toThrow();
  });
});
