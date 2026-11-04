/**
 * Creating a task is a PAGE, not a dialog over the comp (issue #819): the
 * overlays rule in CLAUDE.md, for the same reason the pilot editor became one.
 *
 * What this spec pins:
 * - the page has its own URL (/comp/:id/task/new), and a reload stands on it;
 * - the browser's Back leaves it, back to the comp;
 * - Create goes to the task it made, and REPLACES the form in the history, so
 *   Back from the new task is the comp — not a filled-in form whose second
 *   Create would make the task twice;
 * - the form is the kit `Form`: its own checks and the server's refusals land
 *   under the field they are about;
 * - a hidden comp's share key rides along in the link and to the new task;
 * - a signed-in visitor who is not an organiser gets a notice, not the form.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts): a form with a text
 * field is exactly what the overlays rule moved off a phone's dialog.
 */
import { test, expect, type Page } from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { FRONTEND_URL, e2eCompName } from "./fixtures/stack";
import { idFromSegment } from "../web/frontend/src/react/lib/slug";

const ADMIN_USER = { name: "New Task Fixture", email: "new-task@test.local" };
const VISITOR_USER = { name: "New Task Visitor", email: "new-task-visitor@test.local" };
const COMP_NAME = e2eCompName("New Task Page");

/** Every comp this file made, deleted afterwards. */
const made: string[] = [];

async function signIn(page: Page, user: { name: string; email: string }): Promise<void> {
  const login = await page.request.post("/api/auth/dev-login", { data: user });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
}

/** A fresh comp with two classes; public unless `hidden`. Returns its id. */
async function makeComp(page: Page, { hidden = false } = {}): Promise<string> {
  const res = await page.request.post("/api/comp", {
    data: { name: COMP_NAME, category: "hg", pilot_classes: ["open", "sport"], test: hidden },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const compId = ((await res.json()) as { comp_id: string }).comp_id;
  made.push(compId);
  return compId;
}

async function tasksOf(page: Page, compId: string) {
  const res = await page.request.get(`/api/comp/${compId}`);
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { tasks: Array<{ task_id: string; name: string; pilot_classes: string[] }> })
    .tasks;
}

/** On the comp page, the comp's own address, not one under it. */
async function onCompPage(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/comp\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: COMP_NAME })).toBeVisible();
}

/** On the new-task page, once its form is there. */
async function onNewTaskPage(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/comp\/[^/]+\/task\/new$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Create task" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("textbox", { name: "Name" })).toBeVisible();
}

async function openFromComp(page: Page, compId: string): Promise<void> {
  await page.goto(`/comp/${compId}`);
  await onCompPage(page);
  // The Tasks section's header link; an empty comp also has one in the body.
  await page.locator("#tasks").getByRole("link", { name: "New task", exact: true }).first().click();
  await onNewTaskPage(page);
}

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  for (const compId of made) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test("New task is a page: its own URL, a reload stands on it, and Back leaves it", async ({
  page,
}) => {
  await signIn(page, ADMIN_USER);
  const compId = await makeComp(page);
  await openFromComp(page, compId);

  // A dialog would have left the address bar on the comp. The page has its
  // own, under the comp's slug.
  expect(idFromSegment(new URL(page.url()).pathname.split("/")[2])).toBe(compId);
  // Nothing on it scrolls sideways — the reason a phone needed a page.
  await expectNoSidewaysScroll(page);

  // It stands on its own: reloaded, it is the same page, not a 404 or the comp.
  await page.reload();
  await onNewTaskPage(page);

  // Back is the browser's own, and leaves without making anything.
  await page.getByRole("textbox", { name: "Name" }).fill("Never made");
  await page.goBack();
  await onCompPage(page);
  expect(await tasksOf(page, compId)).toHaveLength(0);
  // And Forward comes back to it.
  await page.goForward();
  await onNewTaskPage(page);
});

