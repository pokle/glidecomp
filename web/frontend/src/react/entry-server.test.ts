import { describe, it, expect } from "vitest";
// `__GIT_SHA__` is a build-time global (vite `define`); the CI runner (bun test)
// doesn't apply that define, so provide it before the component tree renders.
(globalThis as Record<string, unknown>).__GIT_SHA__ ??= "test";
import { render } from "./entry-server";
import type { CompetitionsLoaderData } from "./loaders";

async function renderToString(url: string, data: unknown): Promise<string> {
  const stream = await render(url, { path: url, data });
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
    expect(html).toContain('href="/comp/abc"');
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
});
