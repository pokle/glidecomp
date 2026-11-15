/**
 * The comp page's task list, and coming Back to it.
 *
 * What this spec pins:
 * - a task's row opens the task, and Back returns to the competition page at
 *   the scroll it was left at (lib/scroll-restoration.ts), although the
 *   scores above the list load again and land late (#846);
 * - the route diagram's old URL goes to the task page. The diagram had a
 *   page of its own for two weeks of November 2026 (#814), opened from a
 *   glyph beside each task; the glyph is now the row's picture
 *   (e2e/comp-detail.spec.ts measures the row), and the task page draws the
 *   same route.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts): a list read on a
 * phone runs well past the fold, which is where "the same scroll" matters.
 *
 * The server's redirect for the old URL is e2e/ssr.spec.ts's: this suite
 * serves the SPA shell.
 *
 * Runs against its own comp (named through e2eCompName, so the pre-run sweep
 * catches strays). Every test reads it signed out.
 */
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "./fixtures/test";
import { e2eCompName, FRONTEND_URL } from "./fixtures/stack";

const ADMIN_USER = { name: "Tasks List Fixture", email: "comp-tasks-list@test.local" };
const COMP_NAME = e2eCompName("Comp Tasks List");
const TASK_NAME = "Task 4";
const XCTSK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4/task.xctsk"
);
// A few more days, so the task under test is not the only row in the list.
const EXTRA_DAYS = ["2020-12-08", "2020-12-09", "2020-12-10", "2020-12-11"];


let compId: string;
let taskId: string;

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const login = await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  expect(login.ok(), await login.text()).toBe(true);

  const created = await api.post("/api/comp", {
    data: { name: COMP_NAME, category: "hg", pilot_classes: ["open"], test: false },
  });
  expect(created.ok(), await created.text()).toBe(true);
  compId = ((await created.json()) as { comp_id: string }).comp_id;

  const xctsk = JSON.parse(await readFile(XCTSK, "utf8")) as unknown;
  for (const [i, date] of EXTRA_DAYS.entries()) {
    const res = await api.post(`/api/comp/${compId}/task`, {
      data: { name: `Task ${i}`, task_date: date, pilot_classes: ["open"], xctsk },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  // The OLDEST day, so it sits at the bottom of the newest-first list.
  const task = await api.post(`/api/comp/${compId}/task`, {
    data: { name: TASK_NAME, task_date: "2020-12-01", pilot_classes: ["open"], xctsk },
  });
  expect(task.ok(), await task.text()).toBe(true);
  taskId = ((await task.json()) as { task_id: string }).task_id;
  await api.dispose();
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

const compHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: COMP_NAME });
/** The task's row on the competition page: one link, the whole row. */
const taskRow = (page: Page) => page.locator(`#tasks a[href$="-${taskId}"]`);
const taskHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: TASK_NAME, exact: true });
// Compared by ids, never as captured URLs: the page settles a bare-id URL on
// its canonical slug once the names load.
const compUrl = (id: string) => new RegExp(`/comp/[^/]*${id}$`);

test("Back from a task's row returns the list to the same scroll", async ({ page }) => {
  // A short screen, so the list runs past it at either project's width and
  // "the same scroll" is a real offset rather than 0.
  const width = page.viewportSize()?.width ?? 390;
  await page.setViewportSize({ width, height: 420 });
  await page.goto(`/comp/${compId}`);
  await expect(compHeading(page)).toBeVisible();

  const link = taskRow(page);
  await expect(link).toHaveCount(1);
  await expect(link).toContainText(TASK_NAME);

  // Brought into view, which on this short screen means scrolled down. Once
  // the scores above the list have loaded, so their height is settled. (Not
  // "networkidle": the scores' freshness poll keeps the network busy.)
  await expect(page.getByText("Loading scores…")).toHaveCount(0);
  await link.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  const leftAt = (await link.boundingBox())!.y;

  // On the way back the scores load again, above the list. The offset is
  // restored as soon as the page is tall enough (lib/scroll-restoration.ts),
  // which can be before they land: "Loading scores…" is a line shorter than
  // what replaces it. The restore then holds the offset while they do —
  // before #846 the browser's scroll anchoring kept the screen where the
  // restore had put it instead, a line or more off where the reader left.
  // CI's runners land either side of that race, so it is made to happen
  // every time.
  await page.route("**/api/comp/*/scores", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });

  await link.click();
  await expect(page).toHaveURL(new RegExp(`/task/[^/]*${taskId}$`));
  await expect(taskHeading(page)).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(compUrl(compId));
  await expect(compHeading(page)).toBeVisible();
  await expect(page.getByText("Loading scores…")).toHaveCount(0);
  // Where it was left, to within a few pixels: the row at the same height
  // on the screen, and the page scrolled as far — and still so once anything
  // else that settles late has landed (#846). The tolerance was 150 px while
  // the late scores could push the reader off (22 to 74 px seen in CI).
  const rowOffBy = async () => Math.abs((await link.boundingBox())!.y - leftAt);
  const scrollOffBy = async () =>
    Math.abs((await page.evaluate(() => window.scrollY)) - scrolled);
  await expect.poll(rowOffBy).toBeLessThanOrEqual(3);
  await page.waitForTimeout(1000);
  expect(await rowOffBy()).toBeLessThanOrEqual(3);
  expect(await scrollOffBy()).toBeLessThanOrEqual(3);
});

test("the route diagram's old URL opens the task page", async ({ page }) => {
  await page.goto(`/comp/${compId}/task/${taskId}/diagram`);
  await expect(page).toHaveURL(new RegExp(`/task/[^/]*${taskId}$`));
  await expect(taskHeading(page)).toBeVisible();
  // The route is on the task page, named for what it shows.
  await expect(page.getByRole("img", { name: /^Task route: / })).toBeVisible();
});
