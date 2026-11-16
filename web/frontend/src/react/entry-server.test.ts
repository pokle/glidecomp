import { describe, it, expect } from "vitest";
// `__GIT_SHA__` is a build-time global (vite `define`); the CI runner (bun test)
// doesn't apply that define, so provide it before the component tree renders.
(globalThis as Record<string, unknown>).__GIT_SHA__ ??= "test";
import { render } from "./entry-server";
import type { CompetitionsLoaderData, CompAnalysisLoaderData } from "./loaders";

/**
 * Mirrors the Pages Function exactly: the router gets the full URL, while
 * `initialData.path` is the PATHNAME alone (useInitialData matches it against
 * location.pathname). Getting that split wrong is the bug this file guards.
 */
async function renderToString(url: string, data: unknown): Promise<string> {
  const path = new URL(url, "http://ssr.local").pathname;
  const stream = await render(url, { path, data });
  return new Response(stream as ReadableStream).text();
}

describe("entry-server render (SSR)", () => {
  it("renders the competitions list with names and links in the HTML", async () => {
    const data: CompetitionsLoaderData = {
      comps: [
        {
          comp_id: "abc",
          name: "Corryong Cup 2026",
          category: "hg",
          creation_date: "2026-01-01T00:00:00Z",
          pilot_classes: ["open", "floater"],
          scoring_format: "gap",
          is_admin: false,
          test: false,
          first_task_date: "2026-01-12",
          last_task_date: "2026-01-18",
        },
      ],
    };
    const html = await renderToString("/comp", data);
    // The content is present in the server HTML — the whole point of SSR.
    expect(html).toContain("Corryong Cup 2026");
    // Links are canonical `${slug}-${id}` (see lib/slug).
    expect(html).toContain('href="/comp/corryong-cup-2026-abc"');
    // Non-content assertion: the page actually rendered (not an empty shell).
    expect(html.length).toBeGreaterThan(500);
  });

  it("renders the comp waypoints table in the HTML", async () => {
    // Minimal slice of CompWaypointsLoaderData — the page reads comp.name,
    // comp.is_admin and the waypoint records.
    const data = {
      comp: { name: "Corryong Cup 2026", is_admin: false },
      waypoints: [
        {
          code: "A01",
          name: "Mount Elliot Launch",
          latitude: -36.15,
          longitude: 147.9,
          altitude: 1050,
          radius: 400,
        },
      ],
    };
    const html = await renderToString("/comp/abc/waypoints", data);
    expect(html).toContain("Waypoints");
    // The read-only table rows are real server-rendered content.
    expect(html).toContain("A01");
    expect(html).toContain("Mount Elliot Launch");
    expect(html).toContain("Corryong Cup 2026");
  });

  // The server used to render the pathname alone, so `?class=floater` came out
  // as the default class and the client — which does see the query — hydrated
  // a different tree. Every shared deep link was a hydration mismatch.
  it("renders the view the query string asks for, not the default", async () => {
    const aggregate = { taskLabels: [], pilots: [], metrics: [] };
    const data: CompAnalysisLoaderData = {
      analysis: {
        comp_id: "abc",
        comp_name: "Corryong Cup 2026",
        tasks: [],
        task_labels: [],
        classes: [
          { pilot_class: "open", aggregate },
          { pilot_class: "floater", aggregate },
        ],
        computed_at: "2026-01-20T00:00:00Z",
        stale: false,
        pending_task_count: 0,
        total_task_count: 2,
      },
      analysisEtag: null,
      comp: null,
    };

    // The print-only "Pilot class: X" line states the selection in the markup
    // (the select itself carries it only as a DOM property).
    const chosen = await renderToString("/comp/abc/analysis?class=floater", data);
    expect(chosen).toContain("<strong>floater</strong>");

    // No query → first class, as before. Pins that the fix didn't just make
    // the query win everywhere.
    const fallback = await renderToString("/comp/abc/analysis", data);
    expect(fallback).toContain("<strong>open</strong>");
  });

  // A query naming something that isn't in this comp must fall back, not blank
  // the page — the same validate-against-the-data rule the client applies.
  it("falls back to the default view when the query names an unknown value", async () => {
    const aggregate = { taskLabels: [], pilots: [], metrics: [] };
    const data: CompAnalysisLoaderData = {
      analysis: {
        comp_id: "abc",
        comp_name: "Corryong Cup 2026",
        tasks: [],
        task_labels: [],
        classes: [
          { pilot_class: "open", aggregate },
          { pilot_class: "floater", aggregate },
        ],
        computed_at: "2026-01-20T00:00:00Z",
        stale: false,
        pending_task_count: 0,
        total_task_count: 2,
      },
      analysisEtag: null,
      comp: null,
    };
    const html = await renderToString("/comp/abc/analysis?class=nosuchclass", data);
    expect(html).toContain("<strong>open</strong>");
  });
});