test("Create goes to the task it made, and Back from there is the comp", async ({ page }) => {
  await signIn(page, ADMIN_USER);
  const compId = await makeComp(page);
  await openFromComp(page, compId);

  // Both classes are ticked to begin with; this task is for one of them.
  await page.getByRole("main").getByText("sport", { exact: true }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Day 1 Ridge Run");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page).toHaveURL(/\/task\/day-1-ridge-run-[a-z]+$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Day 1 Ridge Run" })).toBeVisible();
  const tasks = await tasksOf(page, compId);
  expect(tasks.map((t) => t.name)).toEqual(["Day 1 Ridge Run"]);
  expect(tasks[0].pilot_classes).toEqual(["open"]);
  expect(page.url()).toContain(tasks[0].task_id);

  // The form was replaced by the task: Back skips it, to the comp, which
  // lists the task it did not have when the reader left it.
  await page.goBack();
  await onCompPage(page);
  await expect(page.locator("#tasks").getByRole("link", { name: /Day 1 Ridge Run/ })).toBeVisible();
});

test("a refusal lands under the field it is about", async ({ page }) => {
  await signIn(page, ADMIN_USER);
  const compId = await makeComp(page);
  await openFromComp(page, compId);
  const name = page.getByRole("textbox", { name: "Name" });

  // The form's own checks, before anything is sent.
  await page.getByRole("main").getByText("open", { exact: true }).click();
  await page.getByRole("main").getByText("sport", { exact: true }).click();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expect(page.getByRole("main")).toContainText("Enter a task name");
  await expect(page.getByRole("main")).toContainText("Select at least one pilot class");
  await expect(page).toHaveURL(/\/task\/new$/);

  // The server's refusal, under the field it names (`{ error, field }`).
  await page.getByRole("main").getByText("open", { exact: true }).click();
  await name.fill("Day <1>");
  await expect(page.getByRole("main")).not.toContainText("Enter a task name");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("main")).toContainText("must not contain < or >");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport();
  // Nothing is lost: what was typed is still there to correct.
  await expect(name).toHaveValue("Day <1>");
  expect(await tasksOf(page, compId)).toHaveLength(0);

  // Corrected, it is made.
  await name.fill("Day 1");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Day 1" })).toBeVisible({
    timeout: 20_000,
  });
});

test("a hidden comp's share key rides along to the new task", async ({ page }) => {
  await signIn(page, ADMIN_USER);
  const compId = await makeComp(page, { hidden: true });
  await page.goto(`/comp/${compId}`);
  // The organiser's address bar settles on the keyed URL.
  await expect.poll(() => idFromSegment(new URL(page.url()).pathname.split("/")[2])).toMatch(
    new RegExp(`^${compId}_[a-z0-9]{12}$`)
  );
  const keyed = idFromSegment(new URL(page.url()).pathname.split("/")[2]);

  const link = page.locator("#tasks").getByRole("link", { name: "New task", exact: true }).first();
  await expect(link).toHaveAttribute("href", new RegExp(`${keyed}/task/new$`));
  await link.click();
  await onNewTaskPage(page);
  expect(page.url()).toContain(keyed);

  await page.getByRole("textbox", { name: "Name" }).fill("Draft day");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Draft day" })).toBeVisible({
    timeout: 20_000,
  });
  expect(page.url()).toContain(`${keyed}/task/draft-day-`);
});

test("a signed-in visitor who is not an organiser is sent to the competition, not the form", async ({
  page,
}) => {
  await signIn(page, ADMIN_USER);
  const compId = await makeComp(page);
  await page.context().clearCookies();
  await signIn(page, VISITOR_USER);

  await page.goto(`/comp/${compId}/task/new`);
  await expect(page.getByText("That page is for the competition’s organisers.")).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/task\/new/);
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  // And the comp page offers them no way here.
  await page.goto(`/comp/${compId}`);
  await onCompPage(page);
  await expect(page.getByRole("link", { name: "New task", exact: true })).toHaveCount(0);
});
