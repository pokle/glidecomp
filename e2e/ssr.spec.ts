import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * SSR verification against the REAL Pages runtime (wrangler pages dev on the
 * built dist + the SSR Function). Unlike the SPA dev server, these routes
 * server-render, so we assert on the raw HTML fetched with `request.get()`
 * (no JavaScript runs) — the defining property of SSR is that the content is
 * already in that HTML. A final block loads the pages in a real browser and
 * asserts there are no hydration mismatches.
 *
 * The sample comp's public id changes every seed, so everything is discovered
 * at runtime from GET /api/comp rather than hardcoded.
 */

interface Discovered {
  compId: string;
  compName: string;
  taskId: string;
  pilotId: string;
  pilotName: string;
}

async function discover(request: APIRequestContext): Promise<Discovered> {
  const listRes = await request.get("/api/comp");
  expect(listRes.ok()).toBeTruthy();
  const { comps } = (await listRes.json()) as {
    comps: Array<{ comp_id: string; name: string; test: boolean }>;
  };
  const comp = comps.find((c) => !c.test);
  if (!comp) throw new Error("No public sample comp seeded — run `bun run seed corryong-cup-2026`.");

  const scoresRes = await request.get(`/api/comp/${comp.comp_id}/scores`);
  expect(scoresRes.ok()).toBeTruthy();
  const scores = (await scoresRes.json()) as {
    standings: Array<{
      pilots: Array<{ comp_pilot_id: string; pilot_name: string; tasks: Array<{ task_id: string }> }>;
    }>;
  };
  const pilot = scores.standings.flatMap((s) => s.pilots).find((p) => p.tasks.length > 0);
  if (!pilot) throw new Error("Sample comp has no scored pilots.");

  return {
    compId: comp.comp_id,
    compName: comp.name,
    taskId: pilot.tasks[0].task_id,
    pilotId: pilot.comp_pilot_id,
    pilotName: pilot.pilot_name,
  };
}

test.describe("SSR — content is in the server HTML (no JS)", () => {
  test("/comp lists competitions with names and links", async ({ request }) => {
    const { compId, compName } = await discover(request);
    const res = await request.get("/comp");
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(compName);
    expect(html).toContain(`href="/comp/${compId}"`);
    expect(html).toContain("<title>Competitions — GlideComp</title>");
    expect(html).toContain('rel="canonical"');
  });

  test("/comp/:id shows standings and links to pilot narrative pages", async ({ request }) => {
    const { compId, compName, taskId, pilotId, pilotName } = await discover(request);
    const res = await request.get(`/comp/${compId}`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(compName);
    // A standings pilot name and a link to their per-task score explanation.
    expect(html).toContain(pilotName);
    expect(html).toContain(`/comp/${compId}/task/${taskId}/pilot/${pilotId}`);
    expect(html).toContain(`<title>${compName} — GlideComp</title>`);
  });

  test("task page shows the route and per-class scores", async ({ request }) => {
    const { compId, taskId } = await discover(request);
    const res = await request.get(`/comp/${compId}/task/${taskId}`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('window.__SSR_DATA__');
    // Turnpoints table / route content renders server-side.
    expect(html.toLowerCase()).toMatch(/turnpoint|start|goal/);
  });

  test("waypoints page lists the comp's shared waypoints", async ({ request }) => {
    const { compId, compName } = await discover(request);
    const wpRes = await request.get(`/api/comp/${compId}/waypoints`);
    expect(wpRes.ok()).toBeTruthy();
    const { waypoints } = (await wpRes.json()) as {
      waypoints: Array<{ code: string; name: string }>;
    };
    test.skip(waypoints.length === 0, "sample comp has no waypoints seeded");
    const res = await request.get(`/comp/${compId}/waypoints`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    // The table content is in the raw server HTML.
    expect(html).toContain(waypoints[0].code);
    expect(html).toContain(`<title>Waypoints — ${compName} — GlideComp</title>`);
    // The map stays client-only — its Suspense fallback is what the server streams.
    expect(html).not.toContain("mapboxgl-canvas");
  });

  test("pilot narrative page shows the explanation, but not the map", async ({ request }) => {
    const { compId, taskId, pilotId, pilotName } = await discover(request);
    const res = await request.get(`/comp/${compId}/task/${taskId}/pilot/${pilotId}`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(pilotName);
    // Some scoring-explanation prose is present in the server HTML.
    expect(html.toLowerCase()).toMatch(/scored|distance|goal|points/);
    // The map is client-only — no rendered mapbox canvas in the server HTML.
    expect(html).not.toContain("mapboxgl-canvas");
  });
});

test.describe("SSR — isolation and fallback", () => {
  test("an invalid/missing comp returns 404 + noindex", async ({ request }) => {
    const res = await request.get("/comp/zzznope", { failOnStatusCode: false });
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain('name="robots" content="noindex"');
  });

  test("a non-SSR SPA route still serves the plain app shell", async ({ request }) => {
    const res = await request.get("/u/me");
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain("window.__SSR_DATA__");
  });

  /**
   * Field analysis is admin-only and deliberately client-only, so a hard
   * reload of its deep URL must still get a usable SPA shell — the Functions
   * fallback path, which `vite dev` never exercises — and must not be
   * indexable, since there is nothing in it for a crawler.
   */
  for (const path of [
    "/comp/anything/analysis",
    "/comp/anything/task/anything/analysis",
  ]) {
    test(`a hard reload of ${path} serves a noindex app shell`, async ({ request }) => {
      const res = await request.get(path, { failOnStatusCode: false });
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toContain('<div id="root"></div>');
      expect(html).toContain('name="robots" content="noindex"');
      expect(html).not.toContain("window.__SSR_DATA__");
    });
  }
});

test.describe("SSR — hydration is clean (real browser)", () => {
  for (const path of ["/comp", ":compHub", ":waypoints", ":task", ":pilot"] as const) {
    test(`no hydration mismatch on ${path}`, async ({ page, request }) => {
      const d = await discover(request);
      const url =
        path === "/comp"
          ? "/comp"
          : path === ":compHub"
            ? `/comp/${d.compId}`
            : path === ":waypoints"
              ? `/comp/${d.compId}/waypoints`
              : path === ":task"
                ? `/comp/${d.compId}/task/${d.taskId}`
                : `/comp/${d.compId}/task/${d.taskId}/pilot/${d.pilotId}`;

      const hydrationErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error" && /hydrat|did not match|#418|#423|server rendered/i.test(msg.text())) {
          hydrationErrors.push(msg.text());
        }
      });
      await page.goto(url);
      // Give hydration a beat to run and surface any mismatch.
      await page.waitForLoadState("networkidle");
      expect(hydrationErrors, hydrationErrors.join("\n")).toHaveLength(0);
    });
  }
});
