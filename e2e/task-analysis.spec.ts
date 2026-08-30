/**
 * Task analysis — the separation ranking's master/detail behaviour
 * (issue #455), plus the thermals census and the page-wide pilot pin.
 *
 * The report is a page per section since August 2026
 * (/comp/:id/task/:id/analysis/<section>, see analysis/sections.ts), so
 * what used to be one scroll is three loads here: the ranking on
 * /strategies, the thermals on /thermals, the per-pilot tables on /metrics.
 * The chapter URL itself is a contents list of boxes and has nothing these
 * tests assert.
 *
 * Ranking and thermals are the same MasterDetail in `navigation` mode: the
 * detail is a page in its own right, so stacked it REPLACES the list rather
 * than pinning above it, and the selection lives in the query (`?metric=`,
 * `?thermal=`) so the browser's Back is the way out. These tests assert the
 * properties that mode is made of, because every part of it is a class or a
 * history call that nothing else would catch: the hiding is a container
 * query, the push is one boolean off a ResizeObserver, and the selection
 * lives in the URL.
 *
 *   1. picking a row swaps the pane's heading (and the top metric is charted
 *      first),
 *   2. wide → both halves on screen, the pane to the RIGHT of the table,
 *      the table has NOT gone back to scrolling sideways, a pick does not
 *      grow history,
 *   3. narrow → the list alone until a row is chosen, then the detail
 *      alone; Back and the in-page control return to the list; arrows move
 *      focus without navigating, Enter chooses, focus follows the view.
 *
 * A second group covers the full-screen overlay (MetricChartOverlay). The
 * inline plot already spends most of a phone's height on the rank axis;
 * Expand is the way to the remaining width, so labels come up to a readable
 * size. The assertion that matters is that the sheet really does grow the
 * viewBox — a full-screen dialog that kept BASE_H would letterbox the same
 * strip the page already showed.
 *
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp: nothing is
 * created, so there is nothing to clean up (an e2e-created comp is exactly
 * what breaks the SSR suite's discover()). The page is public — no sign-in.
 *
 * Gotcha honoured here: never wait on "networkidle". A task-analysis page
 * keeps a freshness poll in flight by design, so it never settles — wait on
 * role locators.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";
const RANKING_HEADING = /Which behaviours went with better ranks/;
const THERMALS_HEADING = /The day's thermals/;

let analysisPath: string;
/**
 * The task the THERMALS tests load. Deliberately not always `analysisPath`'s:
 * thermal ids start at ZERO, and the section's selection lives in the query,
 * so a task whose census carries a thermal with id 0 is the one that catches
 * an absent parameter being read as a choice of it — which is exactly how
 * this section shipped broken once (the census could never be the view, and
 * "All thermals" appeared to do nothing). Falls back to the same task as the
 * rest of the spec when the seed has no such report.
 */
let thermalsPath: string;

// ONE page load PER SECTION for the whole file, and the tests are ordered so
// each section is loaded once. Every test here asserts CSS/ARIA behaviour of
// an already-rendered report, and this is the heaviest report in the app —
// loading it per test made this spec 76s of the E2E suite's 178s (43%), eight
// loads' worth. So the tests share a single page and only ever change the
// viewport, which the layout is built to respond to live (a container query
// plus a ResizeObserver): resizing exercises the same code path a reload
// would, without paying for the report again.
//
// The cost of sharing is that state leaks forward, which shapes two rules:
// serial mode (so a failure skips the rest rather than reporting a cascade of
// confusing failures against a page the previous test left mangled), and
// every test leaves the page as it found it — beforeEach only undoes the one
// thing that is invisible to the next test's own setup, the scroll position.
// The first-paint assertion has to be the FIRST test for the same reason: it
// is the only one that reads state nothing resets.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser, playwright }) => {
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

  let compId = await findComp();
  if (!compId) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    compId = await findComp();
  }
  if (!compId) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);

  const detail = await api.get(`/api/comp/${compId}`);
  expect(detail.ok()).toBe(true);
  const { tasks } = (await detail.json()) as { tasks: Array<{ task_id: string }> };
  const taskId = tasks[0].task_id;
  analysisPath = `/comp/${compId}/task/${taskId}/analysis`;
  thermalsPath = analysisPath;

  // Task analysis never computes on the read path — a cold report answers
  // "pending" and schedules the work. Poll it warm here so the UI tests get a
  // ranking table instead of the pending notice.
  const reportUrl = `/api/comp/${compId}/task/${taskId}/analysis`;
  for (let i = 0; i < 60; i++) {
    const res = await api.get(reportUrl);
    if (res.ok()) {
      const body = (await res.json()) as { pending?: boolean };
      if (!body.pending) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Prefer a task whose thermal census starts at id 0 (see `thermalsPath`).
  // The seed warms every task's report, so this only reads them.
  for (const t of tasks) {
    const res = await api.get(`/api/comp/${compId}/task/${t.task_id}/analysis`);
    if (!res.ok()) continue;
    const body = (await res.json()) as {
      pending?: boolean;
      classes?: Array<{ report?: { thermals?: { shapes?: Array<{ id: number }> } } }>;
    };
    if (body.pending) continue;
    const shapes = body.classes?.[0]?.report?.thermals?.shapes ?? [];
    if (shapes.some((s) => s.id === 0)) {
      thermalsPath = `/comp/${compId}/task/${t.task_id}/analysis`;
      break;
    }
  }

  await api.dispose();

  page = await browser.newPage();
  await openSection("strategies");
});

