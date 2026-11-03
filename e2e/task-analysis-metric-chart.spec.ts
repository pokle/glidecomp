/**
 * A metric's chart at full size is a PAGE (#815), where it was a full-screen
 * overlay over the Winning strategies page. Part of the "No full-screen
 * overlays" rule in CLAUDE.md: a figure at full size has its own URL and is
 * left with the browser's Back.
 *
 * What this spec pins:
 * - the chart beside the ranking LINKS to
 *   /comp/:c/task/:t/analysis/metrics/<metric> rather than opening a dialog;
 * - the page draws the chart the shape of the screen — on a portrait phone it
 *   grows the viewBox past the scatter's own 316 units, which is the whole
 *   reason the big chart exists — and never narrower than the inline one;
 * - Back returns to the strategies page exactly as it was left: the same
 *   metric chosen (`?metric=`), at the same scroll — from far down the page
 *   too, where the restore has to wait for the page to load again (#844);
 * - side by side, the metric the pane shows is in the URL and lit in the
 *   ranking from the first load of a bare-id URL (#845);
 * - a reload and a shared link rebuild the page from nothing — the report is
 *   fetched by the page, never handed over in memory;
 * - a metric no report carries is a not-found.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts): a phone is where the
 * inline chart is too small to read, and where the overlay misbehaved.
 *
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp, like
 * task-analysis.spec.ts. Never waits on "networkidle": every page of the
 * report keeps a freshness poll in flight by design.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";
const RANKING_HEADING = /Which behaviours went with better ranks/;

let compId: string;
let taskId: string;

test.beforeAll(async ({ playwright }) => {
  // Seeding plus the cold task-analysis compute can both take a while.
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });

  const findComp = async (): Promise<string | null> => {
    const res = await api.get("/api/comp");
    if (!res.ok()) return null;
    const { comps } = (await res.json()) as {
      comps: Array<{ comp_id: string; name: string }>;
    };
    return comps.find((c) => c.name === COMP_NAME)?.comp_id ?? null;
  };

  let found = await findComp();
  if (!found) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    found = await findComp();
  }
  if (!found) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  compId = found;

  const detail = await api.get(`/api/comp/${compId}`);
  expect(detail.ok()).toBe(true);
  const { tasks } = (await detail.json()) as { tasks: Array<{ task_id: string }> };
  taskId = tasks[0].task_id;

  // Never computed on the read path: poll the report warm, so the page shows
  // a ranking rather than the pending notice.
  const reportUrl = `/api/comp/${compId}/task/${taskId}/analysis`;
  for (let i = 0; i < 60; i++) {
    const res = await api.get(reportUrl);
    if (res.ok() && !((await res.json()) as { pending?: boolean }).pending) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await api.dispose();
});

/**
 * A path with its comp and task segments reduced to their ids. The pages
 * rewrite a bare-id URL to the canonical `${slug}-${id}` one once the names
 * load, so a URL captured a moment too early differs only in its slugs.
 */
function byIds(url: string): string {
  const { pathname } = new URL(url, FRONTEND_URL);
  return pathname.replace(
    /\/(comp|task)\/([^/]+)/g,
    (_, kind: string, seg: string) => `/${kind}/${seg.slice(seg.lastIndexOf("-") + 1)}`
  );
}

function ranking(page: Page) {
  return page.getByRole("grid", { name: "Behaviour ranking" });
}

/** The link from the ranking's chart to the full-size page. */
function expandLink(page: Page) {
  return page.getByRole("link", { name: /^Show .+ full size$/ });
}

/** The scatter on the page — the plot carries role="group". */
function scatter(page: Page) {
  return page.locator('svg[role="group"]').first();
}

/**
 * Back has put the page within a few pixels of `y`, and it stays there once
 * whatever loads late has landed (#844, #846).
 */
async function expectScrollRestoredTo(page: Page, y: number) {
  const offBy = async () => Math.abs((await page.evaluate(() => window.scrollY)) - y);
  await expect.poll(offBy).toBeLessThanOrEqual(3);
  await page.waitForTimeout(1000);
  expect(await offBy()).toBeLessThanOrEqual(3);
}

