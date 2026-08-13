/**
 * Task field analysis (/comp/:id/analysis/task/:id) — the separation
 * ranking's master/detail behaviour (issue #455).
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
 * Gotcha honoured here: never wait on "networkidle". A field-analysis page
 * keeps a freshness poll in flight by design, so it never settles — wait on
 * role locators.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";
const RANKING_HEADING = /Which behaviours went with better ranks/;

let analysisPath: string;

// ONE page load for the whole file. Every test here asserts CSS/ARIA
// behaviour of an already-rendered report, and this is the heaviest page in
// the app — loading it per test made this spec 76s of the E2E suite's 178s
// (43%), eight loads' worth. So the tests share a single page and only ever
// change the viewport, which the layout is built to respond to live (a
// container query plus a ResizeObserver): resizing exercises the same code
// path a reload would, without paying for the report again.
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
  // Seeding plus the cold field-analysis compute can both take a while.
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
  analysisPath = `/comp/${compId}/analysis/task/${taskId}`;

  // Field analysis never computes on the read path — a cold report answers
  // "pending" and schedules the work. Poll it warm here so the UI tests get a
  // ranking table instead of the pending notice.
  const reportUrl = `/api/comp/${compId}/task/${taskId}/field-analysis`;
  for (let i = 0; i < 60; i++) {
    const res = await api.get(reportUrl);
    if (res.ok()) {
      const body = (await res.json()) as { pending?: boolean };
      if (!body.pending) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  await api.dispose();

  // The one load. Wait on the ranking — never on the network going idle: a
  // field-analysis page keeps a freshness poll in flight by design.
  page = await browser.newPage();
  await page.goto(analysisPath, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();
  await ranking().waitFor();
});

test.afterAll(async () => {
  await page?.close();
});

test.beforeEach(async () => {
  // Tests that scroll leave the page scrolled. Reset it; every other reset
  // (viewport, selection, the fold toggle) is done by the test that needs it.
  await page.evaluate(() => window.scrollTo(0, 0));
});

/** The ranking table. */
function ranking() {
  return page.getByRole("grid", { name: "Behaviour ranking" });
}

/** The ranking pane's Expand button. Scoped to the ranking's card: the
 * thermals figure above carries its own full-screen Expand now, so a bare
 * `.first()` would land there. */
function rankingExpand() {
  return page
    .locator("section", { has: page.getByRole("heading", { name: RANKING_HEADING }) })
    .getByRole("button", { name: /full screen$/ })
    .first();
}

/** The selected-metric pane. Scoped to the ranking's own card — the thermals
 * section above it is a MasterDetail too now, with a pane of the same shape. */
function detailPane() {
  return page
    .locator("section", { has: page.getByRole("heading", { name: RANKING_HEADING }) })
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
  // …and it sits fully on screen, below PageToc's fixed 60px bar.
  expect(stillStuck.y).toBeGreaterThanOrEqual(59);
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

  // Past the last row, the pane releases and scrolls away with its section.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const released = (await pane.boundingBox())!;
  expect(released.y + released.height).toBeLessThan(0);
});

test("narrow: picking a bottom row swaps a chart that is on screen", async () => {
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

test("narrow: the thermals census drives its own pinned pane", async () => {
  await setViewport(390, 780);
  const census = page.getByRole("grid", { name: "Reconstructed thermals" });
  await census.scrollIntoViewIfNeeded();
  const pane = page
    .locator("section", { has: page.getByRole("heading", { name: /The day's thermals/ }) })
    .locator('[role="region"][aria-labelledby]')
    .first();

  // The census opens on the ten most-shared thermals; the last stored one is
  // behind "Show all N". Expand first, so the test keeps meaning what it
  // says: selecting the LAST thermal swaps a pane that is on screen.
  const showAll = census
    .locator("..")
    .getByRole("button", { name: /^Show all \d+$/ });
  if ((await showAll.count()) > 0) await showAll.click();

  // Selecting the LAST thermal must swap a pane that is on screen — the same
  // contract as the ranking's chart, via the same shared MasterDetail.
  const rows = census.locator("tbody tr");
  const last = rows.nth((await rows.count()) - 1);
  const start = (await last.locator("th, td").first().innerText()).trim();
  await last.locator("th, td").first().click();
  await expect(pane.locator("h3").first()).toContainText(start);
  const box = (await pane.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(781);
});

test("the map's maximise control fills the screen, and the same control restores it", async () => {
  await setViewport(390, 780);
  const thermalsCard = page.locator("section", {
    has: page.getByRole("heading", { name: /The day's thermals/ }),
  });
  await thermalsCard.scrollIntoViewIfNeeded();
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

test("narrow: the chart can be folded away to read the table", async () => {
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