test.afterAll(async () => {
  await page?.close();
});

test.beforeEach(async () => {
  // Tests that scroll leave the page scrolled. Reset it; every other reset
  // (viewport, selection, the fold toggle) is done by the test that needs it.
  await page.evaluate(() => window.scrollTo(0, 0));
});

/**
 * Open one section of the report, or stay put if it is already open. Waits on
 * a role locator — never on the network going idle: every page of the report
 * keeps a freshness poll in flight by design.
 */
let openSlug: string | null = null;
async function openSection(slug: "strategies" | "thermals" | "metrics") {
  if (openSlug === slug) return;
  const base = slug === "thermals" ? thermalsPath : analysisPath;
  await page.goto(`${base}/${slug}`, { waitUntil: "domcontentloaded" });
  openSlug = slug;
  if (slug === "strategies") {
    await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();
    await ranking().waitFor();
  } else if (slug === "thermals") {
    await page.getByRole("heading", { name: THERMALS_HEADING }).waitFor();
  } else {
    await openFamilyTable().waitFor();
  }
}

/** The ranking table. */
function ranking() {
  return page.getByRole("grid", { name: "Behaviour ranking" });
}

/**
 * The first per-pilot table on the metric-details page. Families open by
 * default when they hold a top-3 behaviour, so at least one is expanded.
 */
function openFamilyTable() {
  return page.getByRole("grid", { name: /metrics by pilot$/ }).first();
}

/** The card the ranking and its chart share. */
function rankingCard() {
  return page.locator("section", {
    has: page.getByRole("heading", { name: RANKING_HEADING }),
  });
}

/** The ranking pane's Expand button. Scoped to the ranking's card, which also
 * keeps it honest if anything else on the page grows a full-screen control. */
function rankingExpand() {
  return rankingCard().getByRole("button", { name: /full screen$/ }).first();
}

/** The selected-metric pane. Scoped to the ranking's own card — the thermals
 * census is a MasterDetail too, with a pane of the same shape. */
function detailPane() {
  return rankingCard()
    .locator('[role="region"][aria-labelledby]')
    .filter({ has: page.locator("svg") })
    .first();
}

/** The metric the detail pane is showing, per the query. */
function metricParam(): string | null {
  return new URL(page.url()).searchParams.get("metric");
}

/** Stacked: get back to the ranking list if an earlier test left a metric chosen. */
async function ensureRankingList() {
  const back = rankingCard().getByRole("button", { name: "All behaviours" });
  if (await back.isVisible()) await back.click();
  await expect(ranking()).toBeVisible();
  await expect(detailPane()).toBeHidden();
}

/** Stacked: get onto the detail if the list is currently the view. */
async function ensureRankingDetail() {
  if (await ranking().isVisible()) {
    await ranking().locator("tbody tr").first().locator("th, td").first().click();
  }
  await expect(detailPane()).toBeVisible();
}

