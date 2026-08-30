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
 * The ranking table and the chart of the row you pick are one pair now: the
 * chart pins to the top of the viewport on a narrow screen and sits beside
 * the table on a wide one, so choosing a row never means scrolling away from
 * the table to see the result. These tests pin the three properties that make
 * that true, because all three are pure CSS (a container query, `position:
 * sticky`, `order`) and a stray utility class can undo any of them without
 * failing a type check or a unit test:
 *
 *   1. picking a row swaps the pane's heading,
 *   2. wide → the pane is to the RIGHT of the table and vertically level with
 *      it, and the table has NOT gone back to scrolling sideways,
 *   3. narrow → the pane pins to the top of the viewport while the table
 *      pages under it (releasing with the last row), lower rows still chart
 *      on screen, its buttons still take clicks while stuck, and keyboard
 *      focus never lands behind it (WCAG 2.4.11).
 *
 * The THERMALS census is the same component in its other mode: its detail is
 * a page in its own right, so stacked it replaces the census rather than
 * pinning above it, and the selection lives in `?thermal=` so the browser's
 * Back is the way out. Its tests assert the pair of properties that mode adds
 * — one half on screen at a time (a container query again), and a push
 * history entry stacked against a plain replace side by side.
 *
 * A second group covers the full-screen overlay (MetricChartOverlay): the
 * pinned chart is only a few hundred pixels on a phone, so "Expand" is what
 * makes it readable, and the assertion that matters is that the chart really
 * does get bigger — the plot scales to its CSS width, so a full-screen sheet
 * that did not also grow the viewBox would render the same size in portrait
 * and the feature would be a no-op.
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
  await fourth.click();

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

  // The split must not have squeezed the ranking back into a sideways
  // scroll — that regression is what issue #453 was closed on.
  const overflow = await table.evaluate((el) => {
    const wrapper = el.parentElement!;
    return wrapper.scrollWidth - wrapper.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});

test("narrow: the chart pins to the top while the table scrolls under it", async () => {
  await openSection("strategies");
  await setViewport(390, 780);
  const table = ranking();
  const pane = detailPane();

  // Scroll the WINDOW well into the ranking — the natural gesture, and the
  // one the previous layout (a capped table box, chart in normal flow)
  // answered by letting the chart leave with the page.
  await table.evaluate((el) => {
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY);
  });
  const stuck = (await pane.boundingBox())!;

  await page.evaluate(() => window.scrollBy(0, 250));
  const stillStuck = (await pane.boundingBox())!;
  // Pinned: 250px of page scroll did not move the pane…
  expect(Math.abs(stillStuck.y - stuck.y)).toBeLessThanOrEqual(1);
  // …and it sits fully on screen. Flush to the top here: the Shell's header
  // is static under `sm`, so on a phone nothing is above the pane to clear.
  expect(stillStuck.y).toBeGreaterThanOrEqual(0);
  expect(stillStuck.y + stillStuck.height).toBeLessThanOrEqual(781);

  // While stuck, its buttons must still take clicks — the Chromium
  // hit-testing failure that sank the previous pinned design (#553) was
  // Expand silently ignoring clicks once an ancestor had horizontal padding,
  // and the pane now lives inside the section's padded panel.
  await rankingExpand().click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Past the last row the pane releases: it stops holding the top of the
  // viewport and stays inside its own section. It used to scroll clean off
  // the top, but only because a long report followed it — the ranking is
  // nearly the whole page now that each section has its own, so what is left
  // to observe is that the pane is bounded by its section and not by the
  // viewport.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const released = (await pane.boundingBox())!;
  const card = (await rankingCard().boundingBox())!;
  expect(released.y + released.height).toBeLessThanOrEqual(card.y + card.height + 1);
});

