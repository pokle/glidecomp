/**
 * Create a test IGC — a page under the task (issue #822), where it was a
 * dialog over the task page. Part of the "No full-screen overlays" rule in
 * CLAUDE.md: a screen with text fields is a page, with its own URL, left with
 * the browser's Back.
 *
 * What this spec pins:
 * - the task page LINKS to `/comp/:id/task/:id/test-igc` rather than opening
 *   a dialog, and Back from there returns to the task page;
 * - a reload of the URL rebuilds the page from nothing — it fetches the task
 *   and its route itself, where the dialog was handed them in memory;
 * - Create makes the file and shows what it made (the engine's verdict and
 *   the Download button), focused, without leaving the page;
 * - the form is the kit form: a bad take-off time is refused under its field;
 * - a visitor gets the organisers-only notice;
 * - a hidden comp's share key rides along into the page and its breadcrumbs.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts): the reason this is a
 * page at all is what a dialog with text fields did on a phone.
 *
 * Runs against its own comp (named through e2eCompName, so the pre-run sweep
 * catches strays), dated the day the bundled Unungra route was flown.
 */
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "./fixtures/test";
import { e2eCompName, FRONTEND_URL } from "./fixtures/stack";

const ADMIN_USER = { name: "Test IGC Fixture", email: "test-igc@test.local" };
const VISITOR_USER = { name: "Test IGC Visitor", email: "test-igc-visitor@test.local" };
const COMP_NAME = e2eCompName("Test IGC Page");
const TASK_NAME = "Task 4";
const TASK_DATE = "2020-12-12";
const XCTSK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4/task.xctsk"
);

// Serial: the last test hides the comp, which every earlier one reads public.
test.describe.configure({ mode: "serial" });

let compId: string;
let taskId: string;

async function devLogin(page: Page, user: { name: string; email: string }) {
  const login = await page.request.post("/api/auth/dev-login", { data: user });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
}

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
  const task = await api.post(`/api/comp/${compId}/task`, {
    data: { name: TASK_NAME, task_date: TASK_DATE, pilot_classes: ["open"], xctsk },
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

const heading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Create a test IGC" });

test("the task page links to the page; Back leaves it and a reload keeps it", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}`);
  await expect(page.getByRole("heading", { level: 1, name: TASK_NAME })).toBeVisible();

  await page.getByRole("link", { name: "Create test IGC" }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${compId}/task/[^/]*${taskId}/test-igc$`));
  await expect(heading(page)).toBeVisible();
  // A page, not an overlay over the task page.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(`For ${TASK_NAME} on ${TASK_DATE}`)).toBeVisible();

  // A reload has no task page underneath it: the page fetches the route itself.
  await page.reload();
  await expect(heading(page)).toBeVisible();
  await expect(page.getByRole("slider")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Pilot name" })).toHaveValue("Test Pilot");

  // Back is the browser's, and it returns to the task page it was opened from.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/task/[^/]*${taskId}$`));
  await expect(page.getByRole("heading", { level: 1, name: TASK_NAME })).toBeVisible();
});

test("Create shows what it made, on the page, and offers the file", async ({ page }) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/test-igc`);
  await expect(heading(page)).toBeVisible();

  await page.getByRole("textbox", { name: "Pilot name" }).fill("Ada Forge");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  const verdict = page.getByRole("alert").filter({ hasText: "Created, and the engine accepts it" });
  await expect(verdict).toBeVisible();
  // Taken to what was made — below the fold on a phone.
  await expect(verdict).toBeFocused();
  await expect(verdict).toBeInViewport();
  await expect(page).toHaveURL(/\/test-igc$/);
  await expect(page.getByRole("button", { name: "Create again" })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .igc" }).click();
  expect((await download).suggestedFilename()).toMatch(/-ada-forge\.igc$/);
});

test("a bad take-off time is refused under its field", async ({ page }) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/test-igc`);
  const start = page.getByRole("textbox", { name: "Take off (local)" });
  await start.fill("25:00");
  await page.getByRole("button", { name: "Create", exact: true }).click();

  await expect(start).toHaveAttribute("aria-invalid", "true");
  await expect(start).toBeFocused();
  await expect(page.getByText("Use HH:MM")).toBeVisible();
  // Nothing was made.
  await expect(page.getByRole("button", { name: "Download .igc" })).toHaveCount(0);

  // Fixing it clears the error, and Create then works.
  await start.fill("12:30");
  await expect(page.getByText("Use HH:MM")).toHaveCount(0);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download .igc" })).toBeVisible();
});

test("a visitor gets the organisers-only notice", async ({ page }) => {
  await devLogin(page, VISITOR_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/test-igc`);
  await expect(
    page.getByText("Creating a test IGC is for the competition’s organisers.")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create", exact: true })).toHaveCount(0);

  // And the task page offers no link to it.
  await page.goto(`/comp/${compId}/task/${taskId}`);
  await expect(page.getByRole("heading", { level: 1, name: TASK_NAME })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create test IGC" })).toHaveCount(0);
});

test("a hidden comp's share key rides along into the page", async ({ page, playwright }) => {
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

  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${keyed}/task/${taskId}`);
  await expect(page.getByRole("heading", { level: 1, name: TASK_NAME })).toBeVisible();
  await page.getByRole("link", { name: "Create test IGC" }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${keyed}/task/[^/]*${taskId}/test-igc$`));
  await expect(heading(page)).toBeVisible();

  // The trail back to the task keeps the key too.
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
    name: TASK_NAME,
  });
  await expect(crumb).toHaveAttribute("href", new RegExp(`${keyed}/task/`));
});