/**
 * Resize and let the chart catch up. The plot is drawn from a box the
 * ResizeObserver reports, so a measurement taken in the same tick as the
 * resize reads the OLD geometry.
 */
async function setViewport(width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(400);
}

// FIRST, and must stay first: the only test here that reads first-paint state
// (which metric the pane opens on), and the only one nothing resets.
test("picking a row swaps the chart, and the top metric is charted first", async () => {
  await openSection("strategies");
  const table = ranking();
  const pane = detailPane();

  const heading = pane.locator("h3").first();
  const first = (await heading.textContent())?.trim();
  expect(first).toBeTruthy();

  // The pane leads with the top-ranked behaviour, so the strongest finding is
  // already plotted on first paint.
  const topRowName = (await table.locator("tbody tr").first().locator("th, td").first().innerText())
    .split("\n")[0]
    .trim();
  expect(first).toBe(topRowName);

  const fourth = table.locator("tbody tr").nth(3);
  const fourthName = (await fourth.locator("th, td").first().innerText()).split("\n")[0].trim();
  await fourth.locator("th, td").first().click();

  await expect(heading).toHaveText(fourthName);
  // RAC drives the selection state, so the row says so to assistive tech.
  await expect(table.locator('tr[aria-selected="true"]')).toHaveCount(1);
});

