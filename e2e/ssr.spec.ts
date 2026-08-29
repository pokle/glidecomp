import { test, expect, type APIRequestContext } from "./fixtures/test";
import {
  compPath,
  compScoresPath,
  compAnalysisPath,
} from "../web/frontend/src/react/lib/slug";
import { SCORES_CSV_COLUMNS } from "../web/frontend/src/scores-csv";
import { SAMPLE_COMP_NAME } from "../web/workers/competition-api/src/sample";

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
  /** Every pilot class in the comp — the `?class=` cases need a real one. */
  pilotClasses: string[];
}

/**
 * Find the seeded sample comp — BY NAME, never by list position.
 *
 * These tests share one local D1 with the rest of the suite, and other public
 * comps end up in it: api-doc.spec.ts creates an "API Doc Comp <timestamp>"
 * on every run and never deletes it, and a developer may have seeded the
 * whole bundled set. Taking
 * `comps[0]` meant the entire SSR suite could fail on somebody else's fixture
 * with "Sample comp has no scored pilots" — a data-pollution artifact that
 * reads exactly like a broken SSR page.
 *
 * So: the fixture the serve script actually seeds
 * (web/scripts/ssr-e2e-serve.sh → `bun run seed corryong-cup-2026`) is tried
 * first by name, then any other public comp as a fallback, and a comp without
 * scored pilots is skipped rather than fatal. The error, if every candidate
 * fails, names what was tried and how to fix it.
 */
async function discover(request: APIRequestContext): Promise<Discovered> {
  const listRes = await request.get("/api/comp");
  expect(listRes.ok()).toBeTruthy();
  const { comps } = (await listRes.json()) as {
    comps: Array<{ comp_id: string; name: string; test: boolean; pilot_classes?: string[] }>;
  };
  const publicComps = comps.filter((c) => !c.test);
  if (publicComps.length === 0) {
    throw new Error("No public sample comp seeded — run `bun run seed corryong-cup-2026`.");
  }

  // Named fixture first; everything else only as a fallback.
  const candidates = [
    ...publicComps.filter((c) => c.name === SAMPLE_COMP_NAME),
    ...publicComps.filter((c) => c.name !== SAMPLE_COMP_NAME),
  ];

  const skipped: string[] = [];
  for (const comp of candidates) {
    const scoresRes = await request.get(`/api/comp/${comp.comp_id}/scores`);
    if (!scoresRes.ok()) {
      skipped.push(`${comp.name} (scores HTTP ${scoresRes.status()})`);
      continue;
    }
    const scores = (await scoresRes.json()) as {
      class_scores: Array<{
        pilots: Array<{ comp_pilot_id: string; pilot_name: string; tasks: Array<{ task_id: string }> }>;
      }>;
    };
    const pilot = scores.class_scores.flatMap((s) => s.pilots).find((p) => p.tasks.length > 0);
    if (!pilot) {
      skipped.push(`${comp.name} (no scored pilots)`);
      continue;
    }

    return {
      compId: comp.comp_id,
      compName: comp.name,
      taskId: pilot.tasks[0].task_id,
      pilotId: pilot.comp_pilot_id,
      pilotName: pilot.pilot_name,
      pilotClasses: comp.pilot_classes ?? [],
    };
  }

  throw new Error(
    `No public comp with scored pilots. Tried: ${skipped.join("; ")}. ` +
      `Expected "${SAMPLE_COMP_NAME}" — seed it with \`bun run seed corryong-cup-2026\`. ` +
      "If a previous `bun run test:e2e` left comps behind, reset with `bun run kill-state`."
  );
}