test("the full-size chart is a page: a link in, reload, and Back out", async ({ page }) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/strategies`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();
  await ranking(page).waitFor();

  // Side by side (desktop) the chart is on screen from the start; stacked (a
  // phone) it is behind a row of the ranking.
  const sideBySide = await expandLink(page).isVisible();
  if (!sideBySide) {
    await ranking(page).locator("tbody tr").first().locator("th, td").first().click();
  }
  const link = expandLink(page);
  await expect(link).toBeVisible();
  // Settled before anything is captured from it: the strategies page has
  // moved onto its canonical URL.
  await expect.poll(() => new URL(page.url()).pathname).toContain("-");
  if (sideBySide) {
    // The pane's metric is named in the URL and lit in the ranking — on this
    // bare-id URL too, whose canonical replace used to wipe the seed (#845).
    await expect.poll(() => new URL(page.url()).searchParams.get("metric")).toBeTruthy();
    await expect(ranking(page).locator('tr[aria-selected="true"]')).toHaveCount(1);
  }
  const label = (await link.getAttribute("aria-label"))!.replace(/^Show (.+) full size$/, "$1");
  const inline = (await scatter(page).boundingBox())!;

  // Somewhere down the page, so Back has a scroll position to restore.
  await link.evaluate((el) => el.scrollIntoView({ block: "start" }));
  const from = page.url();
  const scrollFrom = await page.evaluate(() => window.scrollY);
  expect(scrollFrom, "the strategies page should have scrolled").toBeGreaterThan(0);

  await link.click();

  // Its own URL, under the Metric details section.
  await expect
    .poll(() => byIds(page.url()))
    .toMatch(new RegExp(`^/comp/${compId}/task/${taskId}/analysis/metrics/[a-z0-9-]+$`));
  const chartUrl = page.url();
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await expect(scatter(page)).toBeVisible();
  // A page, not an overlay: nothing modal over it.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The trail walks up to the section the page belongs to.
  await expect(
    page.getByRole("navigation", { name: /breadcrumb/i }).getByRole("link", { name: "Metric details" })
  ).toBeVisible();

  // The chart is drawn the shape of the screen. One frame for the measure.
  await page.waitForTimeout(400);
  const big = (await scatter(page).boundingBox())!;
  expect(big.width, "never narrower than the inline chart").toBeGreaterThanOrEqual(
    inline.width - 1
  );
  const viewport = page.viewportSize()!;
  if (viewport.height > viewport.width) {
    const viewBox = await scatter(page).getAttribute("viewBox");
    expect(
      Number(viewBox?.split(" ")[3]),
      "portrait should grow the viewBox past the scatter's natural 316"
    ).toBeGreaterThan(316);
  }

  // Back: the strategies page as it was left — same metric, same scroll.
  await page.goBack();
  await expect(page.getByRole("heading", { name: RANKING_HEADING })).toBeVisible();
  expect(byIds(page.url())).toBe(byIds(from));
  // The same metric beside the ranking (stacked, named by `?metric=`: the
  // detail is still the view rather than the list).
  await expect(expandLink(page)).toHaveAttribute("aria-label", `Show ${label} full size`);
  await expectScrollRestoredTo(page, scrollFrom);

  // Forward, then a reload: the page rebuilds itself from the URL alone.
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: label })).toBeVisible();
  await expect(scatter(page)).toBeVisible();
  expect(byIds(page.url())).toBe(byIds(chartUrl));

  // And Back out of the reloaded page still lands on the strategies page.
  await page.goBack();
  await expect(page.getByRole("heading", { name: RANKING_HEADING })).toBeVisible();
  expect(byIds(page.url())).toBe(byIds(from));
});

test("Back to the strategies page from far down it lands where the reader was", async ({
  page,
}) => {
  // Far down, the offset is one the page only reaches once everything below
  // the ranking has loaded again — so the restore has to wait for it, and
  // anything the page does to its own URL meanwhile (writing its default
  // metric, settling its canonical slug) must not cancel the wait (#844).
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/strategies`, {
    waitUntil: "domcontentloaded",
  });
  await ranking(page).waitFor();
  await expect.poll(() => new URL(page.url()).pathname).toContain("-");

  // The ranking's last row at the bottom of the screen.
  const sideBySide = await expandLink(page).isVisible();
  const last = ranking(page).locator("tbody tr").last();
  await last.evaluate((el) => el.scrollIntoView({ block: "end" }));
  const leftAt = await page.evaluate(() => window.scrollY);
  expect(leftAt, "the strategies page should have scrolled").toBeGreaterThan(0);
  if (sideBySide) {
    // Side by side the chart sticks beside the ranking, so its full-size
    // link is still on screen down here.
    await expect(expandLink(page)).toBeInViewport();
    await expandLink(page).click();
    await expect.poll(() => byIds(page.url())).toContain("/analysis/metrics/");
    await expect(scatter(page)).toBeVisible();
  } else {
    // Stacked, the ranking IS the page, and choosing a behaviour is a
    // navigation to its chart — whose Back is the same restore.
    await last.locator("th, td").first().click();
    await expect(expandLink(page)).toBeVisible();
    await expect(ranking(page)).toBeHidden();
  }

  await page.goBack();
  await expect(ranking(page)).toBeVisible();
  await expectScrollRestoredTo(page, leftAt);
});

test("a shared link opens the chart, and an unknown metric is not found", async ({ page }) => {
  // A metric the ranking links to (one with a correlation, and a behaviour
  // rather than an outcome), by the segment the app builds.
  const res = await page.request.get(`/api/comp/${compId}/task/${taskId}/analysis`);
  const body = (await res.json()) as {
    classes: Array<{
      report: {
        metrics: Array<{ id: string; label: string; correlation?: unknown; outcome?: boolean }>;
      };
    }>;
  };
  const metric = body.classes[0].report.metrics.find((m) => m.correlation && !m.outcome)!;
  const segment = metric.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  await page.goto(`/comp/${compId}/task/${taskId}/analysis/metrics/${segment}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { level: 1, name: metric.label })).toBeVisible();
  await expect(scatter(page)).toBeVisible();

  await page.goto(`/comp/${compId}/task/${taskId}/analysis/metrics/no-such-metric`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { level: 1, name: "Metric not found" })).toBeVisible();
});
