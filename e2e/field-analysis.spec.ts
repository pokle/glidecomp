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

test.beforeAll(async ({ playwright }) => {
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
});

/** Open the report and wait for the ranking — not for the network to go idle. */
async function openRanking(page: Page) {
  await page.goto(analysisPath, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();
  const table = page.getByRole("grid", { name: "Behaviour ranking" });
  await table.waitFor();
  return table;
}

/** The selected-metric pane: the only labelled region holding the scatter. */
function detailPane(page: Page) {
  return page.locator('[role="region"][aria-labelledby]').filter({ has: page.locator("svg") }).first();
}

test("picking a row swaps the chart, and the top metric is charted first", async ({ page }) => {
  const table = await openRanking(page);
  const pane = detailPane(page);

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

test("wide: the chart sits beside the table, and the table still fits", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const table = await openRanking(page);
  const pane = detailPane(page);

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

test("narrow: the chart pins to the top while the table scrolls under it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await openRanking(page);
  const pane = detailPane(page);

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

test("narrow: keyboard focus never lands behind the pinned chart", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  const table = await openRanking(page);
  const rows = table.locator("tbody tr");

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

test("narrow: the chart can be folded away to read the table", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await openRanking(page);
  const pane = detailPane(page);
  const toggle = page.getByRole("button", { name: /chart$/ });

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(pane).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(pane).toBeHidden();

  await toggle.click();
  await expect(pane).toBeVisible();
});
