/**
 * The analysis page and the 3D replay under ENFORCED Trusted Types.
 *
 * Production ships Trusted Types report-only on these two pages
 * (TRUSTED_TYPES_HEADERS in web/frontend/src/security-headers.ts, security
 * review proposal A4). This spec is what says enforcing it would break
 * nothing: it serves each page with `Content-Security-Policy:
 * require-trusted-types-for 'script'; trusted-types …` — the same policy, as a
 * blocking header — drives the surfaces that used to build HTML strings, and
 * fails on any violation or page error.
 *
 * Under enforcement, a string that reaches a DOM XSS sink without a policy
 * goes to the page's `default` policy (src/trusted-types.ts): HTML comes back
 * sanitised, and a script URL from elsewhere is refused and THROWS. So what
 * this catches is third-party code doing something the default policy won't
 * allow — Mapbox's worker URL, say — and when it happens the map, the panel or
 * the legend simply stops rendering, which is why every test also asserts that
 * the surface it drove rendered. Our own code is held to a stricter rule — no
 * string sink at all — statically, by web/frontend/src/html-sinks.test.ts.
 *
 * The header is added by the test, not the dev server: Vite serves no
 * `_headers`. Mutation-free — bundled sample data, plus the seeded sample comp
 * for the replay (seeded here if the store is cold).
 */
import { execSync } from "node:child_process";
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { SUPER_ADMIN } from "./fixtures/stack";
import { installMapbox } from "./fixtures/mapbox";
import { TRUSTED_TYPES_POLICY } from "../web/frontend/src/security-headers";
import { SAMPLE_COMP_NAME } from "../web/workers/competition-api/src/sample";

/** A bundled sample flight — public/data/tracks, no comp or upload needed. */
const SAMPLE_TRACK = "2025-01-05-Tushar-Corryong.igc";
/** A bundled sample comp task — public/data/comps, loaded client-side. */
const SAMPLE_COMP_TASK = "corryong-cup-2026-open-t1";
const TASK_SCALE = /^\d+(\.\d+)?\s*(m|km)$/;

/**
 * Serve the page with Trusted Types enforced, and record every violation and
 * uncaught error from before the first script runs.
 */
