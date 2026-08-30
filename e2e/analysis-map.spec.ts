/**
 * The analysis page's Mapbox map.
 *
 * These run offline against recorded style responses and synthetic basemap
 * tiles — see e2e/fixtures/mapbox.ts for why, and for how to re-record.
 *
 * The failure they exist to catch is the quiet one. When the browser cannot
 * reach Mapbox, or the token is missing or wrong, the page still LOOKS alive:
 * `.mapboxgl-canvas` mounts, the zoom and compass controls render, the Mapbox
 * logo appears, and nothing at all is written to the console. Only two things
 * give it away — the map never leaves world zoom, and no style ever arrives.
 * So every test here asserts the camera reached the flight, not merely that a
 * canvas exists.
 *
 * Mutation-free: drives the bundled sample track and the seeded sample comp
 * read-only, and creates nothing that the pre-run sweep would need to clear.
 */
import { execSync } from "node:child_process";
import { test, expect } from "./fixtures/test";
import { SUPER_ADMIN } from "./fixtures/stack";
import { installMapbox, mapboxMode } from "./fixtures/mapbox";

/** A bundled sample flight — public/data/tracks, no comp or upload needed. */
const SAMPLE_TRACK = "2025-01-05-Tushar-Corryong.igc";

/**
 * The scale bar reads the camera, so it is the cheapest proof that `fitBounds`
 * ran against real track geometry. A map that never got its style, or never
 * got the track, sits at zoom 2 and reads in thousands of kilometres.
 */
const TASK_SCALE = /^\d+(\.\d+)?\s*(m|km)$/;
const WORLD_SCALE = /\d,\d{3}\s*km/;

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  const res = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(res.ok(), `dev-login failed: ${res.status()}`).toBeTruthy();
}

/** The analysis page is behind auth — an anonymous load redirects to /u/me/. */
async function openAnalysis(
  page: import("@playwright/test").Page,
  query: string,
): Promise<void> {
  await page.goto(`/analysis.html?${query}`);
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible({ timeout: 30_000 });
}

const scaleBar = (page: import("@playwright/test").Page) =>
  page.locator(".mapboxgl-ctrl-scale");

/**
 * The seeded sample comp's id, seeding it first if the store is cold.
 *
 * Seeding matters here more than it does in the specs this is copied from
 * (comp-detail, comp-waypoints, task-analysis, full-screen-sheets), because
 * Playwright runs spec FILES in alphabetical order and `analysis-map` sorts
 * ahead of every one of them. On a developer's machine that is invisible — the
 * store was seeded weeks ago — but CI starts from an empty D1 (nothing in the
 * workflow seeds; `test:e2e` only migrates), so this spec meets the cold store
 * FIRST and cannot free-ride on a later spec having filled it in. Two specs do
 * free-ride today, lazy-map-in-view and explain-affordance; both sort after
 * comp-detail, which is the only reason they work.
 */
async function findOrSeedSampleComp(page: import("@playwright/test").Page): Promise<string> {
  const COMP_NAME = "Corryong Cup 2026";

  const find = async (): Promise<string | null> => {
    const res = await page.request.get("/api/comp");
    if (!res.ok()) return null;
    const { comps } = (await res.json()) as {
      comps: Array<{ comp_id: string; name: string }>;
    };
    return comps.find((c) => c.name === COMP_NAME)?.comp_id ?? null;
  };

  const existing = await find();
  if (existing) return existing;

  // Idempotent, and safe to run against a live dev stack — same call the other
  // sample-comp specs make.
  execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });

  const seeded = await find();
  if (!seeded) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  return seeded;
}

test("the map loads its style and flies to the loaded track", async ({ page, context }) => {
  const mapbox = await installMapbox(context);
  await signIn(page);
  await openAnalysis(page, `track=${SAMPLE_TRACK}`);

  // The style arrived and was parsed: Mapbox writes the attribution from it.
  await expect(page.locator(".mapboxgl-ctrl-attrib-inner")).toContainText("Mapbox", {
    timeout: 30_000,
  });

  // The camera reached the flight rather than sitting at world zoom.
  await expect(scaleBar(page)).toHaveText(TASK_SCALE, { timeout: 30_000 });
  await expect(scaleBar(page)).not.toHaveText(WORLD_SCALE);

  mapbox.assertComplete();
});

test("the track's events are marked on the map", async ({ page, context }) => {
  const mapbox = await installMapbox(context);
  await signIn(page);
  await openAnalysis(page, `track=${SAMPLE_TRACK}`);
  await expect(scaleBar(page)).toHaveText(TASK_SCALE, { timeout: 30_000 });

  // Turnpoints and key events are DOM markers, so they are assertable without
  // reading the WebGL canvas. The sample flight has several; the count is left
  // loose deliberately — this guards "the overlay rendered at all", and
  // pinning it would fail on every threshold tweak in the event detector.
  await expect(page.locator(".mapboxgl-marker").first()).toBeVisible({ timeout: 30_000 });
  expect(await page.locator(".mapboxgl-marker").count()).toBeGreaterThan(1);

  // And the analysis itself ran: the panel carries the parsed flight.
  await expect(page.locator("#event-panel-container")).toContainText("Tushar Pokle");
  await expect(page.locator("#event-panel-container")).toContainText(/\d+ of \d+ events/);

  mapbox.assertComplete();
});

