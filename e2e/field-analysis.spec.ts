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
 *   3. narrow → the pane stays on screen while the table scrolls under it,
 *      and keyboard focus never lands behind it (WCAG 2.4.11).
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
import { test, expect, type Page } from "@playwright/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";
const RANKING_HEADING = /Which behaviours went with better results/;

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
  // Tests that scroll leave the page scrolled; every other reset (viewport,
  // selection, the fold toggle) is done by the test that needs it.
  await page.evaluate(() => window.scrollTo(0, 0));
});

/** The ranking table. */
function ranking() {
  return page.getByRole("grid", { name: "Behaviour ranking" });
}

/** The selected-metric pane: the only labelled region holding the scatter. */
function detailPane() {
  return page.locator('[role="region"][aria-labelledby]').filter({ has: page.locator("svg") }).first();
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
  const pane = detailPane();

  await pane.scrollIntoViewIfNeeded();
  const before = (await pane.boundingBox())!;
  await page.evaluate(() => window.scrollBy(0, 800));
  const after = (await pane.boundingBox())!;

  // Still on screen after scrolling a long way down the table.
  expect(after.y).toBeLessThan(780);
  expect(after.y + after.height).toBeGreaterThan(0);
  // And pinned, not merely tall: it moved up relative to the document.
  expect(after.y).toBeLessThanOrEqual(before.y + 1);
});

test("narrow: keyboard focus never lands behind the pinned chart", async () => {
  await setViewport(390, 780);
  const rows = ranking().locator("tbody tr");

  // Start low and walk UP — the direction that drives a focused row under a
  // pane pinned to the top of the viewport.
  await rows.nth(Math.min(16, (await rows.count()) - 1)).click();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowUp");
    const obscured = await page.evaluate(() => {
      const el = (document.activeElement as HTMLElement).closest("tr");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const p = document
        .querySelector('[role="region"][aria-labelledby]')!
        .getBoundingClientRect();
      return r.top < p.bottom && r.bottom > p.top;
    });
    expect(obscured).toBe(false);
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
    await page.getByRole("button", { name: /full screen$/ }).first().click();

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

  const trigger = page.getByRole("button", { name: /full screen$/ }).first();
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
