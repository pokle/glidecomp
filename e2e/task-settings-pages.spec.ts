/**
 * The routed task editors (issue #637) — the second half of the conversion
 * `comp-settings-pages.spec.ts` covers the first half of. What used to be the
 * Task Settings dialog, the weather-notes dialog and the route-editor dialog
 * are now `/comp/:c/task/:t/settings`, `…/settings/weather` and `…/route`.
 *
 * What this spec pins:
 * - the flat settings form and its NavList foot (Route, Weather notes, and
 *   Delete task as a destructive row) — the shape that deliberately differs
 *   from the competition's grouped index;
 * - that a save PATCHes ONLY the task's own fields;
 * - the pickers that came in with it: an in-flow calendar with no "Open
 *   calendar" trigger, and pilot classes as full-width rows rather than a
 *   16px checkbox beside a label;
 * - the weather-notes sub-page round trip, and that the task page links to it
 *   rather than opening a dialog;
 * - the route editor as a real route, with its unsaved-changes guard;
 * - non-admin fallback and the unknown-sub-page 404;
 * - the whole journey with no horizontal overflow, which is the point of the
 *   restructure.
 *
 * Runs against its own comp with a dedicated fixture admin (named through
 * e2eCompName so the pre-run sweep can catch strays), so nothing here touches
 * the seeded sample comp other specs read.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts), for the reason the
 * comp settings spec gives: these pages were built mobile-first, so a
 * desktop-only pass would exercise them at the one width they were not
 * designed for.
 */
import { test, expect, phoneOnly, type Page } from "./fixtures/test";
import { e2eCompName } from "./fixtures/stack";

const ADMIN_USER = {
  name: "Task Settings Fixture",
  email: "task-settings@test.local",
};
const VISITOR_USER = {
  name: "Task Settings Visitor",
  email: "task-settings-visitor@test.local",
};
const COMP_NAME = e2eCompName("Task Settings Pages");
const TASK_NAME = "Day 1 Ridge Run";

let compId: string;
let taskId: string;

function baseUrl(): string {
  return process.env.DEV_FRONTEND_PORT
    ? `http://localhost:${process.env.DEV_FRONTEND_PORT}`
    : "http://localhost:3000";
}

async function devLogin(page: Page, user: { name: string; email: string }) {
  const login = await page.request.post("/api/auth/dev-login", { data: user });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login
    .headers()
    ["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      {
        name: "better-auth.session_token",
        value: token[1],
        domain: "localhost",
        path: "/",
      },
    ]);
  }
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  const login = await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  expect(login.ok(), await login.text()).toBe(true);

  const created = await api.post("/api/comp", {
    data: {
      name: COMP_NAME,
      category: "hg",
      // Two classes, so the CheckList has something to be a list OF.
      pilot_classes: ["open", "sport"],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  compId = ((await created.json()) as { comp_id: string }).comp_id;

  const task = await api.post(`/api/comp/${compId}/task`, {
    data: {
      name: TASK_NAME,
      task_date: new Date().toISOString().slice(0, 10),
      pilot_classes: ["open", "sport"],
    },
  });
  expect(task.ok(), await task.text()).toBe(true);
  taskId = ((await task.json()) as { task_id: string }).task_id;
  await api.dispose();
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test("a visitor gets the admin-only notice, and an unknown sub-page 404s", async ({
  page,
}) => {
  // Before any admin test reshapes the task: a signed-in non-admin reaches the
  // URL but not the settings.
  await devLogin(page, VISITOR_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/settings`);
  await expect(
    page.getByText("Task settings are for competition admins.")
  ).toBeVisible();

  // An unknown sub-page is a dead URL, not an empty page.
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/settings/nonsense`);
  await expect(
    page.getByRole("heading", { name: "Page not found" })
  ).toBeVisible();
});

test("the settings page is one flat form, and saving PATCHes only the task", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/settings`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true })
  ).toBeVisible();

  const main = page.getByRole("main");

  // FLAT, not an index: the fields are on this page, not behind group rows.
  await expect(page.getByLabel("Name")).toHaveValue(TASK_NAME);

  // The date's calendar is ON THE PAGE, not behind a trigger — the settings-
  // page picker (#638). The lazy picker chunk has to arrive first, hence the
  // generous timeout.
  await expect(main.getByRole("gridcell").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Open calendar" })).toHaveCount(0);

  // Pilot classes are full-width rows (CheckList), so each is a real checkbox
  // in a group and the whole ROW is the target. Measure the row, not the
  // input: RAC hides the real checkbox under a styled span and wraps both in
  // the label that is the row (rac gotcha #13), so the input's own box is
  // 13px and says nothing about what a thumb can hit.
  const sport = page.getByRole("checkbox", { name: "sport" });
  await expect(sport).toBeChecked();
  const sportRow = page.locator("label").filter({ hasText: /^sport$/ });
  const sportBox = await sportRow.boundingBox();
  expect(sportBox, "the sport class row has a bounding box").not.toBeNull();
  expect(sportBox!.height).toBeGreaterThanOrEqual(44);

  // The NavList foot: the two settings that are their own page, plus the
  // destructive action kept out of the form.
  await expect(main.getByRole("link", { name: /^Route/ })).toContainText(
    "No route yet"
  );
  await expect(main.getByRole("link", { name: /^Weather notes/ })).toContainText(
    "None yet"
  );
  await expect(
    page.getByRole("button", { name: "Delete task" })
  ).toBeVisible();

  // Change one thing and save. Click the ROW, for the same reason.
  await sportRow.click();
  await expect(sport).not.toBeChecked();

  const [patch] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === "PATCH" && r.url().includes(`/task/${taskId}`)
    ),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  // ONLY the task's own fields travel. The server diffs per field for its
  // audit sentences and score bumps, so a page sending anything else would
  // quietly widen every save.
  const body = patch.postDataJSON() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "name",
    "pilot_classes",
    "stop_announcement_time",
    "submissions_closed",
    "task_date",
  ]);
  expect(body.pilot_classes).toEqual(["open"]);

  // A successful save lands back on the task, which is what the admin was
  // looking at.
  await expect(page.getByRole("heading", { name: TASK_NAME })).toBeVisible();
});

test("weather notes are a sub-page the task page links to", async ({ page }) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}`);

  // The Weather section's manage action is a LINK now, not a dialog trigger.
  const addNotes = page.getByRole("link", { name: /notes…$/ });
  await expect(addNotes).toBeVisible();
  await addNotes.click();

  await expect(
    page.getByRole("heading", { name: "Weather notes", exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/weather$/);

  const notes = "Inversion broke about 12:30.";
  await page.getByLabel("What did the day do?").fill(notes);

  const [patch] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === "PATCH" && r.url().includes(`/task/${taskId}`)
    ),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  // Notes are not a scoring input; the save carries nothing else with it.
  expect(Object.keys(patch.postDataJSON() as Record<string, unknown>)).toEqual([
    "weather_notes",
  ]);

  // Saving a sub-page returns to the settings form, whose row now summarises
  // what was written.
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^Weather notes/ })
  ).toContainText(notes);
});