test("zooming asks for new tiles and the map keeps working", async ({ page, context }) => {
  const mapbox = await installMapbox(context);
  await signIn(page);
  await openAnalysis(page, `track=${SAMPLE_TRACK}`);
  await expect(scaleBar(page)).toHaveText(TASK_SCALE, { timeout: 30_000 });
  const before = await scaleBar(page).textContent();

  // A camera move asks for a tile set nobody recorded — which is exactly why
  // the basemap is synthesised rather than taped. This would be unrunnable
  // offline against recorded tiles.
  await page.locator(".mapboxgl-ctrl-zoom-in").click();
  await expect(scaleBar(page)).not.toHaveText(before ?? "", { timeout: 15_000 });
  await expect(scaleBar(page)).toHaveText(TASK_SCALE);

  mapbox.assertComplete();
});

test("the track layer can be turned off from the URL", async ({ page, context }) => {
  const mapbox = await installMapbox(context);
  await signIn(page);
  // `track-visible` is on by default, so only '0' disables it (main.ts).
  await openAnalysis(page, `track=${SAMPLE_TRACK}&track-visible=0`);

  // The map still flies to the task — the task layers place the camera even
  // with the track hidden — so the page is alive and the toggle was read.
  await expect(scaleBar(page)).toHaveText(TASK_SCALE, { timeout: 30_000 });
  await expect(page.locator("#track-visibility-status")).toHaveText("(off)");

  mapbox.assertComplete();
});

test("waypoint elevations come back from the Mapbox terrain DEM", async ({ page, context }) => {
  const mapbox = await installMapbox(context);
  await signIn(page);
  await openAnalysis(page, `track=${SAMPLE_TRACK}`);

  // `analysis/elevation.ts` pins zoom 13 and derives the tile from lat/lon
  // alone, so these four points map to a fixed set of tiles for ever — which
  // is what makes this path recordable at all, unlike the render tiles.
  const elevations = await page.evaluate(async () => {
    const mod = await import("/analysis/elevation.ts");
    return mod.fetchElevations([
      { lat: -36.19, lon: 147.9 },
      { lat: -36.25, lon: 147.95 },
      { lat: -36.4, lon: 147.8 },
      { lat: -36.12, lon: 148.05 },
    ]);
  });

  expect(elevations).toHaveLength(4);
  for (const e of elevations) {
    expect(e, "every point should resolve to a ground elevation").not.toBeNull();
    // The Corryong valley floor sits near 300 m and the ranges around it reach
    // past 1,500 m. A reading outside that says the tile decoded to noise.
    expect(e as number).toBeGreaterThan(100);
    expect(e as number).toBeLessThan(2000);
  }
  // Four separate points on real terrain are not all the same height — this is
  // what fails if the DEM stub ever starts answering this endpoint.
  expect(new Set(elevations.map((e) => Math.round(e as number))).size).toBeGreaterThan(1);

  mapbox.assertComplete();
});

test("place search reaches the Mapbox geocoder", async ({ page, context }) => {
  // Seeding a cold store is slow, and this is the spec that pays for it.
  test.setTimeout(300_000);
  const mapbox = await installMapbox(context);
  await signIn(page);

  const compId = await findOrSeedSampleComp(page);

  await page.goto(`/comp/${compId}/waypoints`);
  await expect(page.getByRole("button", { name: "Upload file" })).toBeVisible({ timeout: 15_000 });

  // The geocoder is keyed by the query string, so a recording of "Corryong"
  // answers this for ever — see lib/geocode.ts for why v6 and why nothing it
  // returns may be stored.
  const search = page.getByRole("combobox", { name: "Search for a place" });
  await search.click();
  await search.fill("Corryong");
  await expect(page.getByRole("option").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("option").first()).toContainText(/Corryong/i);

  mapbox.assertComplete();
});

/**
 * The one test that talks to Mapbox for real. Skipped by default: it needs a
 * token, it needs egress, and it spends quota — but without it, nothing would
 * ever notice the recordings drifting away from what the API now returns.
 * Run it with `MAPBOX_LIVE=1 bunx playwright test e2e/analysis-map.spec.ts`.
 */
test("smoke: the real Mapbox API still serves the analysis map", async ({ page, context }) => {
  test.skip(mapboxMode() !== "live", "live-only — set MAPBOX_LIVE=1 to run");

  const mapbox = await installMapbox(context);
  await signIn(page);
  await openAnalysis(page, `track=${SAMPLE_TRACK}`);

  await expect(page.locator(".mapboxgl-ctrl-attrib-inner")).toContainText("OpenStreetMap", {
    timeout: 45_000,
  });
  await expect(scaleBar(page)).toHaveText(TASK_SCALE, { timeout: 45_000 });
  expect(mapbox.counts["relay-failed"] ?? 0, "every live Mapbox request should succeed").toBe(0);
});