test("narrow: picking a bottom row swaps a chart that is on screen", async () => {
  await openSection("strategies");
  await setViewport(390, 780);
  const table = ranking();
  const pane = detailPane();
  const rows = table.locator("tbody tr");
  const last = rows.nth((await rows.count()) - 1);
  const lastName = (await last.locator("th, td").first().innerText())
    .split("\n")[0]
    .trim();

  // The FIRST cell, not the row: a row's middle holds the ⓘ that opens the
  // method popover. Playwright scrolls the row into view first, which the
  // table's scroll-margin places below the pinned pane.
  await last.locator("th, td").first().click();

  // The complaint that repinned the pane: a low row used to swap a chart
  // that had long scrolled off the top. Now the chart is right there…
  await expect(pane.locator("h3").first()).toHaveText(lastName);
  const paneBox = (await pane.boundingBox())!;
  expect(paneBox.y).toBeGreaterThanOrEqual(0);
  expect(paneBox.y + paneBox.height).toBeLessThanOrEqual(781);
  // …and the row it charts is itself visible below it, not behind it.
  const rowBox = (await last.boundingBox())!;
  expect(rowBox.y).toBeGreaterThanOrEqual(paneBox.y + paneBox.height - 1);
});

test("narrow: a keyboard-focused row is never hidden by the pinned chart", async () => {
  await openSection("strategies");
  await setViewport(390, 780);
  const rows = ranking().locator("tbody tr");

  // Start low and walk UP — the direction that drives a focused row toward
  // the pane pinned at the top of the viewport. The table's scroll-margin
  // constants exist exactly so each step stops the row BELOW the pane
  // (WCAG 2.4.11): assert it never lands behind the chart or off screen.
  // The FIRST cell, not the row: a row's middle holds the ⓘ that opens the
  // method popover, and clicking that focuses a dialog instead of the row.
  await rows
    .nth(Math.min(16, (await rows.count()) - 1))
    .locator("th, td")
    .first()
    .click();
  // The walk below is only meaningful from a focused row.
  expect(
    await page.evaluate(() => Boolean((document.activeElement as HTMLElement)?.closest("tr")))
  ).toBe(true);
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowUp");
    const hidden = await page.evaluate(() => {
      const row = (document.activeElement as HTMLElement).closest("tr");
      if (!row) return null;
      const r = row.getBoundingClientRect();
      // Scoped to the ranking's card: the thermals pane above matches the
      // bare selector too.
      const chart = document
        .querySelector('[aria-labelledby="separation-heading"] [role="region"][aria-labelledby]')!
        .getBoundingClientRect();
      return {
        offViewport: r.bottom < 0 || r.top > window.innerHeight,
        behindChart: r.top < chart.bottom && r.bottom > chart.top,
      };
    });
    expect(hidden).not.toBeNull();
    expect(hidden!.offViewport, "focused row scrolled off the viewport").toBe(false);
    expect(hidden!.behindChart, "focused row overlaps the chart").toBe(false);
  }
});

test("expanding the chart makes it very much bigger, in both orientations", async () => {
  await openSection("strategies");
  for (const [label, width, height] of [
    ["portrait", 390, 780],
    ["landscape", 780, 390],
  ] as const) {
    // The inline plot is re-measured after each resize, so both orientations
    // compare like with like without reloading between them.
    await setViewport(width, height);

    const inline = (await page.locator('svg[role="group"]').first().boundingBox())!;
    await rankingExpand().click();

    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    // One frame for the ResizeObserver to report the sheet's box.
    await page.waitForTimeout(400);
    const expanded = (await dialog.locator('svg[role="group"]').boundingBox())!;

    // Not a token increase: the plot is drawn on a fixed-width viewBox, so
    // filling the sheet has to grow the viewBox too or portrait gets the same
    // strip it already had.
    const growth = (expanded.width * expanded.height) / (inline.width * inline.height);
    expect(growth, `${label} should be a real expansion`).toBeGreaterThan(1.8);
    expect(expanded.width).toBeGreaterThanOrEqual(inline.width);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
});

test("the expanded chart stays open when you tap a dot, and returns focus on close", async () => {
  await openSection("strategies");
  await setViewport(390, 780);

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

test("narrow: the chart can be folded away to read the table", async () => {
  await openSection("strategies");
  await setViewport(390, 780);
  const pane = detailPane();
  const toggle = page.getByRole("button", { name: /chart$/ });

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(pane).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(pane).toBeHidden();

  await toggle.click();
  await expect(pane).toBeVisible();
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
 * The thermals section is the one MasterDetail in `navigation` mode: its
 * detail is a page in its own right (rose, readouts, climb profile, two
 * tables), so stacked it does not pin above the census — it REPLACES it, and
 * the way back is the browser's own Back. That contract is what this asserts,
 * because every part of it is a class or a history call that nothing else
 * would catch: the hiding is a container query, the push is one boolean off a
 * ResizeObserver, and the selection lives in the URL.
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