test.describe("SSR — content is in the server HTML (no JS)", () => {
  test("/comp lists competitions with names and links", async ({ request }) => {
    const { compId, compName } = await discover(request);
    const res = await request.get("/comp");
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(compName);
    // Links are canonical `${slug}-${id}` (see lib/slug).
    expect(html).toContain(`href="${compPath(compId, compName)}"`);
    expect(html).toContain("<title>Competitions — GlideComp</title>");
    // No canonical by design: iOS Safari's share sheet copies the canonical
    // URL, which goes stale after client-side navigation.
    expect(html).not.toContain('rel="canonical"');
  });

  test("/comp/:id shows the scores summary and links to the scores page", async ({ request }) => {
    const { compId, compName, pilotName } = await discover(request);
    const res = await request.get(`/comp/${compId}`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(compName);
    // The top-3 summary carries the leading pilot's name; the full tables
    // (and per-pilot narrative links) live on the scores page it links to.
    expect(html).toContain(pilotName);
    expect(html).toContain(`href="${compScoresPath(compId, compName)}"`);
    expect(html).toContain(`<title>${compName} — GlideComp</title>`);
  });

  test("/comp/:id/scores shows scores and links to pilot narrative pages", async ({ request }) => {
    const { compId, compName, taskId, pilotId, pilotName } = await discover(request);
    const res = await request.get(`/comp/${compId}/scores`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(pilotName);
    // The scores pilot links are canonical `${slug}-${id}` at every level.
    expect(html).toMatch(
      new RegExp(`/comp/[a-z0-9-]+-${compId}/task/[a-z0-9-]+-${taskId}/pilot/[a-z0-9-]+-${pilotId}`)
    );
    expect(html).toContain(`<title>Scores — ${compName} — GlideComp</title>`);
  });

  test("/comp/:id/scores.csv serves the scores as long-form CSV", async ({ request }) => {
    const { compId, compName, taskId, pilotId, pilotName } = await discover(request);
    const res = await request.get(`/comp/${compId}/scores.csv`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain(".csv");
    // Never indexed — the page is the indexable form of this data.
    expect(res.headers()["x-robots-tag"]).toContain("noindex");

    const [header, ...rows] = (await res.text()).trim().split("\n");
    expect(header).toBe(SCORES_CSV_COLUMNS.join(","));
    // Long form: one row per pilot per task, so the leading pilot has a row
    // naming a task rather than a column per task.
    const pilotRows = rows.filter((r) => r.includes(pilotId));
    expect(pilotRows.length).toBeGreaterThan(0);
    expect(pilotRows.some((r) => r.includes(taskId))).toBeTruthy();
    expect(rows.some((r) => r.includes(pilotName))).toBeTruthy();
    expect(rows.every((r) => r.includes(compName) || r.includes(`"${compName}"`))).toBeTruthy();

    // The link columns are absolute against THIS origin (so a preview
    // deployment's export stays inside the preview) and they resolve.
    const cells = pilotRows[0].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const scoreUrl = cells[SCORES_CSV_COLUMNS.indexOf("score_url")];
    expect(scoreUrl).toContain(`${new URL(res.url()).origin}/comp/`);
    expect((await request.get(scoreUrl)).status()).toBe(200);
  });

  test("a missing comp's scores.csv is a 404, not an empty file", async ({ request }) => {
    const res = await request.get("/comp/zzznope/scores.csv", { failOnStatusCode: false });
    expect(res.status()).toBe(404);
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

  test("officially published results annotate the pilot page (issue #603)", async ({ request }) => {
    const { compId, taskId, pilotId } = await discover(request);
    // The annotation exists only for imported comps whose official record the
    // seed stored — true of the corryong-cup-2026 fixture this suite seeds.
    // A fallback comp without one should skip, not fail: absence of official
    // data is a data condition, not an SSR defect.
    const scoreRes = await request.get(`/api/comp/${compId}/task/${taskId}/score`);
    expect(scoreRes.ok()).toBeTruthy();
    const score = (await scoreRes.json()) as {
      official_results?: { task_url: string | null; ranks: Record<string, unknown> };
    };
    test.skip(
      !score.official_results?.ranks?.[pilotId],
      "seeded comp carries no official result for this pilot"
    );

    const res = await request.get(`/comp/${compId}/task/${taskId}/pilot/${pilotId}`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    // The header carries the published standing, linked to the source's own
    // task scores page — in the server HTML, not hydrated in later. React
    // escapes `&` in attributes, so compare against the escaped form.
    expect(html).toContain("Officially:");
    if (score.official_results?.task_url) {
      expect(html).toContain(
        `href="${score.official_results.task_url.replace(/&/g, "&amp;")}"`
      );
    }
  });
});

test.describe("SSR — isolation and fallback", () => {
  test("an invalid/missing comp returns 404 + noindex", async ({ request }) => {
    const res = await request.get("/comp/zzznope", { failOnStatusCode: false });
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain('name="robots" content="noindex"');
  });

  test("/comp?q= is a noindex shell, not a server-rendered list", async ({ request }) => {
    // A search on the competitions page. The results come from
    // /api/comp/search client-side, so there is nothing to server-render —
    // and a search-results URL is not a page for a crawler to keep. Serving
    // the plain shell is also what keeps hydration trivial: no SSR data, so
    // the client creates a fresh root rather than matching against markup the
    // search is about to replace.
    const res = await request.get("/comp?q=kangck");
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).not.toContain("window.__SSR_DATA__");
    // The bare URL is unaffected — still the real server-rendered list.
    const bare = await request.get("/comp");
    expect(await bare.text()).not.toContain('name="robots" content="noindex"');
  });

  // /submit is here rather than in the noindex list below: it is not under
  // /comp, so _routes.json never hands it to the SSR Function at all — it is a
  // _redirects rewrite to the plain shell, and that is the contract to pin.
  for (const path of ["/u/me", "/submit"]) {
    test(`a non-SSR SPA route (${path}) still serves the plain app shell`, async ({
      request,
    }) => {
      const res = await request.get(path);
      expect(res.ok()).toBeTruthy();
      const html = await res.text();
      expect(html).toContain('<div id="root"></div>');
      expect(html).not.toContain("window.__SSR_DATA__");
    });
  }

  /**
   * A hard reload of an admin-only / redirect-only deep URL must still get a
   * usable SPA shell — the Functions fallback path, which `vite dev` never
   * exercises — and must not be indexable, since there is nothing in it for a
   * crawler. (Field analysis is no longer here — it is SSR'd; see below.)
   */
  for (const path of [
    // Admin-only roster editor page.
    "/comp/anything/pilots",
    // Admin-only settings pages (index + a group sub-page).
    "/comp/anything/settings",
    "/comp/anything/settings/scoring",
    // The pilot-similarity prototype: a real SPA route that derives everything
    // client-side from the report it fetches, so it has nothing to
    // server-render and must reach the shell rather than the 404 fallback.
    "/comp/anything/task/anything/analysis/similar",
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

test.describe("URL canonicalisation (301 to slug-id)", () => {
  test("a bare comp id 301s to the lowercase slugged canonical", async ({ request }) => {
    const { compId, compName } = await discover(request);
    const res = await request.get(`/comp/${compId}`, { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    const loc = new URL(res.headers()["location"]).pathname;
    expect(loc).toBe(compPath(compId, compName));
    expect(loc).toBe(loc.toLowerCase());
    expect(loc.endsWith(`-${compId}`)).toBe(true);
  });

  test("the canonical comp URL serves 200 (no redirect loop)", async ({ request }) => {
    const { compId, compName } = await discover(request);
    const res = await request.get(compPath(compId, compName), { maxRedirects: 0 });
    expect(res.status()).toBe(200);
  });

  test("a bare task URL 301s to the fully-slugged canonical", async ({ request }) => {
    const { compId, taskId } = await discover(request);
    const res = await request.get(`/comp/${compId}/task/${taskId}`, { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    const loc = new URL(res.headers()["location"]).pathname;
    expect(loc).toMatch(new RegExp(`^/comp/[a-z0-9-]+-${compId}/task/[a-z0-9-]+-${taskId}$`));
  });

  test("a mixed-case slug 301s back to the lowercase canonical", async ({ request }) => {
    const { compId, compName } = await discover(request);
    const canonical = compPath(compId, compName);
    test.skip(!canonical.includes("-"), "sample comp name has no slug");
    // Upper-case only the slug portion; the "/comp/" prefix and the id (after
    // the last dash) stay as-is so the route still matches and the id decodes.
    const cut = canonical.lastIndexOf("-");
    const mixed =
      "/comp/" + canonical.slice("/comp/".length, cut).toUpperCase() + canonical.slice(cut);
    const res = await request.get(mixed, { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(new URL(res.headers()["location"]).pathname).toBe(canonical);
  });

  /**
   * The per-task field analysis was public and server-rendered at
   * /comp/:c/analysis/task/:t through July–August 2026 before moving under the
   * task. That URL is in the wild, so it must 301 rather than serve a shell —
   * a crawler handed a noindex shell learns only that the page is gone.
   */
  test("the superseded per-task analysis URL 301s to the one under the task", async ({
    request,
  }) => {
    const { compId, taskId } = await discover(request);
    for (const [from, to] of [
      [
        `/comp/${compId}/analysis/task/${taskId}?class=open`,
        `/comp/${compId}/task/${taskId}/analysis`,
      ],
      [
        `/comp/${compId}/analysis/task/${taskId}/similar`,
        `/comp/${compId}/task/${taskId}/analysis/similar`,
      ],
    ]) {
      const res = await request.get(from, { maxRedirects: 0 });
      expect(res.status()).toBe(301);
      const loc = new URL(res.headers()["location"]);
      expect(loc.pathname).toBe(to);
      // The query is the shareable half of these URLs (`?class=`, `?pilot=`).
      expect(loc.search).toBe(from.includes("?") ? "?class=open" : "");
    }
  });

  test("a trailing slash 301s to the canonical (no slash)", async ({ request }) => {
    const { compId, compName } = await discover(request);
    const canonical = compPath(compId, compName);
    const res = await request.get(canonical + "/", { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(new URL(res.headers()["location"]).pathname).toBe(canonical);
  });
});

/**
 * The cold field-analysis path returns `pending` and schedules a background
 * compute, so poll to give it a chance to warm. Callers must still tolerate a
 * pending result — a slow compute must never make a test flaky.
 */
async function warmTaskAnalysis(
  request: APIRequestContext,
  compId: string,
  taskId: string
): Promise<void> {
  const apiUrl = `/api/comp/${compId}/task/${taskId}/field-analysis`;
  for (let i = 0; i < 20; i++) {
    const r = await request.get(apiUrl);
    if (r.ok()) {
      const b = (await r.json()) as { pending: boolean };
      if (!b.pending) break;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

test.describe("SSR — field analysis (public)", () => {
  test("task field analysis server-renders (warm content or a pending notice)", async ({
    request,
  }) => {
    const { compId, taskId } = await discover(request);
    await warmTaskAnalysis(request, compId, taskId);

    const res = await request.get(`/comp/${compId}/task/${taskId}/analysis`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    // The defining SSR property: the loader data is embedded in the raw HTML.
    expect(html).toContain("window.__SSR_DATA__");
    expect(html).toContain("Field analysis —");
    // Branch on the actual server HTML (race-free): warm renders the summary's
    // section boxes and is indexable; cold renders the pending notice and is
    // noindex.
    if (html.includes("What separated the field")) {
      expect(html).not.toContain('name="robots" content="noindex"');
    } else {
      expect(html.toLowerCase()).toContain("pending");
      expect(html).toContain('name="robots" content="noindex"');
    }
  });

  /**
   * Each section of the task report is its own public page, through the same
   * loader. They carry the substance the chapter page now only summarises, so
   * they are the ones that have to be server-rendered — a client-only shell
   * here would take the whole per-task analysis out of the index.
   */
  test("each section of the task report server-renders under its own title", async ({
    request,
  }) => {
    const { compId, taskId } = await discover(request);
    await warmTaskAnalysis(request, compId, taskId);

    for (const [slug, heading] of [
      ["separation", "What separated the field"],
      ["day", "The day they flew"],
      ["pilots", "Where each pilot sat"],
      ["method", "How this was measured"],
    ]) {
      const res = await request.get(`/comp/${compId}/task/${taskId}/analysis/${slug}`);
      expect(res.ok(), slug).toBeTruthy();
      const html = await res.text();
      expect(html, slug).toContain("window.__SSR_DATA__");
      expect(html, slug).toContain(`${heading} —`);
    }
  });

  test("an unknown section of the task report is a 404 noindex shell", async ({
    request,
  }) => {
    const { compId, taskId } = await discover(request);
    const res = await request.get(
      `/comp/${compId}/task/${taskId}/analysis/nonsense`,
      { failOnStatusCode: false }
    );
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('name="robots" content="noindex"');
  });

  test("comp field analysis server-renders with a title and SSR data", async ({
    request,
  }) => {
    const { compId, compName } = await discover(request);
    const res = await request.get(`/comp/${compId}/analysis`);
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain("window.__SSR_DATA__");
    expect(html).toContain(`Field analysis — ${compName}`);
  });

  test("field analysis of an invalid comp is a 404 noindex shell", async ({ request }) => {
    const res = await request.get("/comp/zzznope/analysis", { failOnStatusCode: false });
    expect(res.status()).toBe(404);
    const html = await res.text();
    expect(html).toContain('name="robots" content="noindex"');
  });

  /**
   * The query string is part of the rendered location, not just a client-side
   * afterthought. The server used to render the pathname alone, so `?class=`
   * came back as the FIRST class no matter what the link asked for — and the
   * client, which does read the query, then hydrated a different tree.
   *
   * The COMP report, not a task's: the sample comp's classes fly different
   * tasks, so a task report only ever has the one class and `?class=` there
   * can never differ from the default. The comp aggregate carries every class
   * that has a warm task report, so this warms until a second one appears.
   *
   * Asserted on the print-only "Pilot class: X" line, which states the
   * selection as markup (the select itself carries it only as a DOM property).
   */
  test("a ?class= deep link server-renders that class, not the default", async ({
    request,
  }) => {
    test.slow(); // warms several task reports before it can assert anything
    const { compId } = await discover(request);

    // Reading the comp endpoint schedules revalidation for each cold task, so
    // polling it is also what warms it.
    let classes: string[] = [];
    for (let i = 0; i < 45; i++) {
      const r = await request.get(`/api/comp/${compId}/field-analysis`);
      if (r.ok()) {
        const b = (await r.json()) as {
          classes: Array<{ pilot_class: string }>;
          pending_task_count: number;
        };
        classes = b.classes.map((c) => c.pilot_class);
        // Two is all this needs; and once nothing is pending, no further
        // polling can add a class.
        if (classes.length >= 2 || b.pending_task_count === 0) break;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    test.skip(
      classes.length < 2,
      `comp has ${classes.length} warm class(es) — nothing to switch to`
    );

    // The second class: asking for the first proves nothing, since that is
    // what the broken server rendered too.
    const wanted = classes[1];
    const res = await request.get(
      `/comp/${compId}/analysis?class=${encodeURIComponent(wanted)}`
    );
    expect(res.ok()).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(`<strong>${wanted}</strong>`);
  });
});

test.describe("sitemap", () => {
  test("lists the static pages and each public comp's top-level surfaces", async ({
    request,
  }) => {
    const { compId } = await discover(request);
    const res = await request.get("/sitemap.xml");
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("xml");
    const xml = await res.text();
    const origin = new URL(res.url()).origin;

    // The evergreen static content pages (the SEO-valuable ones).
    for (const path of ["/", "/about", "/scoring", "/scoring/gap", "/scoring/open-distance"]) {
      expect(xml).toContain(`<loc>${origin}${path}</loc>`);
    }
    // The comp list + this comp's hub, scores, and (GAP) field analysis — all
    // as canonical `${slug}-${id}` URLs (the form the SSR Function 301s to).
    const { compName } = await discover(request);
    expect(xml).toContain(`<loc>${origin}/comp</loc>`);
    expect(xml).toContain(`<loc>${origin}${compPath(compId, compName)}</loc>`);
    expect(xml).toContain(`<loc>${origin}${compScoresPath(compId, compName)}</loc>`);
    expect(xml).toContain(`<loc>${origin}${compAnalysisPath(compId, compName)}</loc>`);
    // Deliberately NOT listed: per-task and per-pilot deep pages, waypoints.
    expect(xml).not.toContain("/task/");
    expect(xml).not.toContain("/pilot/");
    expect(xml).not.toContain("/waypoints");
    // Every lastmod is a bare date (YYYY-MM-DD), never a full datetime — the
    // creation_date fallback is an ISO timestamp and must be normalized.
    expect(xml).not.toMatch(/<lastmod>[^<]*T/);
    for (const m of xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)) {
      expect(m[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

/**
 * These assert no hydration mismatch on the real hydrated pages. NOTE the
 * corpus caveat: the seeded sample comp is Australian, and `AEST`/`AEDT`
 * resolve identically on the workerd SSR runtime and in the browser, so this
 * harness alone would NOT catch a zone whose ICU `timeZoneName: "short"`
 * abbreviation diverges between the two runtimes (e.g. Europe/Bucharest →
 * "EEST" on workerd but "GMT+3" in some browsers — the bug that motivated the
 * deferred-enrichment fix). That whole class is instead prevented structurally:
 * SSR-rendered instants render the tzdata offset alone until mounted (see
 * lib/time.ts `zoneLabel`/`buildZoneCycle` + lib/use-mounted.ts), pinned by the
 * "unenriched (SSR)" cases in lib/time.test.ts. Keep both guards.
 */
test.describe("SSR — hydration is clean (real browser)", () => {
  for (const path of [
    "/comp",
    ":compHub",
    ":scores",
    ":waypoints",
    ":task",
    ":pilot",
    ":compAnalysis",
    ":taskAnalysis",
    ":taskSeparation",
    // WITH a query string. Not the guard for the pathname-only SSR bug — both
    // of these passed while it was live (the "?class= deep link" test above is
    // what catches that). They are here because no URL in this list carried a
    // query at all, so the whole "a query-bearing URL hydrates cleanly" case
    // was unexercised — and the next query-driven view will need it.
    ":scoresByTask",
    ":compAnalysisByClass",
    // The submit page: not SSR'd, but it is in the Shell, so the nav and the
    // account slot hydrate around it like anywhere else.
    "/submit",
  ] as const) {
    test(`no hydration mismatch on ${path}`, async ({ page, request }) => {
      const d = await discover(request);
      // A class the comp actually has, so the query is not silently discarded
      // as unknown by both sides (which would agree, and prove nothing).
      const cls = d.pilotClasses[d.pilotClasses.length - 1];
      const urls: Record<typeof path, string> = {
        "/comp": "/comp",
        ":compHub": `/comp/${d.compId}`,
        ":scores": `/comp/${d.compId}/scores`,
        ":waypoints": `/comp/${d.compId}/waypoints`,
        ":task": `/comp/${d.compId}/task/${d.taskId}`,
        ":pilot": `/comp/${d.compId}/task/${d.taskId}/pilot/${d.pilotId}`,
        ":compAnalysis": `/comp/${d.compId}/analysis`,
        ":taskAnalysis": `/comp/${d.compId}/task/${d.taskId}/analysis`,
        ":taskSeparation": `/comp/${d.compId}/task/${d.taskId}/analysis/separation`,
        ":scoresByTask": `/comp/${d.compId}/scores?task=${d.taskId}`,
        ":compAnalysisByClass": `/comp/${d.compId}/analysis${
          cls ? `?class=${encodeURIComponent(cls)}` : ""
        }`,
        "/submit": "/submit",
      };
      const url = urls[path];

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
