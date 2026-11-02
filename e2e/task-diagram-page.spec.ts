/**
 * The task's route at full size — a page under the task (issue #814), where
 * it was a full-screen overlay over the competition page. Part of the "No
 * full-screen overlays" rule in CLAUDE.md: a figure at full size is a page,
 * with its own URL, left with the browser's Back.
 *
 * What this spec pins:
 * - the glyph beside a task on the competition page is a LINK to
 *   `/comp/:id/task/:id/diagram`, separate from the row's task link, so
 *   opening the diagram never takes the row's main action;
 * - Back from the page returns to the competition page at the scroll it was
 *   left at (lib/scroll-restoration.ts);
 * - a reload rebuilds the page from nothing — it fetches the task itself,
 *   where the overlay was handed the route in memory;
 * - a hidden comp's page opens for whoever holds its link, the key riding
 *   along into the page and its breadcrumbs, and is not found without it.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts): a full-screen
 * overlay on a phone is what the rule is about, and the glyph is a tap
 * target in a list read on a phone.
 *
 * The server-rendered side (the route in the first response, noindex, clean
 * hydration) is e2e/ssr.spec.ts's: this suite serves the SPA shell.
 *
 * Runs against its own comp (named through e2eCompName, so the pre-run sweep
 * catches strays). Every test reads it signed out.
 */
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "./fixtures/test";
import { e2eCompName, FRONTEND_URL } from "./fixtures/stack";

const ADMIN_USER = { name: "Task Diagram Fixture", email: "task-diagram@test.local" };
const COMP_NAME = e2eCompName("Task Diagram Page");
const TASK_NAME = "Task 4";
const XCTSK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4/task.xctsk"
);
// A few more days, so the task under test is not the only row in the list.
const EXTRA_DAYS = ["2020-12-08", "2020-12-09", "2020-12-10", "2020-12-11"];

// Serial: the last test hides the comp, which every earlier one reads public.
test.describe.configure({ mode: "serial" });

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
const diagramHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: `Route for ${TASK_NAME}` });
/** The drawing itself: an image named for the route it shows. */
const diagram = (page: Page) => page.getByRole("img", { name: /^Task route: ell094/ });
const glyph = (page: Page) =>
  page.getByRole("link", { name: `Show the route for ${TASK_NAME}` });
// Compared by ids, never as captured URLs: the page settles a bare-id URL on
// its canonical slug once the names load.
const diagramUrl = (id: string) =>
  new RegExp(`/comp/[^/]*${id}/task/[^/]*${taskId}/diagram$`);
const compUrl = (id: string) => new RegExp(`/comp/[^/]*${id}$`);

test("the glyph links to the page, and Back returns to the same scroll", async ({ page }) => {
  // A short screen, so the list runs past it at either project's width and
  // "the same scroll" is a real offset rather than 0.
  const width = page.viewportSize()?.width ?? 390;
  await page.setViewportSize({ width, height: 420 });
  await page.goto(`/comp/${compId}`);
  await expect(compHeading(page)).toBeVisible();

  const link = glyph(page);
  // Its own target, beside the row's task link rather than inside it: the
  // row's main action still goes to the task.
  await expect(link).toHaveAttribute("href", diagramUrl(compId));
  const taskLink = page.locator(`a[href$="-${taskId}"]`);
  await expect(taskLink).toHaveCount(1);
  await expect(taskLink).toContainText(TASK_NAME);
  // Measured, not asserted from classes: a frame around a 72×50 glyph.
  const box = await link.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  // Brought into view, which on this short screen means scrolled down.
  await link.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);

  await link.click();
  await expect(page).toHaveURL(diagramUrl(compId));
  await expect(diagramHeading(page)).toBeVisible();
  await expect(diagram(page)).toBeVisible();
  // A page, not an overlay over the competition page.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(compHeading(page)).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(compUrl(compId));
  await expect(compHeading(page)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThanOrEqual(scrolled - 2);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(scrolled + 2);
});

test("a reload keeps the page, and Back still leaves it", async ({ page }) => {
  await page.goto(`/comp/${compId}`);
  await expect(compHeading(page)).toBeVisible();
  await glyph(page).click();
  await expect(diagramHeading(page)).toBeVisible();

  // A reload has no competition page underneath it: the page fetches the
  // task and draws the route itself.
  await page.reload();
  await expect(page).toHaveURL(diagramUrl(compId));
  await expect(diagramHeading(page)).toBeVisible();
  await expect(diagram(page)).toBeVisible();
  // The trail names where it hangs: the task, then the competition.
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail.getByRole("link", { name: TASK_NAME, exact: true })).toHaveAttribute(
    "href",
    new RegExp(`/task/[^/]*${taskId}$`)
  );

  await page.goBack();
  await expect(page).toHaveURL(compUrl(compId));
  await expect(compHeading(page)).toBeVisible();
});

test("a hidden comp's page opens with its link, and not without it", async ({
  page,
  playwright,
}) => {
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  const hide = await api.patch(`/api/comp/${compId}`, { data: { test: true } });
  expect(hide.ok(), await hide.text()).toBe(true);
  const { share_key } = (await (await api.get(`/api/comp/${compId}`)).json()) as {
    share_key: string | null;
  };
  await api.dispose();
  expect(share_key).toBeTruthy();
  const keyed = `${compId}_${share_key}`;

  // The id alone: not found, naming nothing.
  await page.goto(`/comp/${compId}/task/${taskId}/diagram`);
  await expect(page.getByRole("heading", { level: 1, name: "Task not found" })).toBeVisible();
  await expect(page.getByText(COMP_NAME)).toHaveCount(0);

  // With the link: from the competition page, the key rides into the
  // diagram's URL and on into its trail.
  await page.goto(`/comp/${keyed}`);
  await expect(compHeading(page)).toBeVisible();
  await expect(glyph(page)).toHaveAttribute("href", diagramUrl(keyed));
  await glyph(page).click();
  await expect(page).toHaveURL(diagramUrl(keyed));
  await expect(diagram(page)).toBeVisible();
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
    name: TASK_NAME,
    exact: true,
  });
  await expect(crumb).toHaveAttribute("href", new RegExp(`${keyed}/task/`));
});