test("the route editor is a route, and guards unsaved work", async ({ page }) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}`);

  // The Route section's action is a link to the editor's own URL.
  await page.getByRole("link", { name: /route…$/ }).click();
  await expect(page).toHaveURL(/\/route$/);
  await expect(
    page.getByRole("heading", { name: "Route", exact: true })
  ).toBeVisible();
  // Not a dialog: nothing here traps focus or dims the page behind it.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The Start panel is a Disclosure, collapsed by default — the defaults suit
  // most competitions and the header badge reads the live config back, so
  // this expand is the product's design, not a workaround.
  await page.getByRole("button", { name: /^Start \(SSS\)/ }).click();

  // Start type is a list in flow (#638): both options are readable at once,
  // which is the point when each carries its own explanation. A radio, not a
  // combobox — ChoiceList keeps RAC's RadioGroup semantics underneath.
  await expect(page.getByRole("radio", { name: /^Race to goal/ })).toBeVisible();

  // Dirty the editor, then try to leave by the breadcrumb. Click the option's
  // TEXT, not the radio: ChoiceList paints the row with spans over a hidden
  // input, so the input's own box is covered (rac gotcha #13, the same reason
  // comp-settings-pages.spec.ts clicks labels).
  await page
    .getByText("Elapsed time — timed from each pilot's crossing")
    .click();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: TASK_NAME })
    .click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Discard route changes?")).toBeVisible();
  await dialog.getByRole("button", { name: /Discard/ }).click();
  await expect(page.getByRole("heading", { name: TASK_NAME })).toBeVisible();
});

test("the whole journey fits a phone: no horizontal overflow", async ({
  page,
  isMobile,
}) => {
  // The viewport comes from the `mobile` project (issue #643), which also
  // brings touch, a mobile user agent and `(pointer: coarse)`. The other tests
  // in this file run in both projects, so the pages are driven at a phone
  // width regardless; what is left here is the assertion that only means
  // something there.
  phoneOnly(isMobile);
  await devLogin(page, ADMIN_USER);

  const noHorizontalOverflow = async (where: string) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(
      overflow,
      `${where} must not scroll sideways on a phone`
    ).toBeLessThanOrEqual(0);
  };

  await page.goto(`/comp/${compId}/task/${taskId}/settings`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true })
  ).toBeVisible();
  // Wait for the lazy calendar, which is the widest thing on the page and so
  // the one most able to push it sideways.
  await expect(page.getByRole("main").getByRole("gridcell").first()).toBeVisible({
    timeout: 15_000,
  });
  await noHorizontalOverflow("task settings");

  // The NavList rows are comfortably tappable.
  const routeRow = page.getByRole("main").getByRole("link", { name: /^Route/ });
  const rowBox = await routeRow.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);

  // The route editor: the widest surface in the app, and the one that used to
  // be a 100dvh modal.
  await routeRow.click();
  await expect(
    page.getByRole("heading", { name: "Route", exact: true })
  ).toBeVisible();
  await noHorizontalOverflow("the route editor");

  // Its Save is fixed to the bottom of the VIEWPORT, so it is reachable
  // without scrolling past the whole page.
  const save = page.getByRole("button", { name: "Save" });
  const saveBox = await save.boundingBox();
  const viewport = page.viewportSize()!;
  expect(saveBox, "the route editor's Save has a bounding box").not.toBeNull();
  expect(saveBox!.y).toBeLessThanOrEqual(viewport.height);
});