test("wide: the chart sits beside the table, and the table still fits", async () => {
  await openSection("strategies");
  await setViewport(1600, 1000);
  const table = ranking();
  const pane = detailPane();

  const tableBox = (await table.boundingBox())!;
  const paneBox = (await pane.boundingBox())!;

  // Beside, not below: the pane starts after the table ends horizontally,
  // and the two share a top edge.
  expect(paneBox.x).toBeGreaterThan(tableBox.x + tableBox.width - 1);
  expect(Math.abs(paneBox.y - tableBox.y)).toBeLessThan(4);

  // The scatter spends the sticky column on the rank axis, not a ~190px
  // strip under the method prose. One frame for the ResizeObserver.
  await page.waitForTimeout(400);
  const plot = (await pane.locator('svg[role="group"]').boundingBox())!;
  expect(plot.height, "desktop plot should fill the sticky column").toBeGreaterThan(
    1000 * 0.45
  );

  // The split must not have squeezed the ranking back into a sideways
  // scroll — that regression is what issue #453 was closed on.
  const overflow = await table.evaluate((el) => {
    const wrapper = el.parentElement!;
    return wrapper.scrollWidth - wrapper.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  // Side by side the query names the pane's subject (seeded, so the row is
  // lit) and a pick must not cost a Back press — both halves are on screen.
  await expect.poll(() => metricParam()).toBeTruthy();
  await expect(table.locator('tr[aria-selected="true"]')).toHaveCount(1);
  const rows = table.locator("tbody tr");
  const other = rows.nth((await rows.count()) - 1);
  const start = (await other.locator("th, td").first().innerText()).split("\n")[0].trim();
  const entries = await page.evaluate(() => history.length);
  await other.locator("th, td").first().click();
  await expect(pane.locator("h3").first()).toHaveText(start);
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test("narrow: choosing a behaviour navigates, and Back returns to the ranking", async () => {
  await openSection("strategies");
  await setViewport(390, 780);
  await ensureRankingList();

  // The list alone. Nothing of the detail is on screen until one is chosen.
  await expect(ranking()).toBeVisible();
  await expect(detailPane()).toBeHidden();
  expect(metricParam()).toBeNull();

  const first = ranking().locator("tbody tr").first();
  const start = (await first.locator("th, td").first().innerText()).split("\n")[0].trim();
  await first.locator("th, td").first().click();

  // The detail takes the whole view, and the URL names what it is showing —
  // so the reading is shareable and Back has an entry to return to.
  await expect(detailPane()).toBeVisible();
  await expect(detailPane().locator("h3").first()).toHaveText(start);
  await expect(ranking()).toBeHidden();
  expect(metricParam()).toBeTruthy();

  // The method prose is a disclosure under the chart, not a paragraph above
  // it. The trigger is there; the explanation is not, until opened.
  const how = detailPane().getByRole("button", { name: "How this is measured" });
  await expect(how).toBeVisible();
  await expect(how).toHaveAttribute("aria-expanded", "false");

  // The scatter takes most of the screen, not a ~190px strip under the essay.
  await page.waitForTimeout(400);
  const plot = (await detailPane().locator('svg[role="group"]').boundingBox())!;
  expect(plot.height, "inline plot should fill most of the viewport").toBeGreaterThan(
    780 * 0.55
  );

  await page.goBack();
  await expect(ranking()).toBeVisible();
  await expect(detailPane()).toBeHidden();
  expect(metricParam()).toBeNull();

  // The in-page control is the same way out, for a reader who does not use
  // the browser's — and it unwinds our push rather than stacking on it.
  await first.locator("th, td").first().click();
  await expect(detailPane()).toBeVisible();
  const entries = await page.evaluate(() => history.length);
  await rankingCard().getByRole("button", { name: "All behaviours" }).click();
  await expect(ranking()).toBeVisible();
  expect(metricParam()).toBeNull();
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test("narrow: arrowing through the ranking does not navigate; Enter does", async () => {
  await openSection("strategies");
  await setViewport(390, 780);
  await ensureRankingList();
  await expect(ranking()).toBeVisible();

  // The ranking selects on TOGGLE, not on focus: under react-aria's "replace"
  // behaviour the arrow keys select whatever they focus, which here would
  // take the list — and the reader's place in it — off the screen on the
  // first Down press.
  // Focus a cell that is not the behaviour name: that cell holds the ⓘ, and
  // Enter there would open the method popover instead of choosing the row.
  await ranking().locator("tbody tr").first().locator("th, td").nth(1).focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(ranking()).toBeVisible();
  await expect(detailPane()).toBeHidden();
  expect(metricParam()).toBeNull();

  const focused = await page.evaluate(() => {
    const cell = (document.activeElement as HTMLElement)?.closest("tr")?.querySelector("th, td");
    return cell ? (cell as HTMLElement).innerText.split("\n")[0].trim() : "";
  });
  expect(focused).toBeTruthy();

  await page.keyboard.press("Enter");
  await expect(detailPane()).toBeVisible();
  await expect(detailPane().locator("h3").first()).toHaveText(focused);
  // Focus follows the view, or a keyboard reader is left on a hidden node.
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe(
    "region"
  );

  await page.goBack();
  await expect(ranking()).toBeVisible();
});

test("expanding the chart grows the viewBox to fill the sheet", async () => {
  await openSection("strategies");
  for (const [label, width, height] of [
    ["portrait", 390, 780],
    ["landscape", 780, 390],
  ] as const) {
    // The inline plot is re-measured after each resize, so both orientations
    // compare like with like without reloading between them.
    await setViewport(width, height);
    await ensureRankingDetail();

    const inline = (await page.locator('svg[role="group"]').first().boundingBox())!;
    await rankingExpand().click();

    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    // One frame for the ResizeObserver to report the sheet's box.
    await page.waitForTimeout(400);
    const expanded = (await dialog.locator('svg[role="group"]').boundingBox())!;
    const viewBox = await dialog.locator('svg[role="group"]').getAttribute("viewBox");
    const viewBoxHeight = Number(viewBox?.split(" ")[3]);

    // The inline plot already spends most of a portrait viewport on the rank
    // axis, so Expand is no longer a 2× jump. What it still has to do is grow
    // the viewBox to match the sheet — otherwise portrait letterboxes BASE_H
    // in a full-screen dialog. Landscape is already full-width; the sheet
    // must not shrink it.
    expect(expanded.width, `${label} width`).toBeGreaterThanOrEqual(inline.width - 1);
    if (label === "portrait") {
      expect(viewBoxHeight, "portrait sheet should grow the viewBox").toBeGreaterThan(316);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});

test("the expanded chart stays open when you tap a dot, and returns focus on close", async () => {
  await openSection("strategies");
  await setViewport(390, 780);
  await ensureRankingDetail();

  const trigger = rankingExpand();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();

  // RAC focuses the Close button, so Escape is not the only way out.
  await expect(page.locator(":focus")).toHaveText("Close");

  // The deliberate departure from the QR / task-glyph overlays: those make the
  // whole sheet a close target because their content is a picture. Every dot
  // here is interactive, so tapping one must NOT dismiss.
  await dialog.locator("svg g[tabindex]").first().click({ force: true });
  await expect(dialog).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

/** The thermal census (the master). The print-only copy of every row is
 *  aria-hidden, so this never matches two grids. */
function census() {
  return page.getByRole("grid", { name: "Reconstructed thermals" });
}

/** The thermals card, and the detail pane inside it. */
function thermalsCard() {
  return page.locator("section", {
    has: page.getByRole("heading", { name: THERMALS_HEADING }),
  });
}
function thermalPane() {
  return thermalsCard().locator('[role="region"][aria-labelledby]').first();
}

/** The thermal the detail pane is showing, per the query. */
function thermalParam(): string | null {
  return new URL(page.url()).searchParams.get("thermal");
}

/** Choose the census's first thermal, from the census. */
async function chooseFirstThermal(): Promise<string> {
  const first = census().locator("tbody tr").first();
  const start = (await first.locator("th, td").first().innerText()).trim();
  await first.locator("th, td").first().click();
  return start;
}

/**
 * The thermals section is the same MasterDetail in `navigation` mode as the
 * ranking above. Its detail is a page in its own right (rose, readouts, climb
 * profile, two tables), so stacked it does not pin above the census — it
 * REPLACES it, and the way back is the browser's own Back. That contract is
 * what this asserts, because every part of it is a class or a history call
 * that nothing else would catch: the hiding is a container query, the push is
 * one boolean off a ResizeObserver, and the selection lives in the URL.
 */
test("narrow: choosing a thermal navigates, and Back returns to the census", async () => {
  await openSection("thermals");
  await setViewport(390, 780);
  await census().scrollIntoViewIfNeeded();

  // The list alone. Nothing of the detail is on screen until one is chosen.
  await expect(census()).toBeVisible();
  await expect(thermalPane()).toBeHidden();
  expect(thermalParam()).toBeNull();

  const start = await chooseFirstThermal();

  // The detail takes the whole view, and the URL names what it is showing —
  // so the reading is shareable and Back has an entry to return to.
  await expect(thermalPane()).toBeVisible();
  await expect(thermalPane().locator("h3").first()).toContainText(start);
  await expect(census()).toBeHidden();
  expect(thermalParam()).toBeTruthy();

  await page.goBack();
  await expect(census()).toBeVisible();
  await expect(thermalPane()).toBeHidden();
  expect(thermalParam()).toBeNull();

  // The in-page control is the same way out, for a reader who does not use
  // the browser's — and it unwinds our push rather than stacking on it.
  await chooseFirstThermal();
  await expect(thermalPane()).toBeVisible();
  const entries = await page.evaluate(() => history.length);
  await thermalsCard().getByRole("button", { name: "All thermals" }).click();
  await expect(census()).toBeVisible();
  expect(thermalParam()).toBeNull();
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test("narrow: arrowing through the census does not navigate; Enter does", async () => {
  await openSection("thermals");
  await setViewport(390, 780);
  await expect(census()).toBeVisible();

  // The census selects on TOGGLE, not on focus: under react-aria's "replace"
  // behaviour the arrow keys select whatever they focus, which here would
  // take the list — and the reader's place in it — off the screen on the
  // first Down press.
  await census().locator("tbody tr").first().locator("th, td").first().focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(census()).toBeVisible();
  await expect(thermalPane()).toBeHidden();
  expect(thermalParam()).toBeNull();

  const focused = await page.evaluate(
    () => (document.activeElement as HTMLElement)?.closest("tr")?.querySelector("th, td")?.textContent ?? ""
  );
  expect(focused.trim()).toBeTruthy();

  await page.keyboard.press("Enter");
  await expect(thermalPane()).toBeVisible();
  await expect(thermalPane().locator("h3").first()).toContainText(focused.trim());
  // Focus follows the view, or a keyboard reader is left on a hidden node.
  expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe(
    "region"
  );

  await page.goBack();
  await expect(census()).toBeVisible();
});

test("wide: the thermals census and its detail sit side by side", async () => {
  await openSection("thermals");
  await setViewport(1600, 1000);

  // Both halves on screen, the detail to the right of the census — and the
  // census's row lit, which needs the query seeded now that the selection
  // lives there.
  await expect(census()).toBeVisible();
  await expect(thermalPane()).toBeVisible();
  await expect.poll(() => thermalParam()).toBeTruthy();
  await expect(census().locator("tbody tr[aria-selected='true']")).toHaveCount(1);

  const table = (await census().boundingBox())!;
  const pane = (await thermalPane().boundingBox())!;
  expect(pane.x).toBeGreaterThan(table.x + table.width - 1);

  // Side by side nothing navigates: both halves are already on screen, so a
  // pick may not cost the reader a Back press to leave the page.
  const rows = census().locator("tbody tr");
  const other = rows.nth((await rows.count()) - 1);
  const start = (await other.locator("th, td").first().innerText()).trim();
  const entries = await page.evaluate(() => history.length);
  await other.locator("th, td").first().click();
  await expect(thermalPane().locator("h3").first()).toContainText(start);
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test("the map's maximise control fills the screen, and the same control restores it", async () => {
  await openSection("thermals");
  await setViewport(390, 780);
  const thermalsCard = page.locator("section", {
    has: page.getByRole("heading", { name: THERMALS_HEADING }),
  });
  await thermalsCard.scrollIntoViewIfNeeded();
  // Stacked, the rose is on the DETAIL view — so get to it. (The wide test
  // above may have left a thermal chosen, in which case it already is.)
  if (await census().isVisible()) await chooseFirstThermal();
  await expect(thermalPane()).toBeVisible();
  // The map (and its corner controls) only exist with a Mapbox token.
  const mapToggle = thermalsCard.getByRole("button", { name: "Map", exact: true });
  test.skip((await mapToggle.count()) === 0, "no Mapbox token in this environment");
  await mapToggle.click();
  await thermalsCard.getByRole("button", { name: "Maximise map" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  // The rose itself is in the sheet, and Close has focus so Escape is not
  // the only way out (accessibility standard §4.1).
  await expect(dialog.getByRole("img", { name: /Top-down lift rose/ })).toBeVisible();
  await expect(page.locator(":focus")).toHaveText("Close");

  // The SAME control, in the same corner of the map, brings it back.
  await dialog.getByRole("button", { name: "Restore map size" }).click();
  await expect(dialog).toHaveCount(0);

  // Serial suite: leave the page as found — fold the map away again.
  await mapToggle.click();
});

test("the pilot picker pins a highlight page-wide, through the URL", async () => {
  await openSection("metrics");
  await setViewport(1600, 1000);

  // A real pilot from this report, read off the first open family's table.
  // Second cell: the first is the rank.
  const firstRow = openFamilyTable().locator("tbody tr").first();
  await firstRow.scrollIntoViewIfNeeded();
  const name = (await firstRow.locator("th, td").nth(1).innerText()).trim();
  expect(name).toBeTruthy();

  // Pick them. The pin lands in the URL (a shareable reading of the task)
  // and their row tints without any hover.
  const box = page.getByRole("combobox", { name: "Highlight a pilot" });
  await box.click();
  await box.fill(name.slice(0, Math.min(6, name.length)));
  await page.getByRole("option", { name }).click();
  await expect(page).toHaveURL(/[?&]pilot=/);
  await page.mouse.move(5, 5); // no hover in play — the tint below is the pin
  await expect(firstRow).toHaveClass(/bg-accent/);

  // A fresh load of the pinned URL restores pick and tint (the shared link).
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFamilyTable().waitFor();
  await expect(page.getByRole("combobox", { name: "Highlight a pilot" })).toHaveValue(name);
  const reloadedRow = openFamilyTable().locator("tbody tr").first();
  await reloadedRow.scrollIntoViewIfNeeded();
  await expect(reloadedRow).toHaveClass(/bg-accent/);

  // ✕ clears pin, URL and tint — leave the page as found (serial suite).
  await page.getByRole("button", { name: `Stop highlighting ${name}` }).click();
  await expect(page).not.toHaveURL(/[?&]pilot=/);
  await expect(reloadedRow).not.toHaveClass(/bg-accent/);
});