async function enforceTrustedTypes(context: BrowserContext, page: Page): Promise<() => Promise<string[]>> {
  await context.route(/\/(analysis|replay)\.html(\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": TRUSTED_TYPES_POLICY },
    });
  });

  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __ttViolations: string[] }).__ttViolations = seen;
    document.addEventListener("securitypolicyviolation", (e) => {
      seen.push(`${e.effectiveDirective} ${e.blockedURI} "${e.sample}" at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && /trusted ?type|TrustedHTML|TrustedScript/i.test(msg.text())) {
      errors.push(`console: ${msg.text()}`);
    }
  });

  return async () => [
    ...(await page.evaluate(() => (window as unknown as { __ttViolations: string[] }).__ttViolations)),
    ...errors,
  ];
}

/** The analysis panel starts collapsed at this viewport; open it from its map control. */
async function openPanel(page: Page): Promise<void> {
  const sidebar = page.locator("#waypoint-sidebar");
  if ((await sidebar.getAttribute("aria-hidden")) !== "false") {
    await page.getByRole("button", { name: "Toggle analysis panel" }).click();
  }
  await expect(sidebar).toHaveAttribute("aria-hidden", "false");
}

async function signIn(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(res.ok(), `dev-login failed: ${res.status()}`).toBeTruthy();
}

test("the analysis page renders a flight with Trusted Types enforced", async ({ page, context }) => {
  const mapbox = await installMapbox(context);
  const problems = await enforceTrustedTypes(context, page);
  await signIn(page);

  const res = await page.goto(`/analysis.html?track=${SAMPLE_TRACK}`);
  expect(res!.headers()["content-security-policy"]).toBe(TRUSTED_TYPES_POLICY);

  // Mapbox's own sinks — the attribution from the style, the scale bar, its
  // blob: worker — go through the default policy; the camera reaching the
  // flight proves the worker ran.
  await expect(page.locator(".mapboxgl-ctrl-attrib-inner")).toContainText("Mapbox", { timeout: 30_000 });
  await expect(page.locator(".mapboxgl-ctrl-scale")).toHaveText(TASK_SCALE, { timeout: 30_000 });

  // The panel: its skeleton, the flight-info banner (SEC-47's sink) and the
  // event list (SEC-41's).
  await openPanel(page);
  const panel = page.locator("#event-panel-container");
  await expect(panel.locator(".flight-info-content")).toHaveText(/^Tushar Pokle \| \S.* \| \S/);
  await expect(panel).toContainText(/\d+ of \d+ events/);
  await expect(panel.locator(".event-item").first()).toBeVisible();

  // Each segment list, rendered from a template per row.
  // (This flight has no glide steep enough to count as a sink, so that tab
  // renders its empty state — a template too.)
  for (const [tab, row] of [["Glides", ".glide-item"], ["Climbs", ".climb-item"], ["Sinks", ".sink-item"]] as const) {
    await panel.getByRole("tab", { name: tab, exact: true }).click();
    await expect(panel.locator(row).first().or(panel.getByText("No descents detected"))).toBeVisible();
  }

  // A glide on the map: chevrons and the glide labels' templates.
  await panel.getByRole("tab", { name: "Glides", exact: true }).click();
  await panel.locator(".glide-item").first().click();
  await expect(page.locator("[data-glide-label]").first()).toBeAttached({ timeout: 15_000 });

  // The task editor and the score panel.
  await panel.getByRole("tab", { name: "Task", exact: true }).click();
  await expect(panel.locator(".te-card, .te-empty-add").first()).toBeVisible();
  await panel.getByRole("tab", { name: "Score", exact: true }).click();

  // The glide legend and the annotation toolbar, both built at map creation.
  await expect(page.locator("#glide-legend")).toBeAttached();

  // And the policy really is in force: a raw string at a sink is sanitised by
  // the default policy (with no Trusted Types it would go in verbatim).
  const sanitised = await page.evaluate(() => {
    const div = document.createElement("div");
    div.innerHTML = '<img src="x" onerror="window.__xss=1">';
    return div.innerHTML;
  });
  expect(sanitised).toBe('<img src="x">');

  expect(await problems(), "Trusted Types violations on the analysis page").toEqual([]);
  mapbox.assertComplete();
});

test("the analysis page renders a competition score with Trusted Types enforced", async ({ page, context }) => {
  const mapbox = await installMapbox(context);
  const problems = await enforceTrustedTypes(context, page);
  await signIn(page);

  await page.goto(`/analysis.html?sampleComp=${SAMPLE_COMP_TASK}`);
  await expect(page.locator(".mapboxgl-ctrl-scale")).toHaveText(TASK_SCALE, { timeout: 60_000 });

  // The GAP table (pilot names in text, title and data- attributes — SEC-22's
  // sink) and a pilot's expandable breakdown.
  await openPanel(page);
  const panel = page.locator("#event-panel-container");
  await expect(panel.locator(".comp-pilot-cb").first()).toBeVisible({ timeout: 60_000 });
  await panel.locator(".comp-detail-toggle").first().click();
  await expect(panel.locator(".comp-detail-row:not(.hidden)").first()).toContainText("raw cylinder crossing");

  // Deselecting a pilot re-renders the whole table.
  await panel.locator(".comp-pilot-cb").first().uncheck();
  await expect(panel.locator("#comp-select-all")).not.toBeChecked();

  expect(await problems(), "Trusted Types violations on the competition score").toEqual([]);
  mapbox.assertComplete();
});

/** The seeded sample comp the replay shows by default, seeding it if the store is cold. */
async function ensureSampleComp(page: Page): Promise<void> {
  const res = await page.request.get("/api/comp");
  const { comps } = res.ok() ? ((await res.json()) as { comps: Array<{ name: string }>; }) : { comps: [] };
  if (comps.some((c) => c.name === SAMPLE_COMP_NAME)) return;
  execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
}

test("the 3D replay renders its legend and gaggles with Trusted Types enforced", async ({ page, context }) => {
  test.setTimeout(300_000);
  const problems = await enforceTrustedTypes(context, page);
  await signIn(page);
  await ensureSampleComp(page);

  const res = await page.goto("/replay.html");
  expect(res!.headers()["content-security-policy"]).toBe(TRUSTED_TYPES_POLICY);

  // The pilot legend (one template per pilot) and the map-style picker.
  await expect(page.locator("#legend li").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#legend .name").first()).not.toBeEmpty();
  expect(await page.locator("#mapStyle option").count()).toBeGreaterThan(0);

  // The gaggle list renders a row per episode, or says there are none.
  await expect(page.locator("#gaggleList li").first()).toBeAttached({ timeout: 30_000 });

  expect(await problems(), "Trusted Types violations on the replay").toEqual([]);
});
