/**
 * The routed task editors (issue #637) — the second half of the conversion
 * `comp-settings-pages.spec.ts` covers the first half of. What used to be the
 * Task Settings dialog, the weather-notes dialog and the route-editor dialog
 * are now three SIBLING routes under the task: `/settings`, `/weather` and
 * `/route`. Each is reached from the part of the task page it edits, which is
 * why none nests under another.
 *
 * What this spec pins:
 * - the flat settings form and its Danger-zone foot — the shape that
 *   deliberately differs from the competition's grouped index, and which
 *   carries no nav rows for the sibling editors;
 * - that a save PATCHes ONLY the task's own fields;
 * - the pickers that came in with it: an in-flow calendar with no "Open
 *   calendar" trigger, and pilot classes as full-width rows rather than a
 *   16px checkbox beside a label;
 * - the weather-notes round trip, and that the task page links to it rather
 *   than opening a dialog;
 * - the route editor as a real route, with its unsaved-changes guard;
 * - non-admin fallback, and that a made-up editor segment is a dead URL;
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

test("a visitor gets the admin-only notice, and a made-up editor 404s", async ({
  page,
}) => {
  // Before any admin test reshapes the task: a signed-in non-admin reaches the
  // URL but not the settings.
  await devLogin(page, VISITOR_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/settings`);
  await expect(
    page.getByText("Task settings are for competition admins.")
  ).toBeVisible();

  // Settings is flat — it has no sub-pages — so anything below it is a dead
  // URL, not an empty page.
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

  // The destructive action is a row at the foot, kept out of the form — it is
  // an action, not a setting, and has no business beside a Save button.
  await expect(page.getByRole("button", { name: "Delete task" })).toBeVisible();

  // And NOTHING here links to the sibling editors. They are reached from the
  // sections of the task page they edit; listing them again would duplicate
  // those entry points and frame content as settings.
  await expect(main.getByRole("link", { name: /^Route/ })).toHaveCount(0);
  await expect(main.getByRole("link", { name: /^Weather notes/ })).toHaveCount(0);

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

test("weather notes are their own page, which the task page links to", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}`);

  // The Weather section's manage action is a LINK now, not a dialog trigger.
  const addNotes = page.getByRole("link", { name: /^(Add|Edit) notes$/ });
  await expect(addNotes).toBeVisible();
  await addNotes.click();

  await expect(
    page.getByRole("heading", { name: "Weather notes", exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/\/weather$/);

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

  // Saving returns to the task page, where the notes are read.
  await expect(page.getByRole("heading", { name: TASK_NAME })).toBeVisible();
  await expect(page.getByText(notes)).toBeVisible();
});

test("the route editor is a route, and guards unsaved work", async ({ page }) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/task/${taskId}`);

  // The Route section's action is a link to the editor's own URL.
  await page.getByRole("link", { name: /^(Create|Edit) route$/ }).click();
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

  // The Danger-zone row is comfortably tappable.
  const deleteRow = page.getByRole("button", { name: "Delete task" });
  const rowBox = await deleteRow.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);

  // The route editor: the widest surface in the app, and the one that used to
  // be a 100dvh modal. Reached from the task page's Route section, which is
  // the only way in.
  await page.goto(`/comp/${compId}/task/${taskId}/route`);
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

/**
 * The route without the syntax (#661).
 *
 * The three pieces that replaced the read-only listing plus a text field: rows
 * that open a full-screen turnpoint sheet, a Reorder MODE carrying Move up /
 * Move down (no drag — see RAC gotcha #4), and Quick entry as its own sheet
 * applied by an explicit press.
 */
const ROUTE_WAYPOINTS = [
  { code: "ALPHA", name: "Alpha Hill", latitude: -36.5, longitude: 147.8, altitude: 900, radius: 400 },
  { code: "BRAVO", name: "Bravo Gap", latitude: -36.6, longitude: 147.9, altitude: 800, radius: 400 },
  { code: "CHARL", name: "Charlie Field", latitude: -36.7, longitude: 148.0, altitude: 700, radius: 400 },
];

/** A three-turnpoint route on the fixture task, straight through the API. */
async function seedRoute(page: Page) {
  const wp = await page.request.put(`/api/comp/${compId}/waypoints`, {
    data: { waypoints: ROUTE_WAYPOINTS },
  });
  expect(wp.ok(), await wp.text()).toBe(true);

  const patch = await page.request.patch(`/api/comp/${compId}/task/${taskId}`, {
    data: {
      xctsk: {
        taskType: "CLASSIC",
        version: 1,
        turnpoints: ROUTE_WAYPOINTS.map((w, i) => ({
          ...(i === 0 ? { type: "TAKEOFF" as const } : {}),
          radius: 400,
          waypoint: {
            name: w.code,
            description: w.name,
            lat: w.latitude,
            lon: w.longitude,
            altSmoothed: w.altitude,
          },
        })),
      },
    },
  });
  expect(patch.ok(), await patch.text()).toBe(true);
}

/** Every turnpoint row's text, in route order. */
async function routeRows(page: Page): Promise<string[]> {
  const rows = page.getByRole("grid", { name: /^Turnpoints/ }).getByRole("row");
  await expect(rows.first()).toBeVisible();
  return (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

test("a turnpoint is edited in a sheet, and reordered in a mode", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await seedRoute(page);
  await page.goto(`/comp/${compId}/task/${taskId}/route`);

  expect(await routeRows(page)).toHaveLength(3);

  // A row opens the turnpoint sheet — over the editor, not away from it, so
  // the unsaved route survives (and the unsaved-changes guard never fires on
  // the way in, which a link would).
  await page.getByRole("row").filter({ hasText: "BRAVO" }).click();
  const sheet = page.getByRole("dialog", { name: /^Edit / });
  await expect(sheet.getByRole("heading", { name: "Edit turnpoint" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(1);

  // There is no Cancel: nothing here is saved, so Done and the back gesture
  // both keep the edits, and Delete is the only way to lose a turnpoint.
  await sheet.getByRole("button", { name: "Set radius 2000 metres" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  expect((await routeRows(page)).join("\n")).toContain("BRAVO");
  expect(await routeRows(page)).toEqual(
    expect.arrayContaining([expect.stringContaining("r. 2 km")])
  );

  // THE reason the sheet is a sheet: the route is dirty now, and
  // use-unsaved-changes-guard intercepts every same-origin anchor click while
  // it is. A row that navigated would ask "Discard route changes?" on the way
  // IN to editing a turnpoint — so opening one must raise no dialog at all.
  await page.getByRole("row").filter({ hasText: "CHARL" }).click();
  await expect(sheet.getByRole("heading", { name: "Edit turnpoint" })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();

  // Reorder is a MODE: at rest the rows carry no per-row chrome at all.
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await page.getByRole("button", { name: "Move CHARL up" }).click();

  const order = (await routeRows(page)).map((t) => t.split(" ")[1]);
  expect(order).toEqual(["ALPHA", "CHARL", "BRAVO"]);
  // Rows swapping places is invisible to a screen reader, so it is said.
  await expect(page.getByText("CHARL moved to 2 of 3")).toBeAttached();
  // Focus follows the turnpoint, not the position it left — otherwise a
  // second press would move whatever slid in underneath.
  await expect(page.getByRole("button", { name: "Move CHARL up" })).toBeFocused();

  await page.getByRole("button", { name: "Done reordering" }).click();
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
});

test("Quick entry rebuilds the route without losing what the line can't say", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await seedRoute(page);
  await page.goto(`/comp/${compId}/task/${taskId}/route`);
  expect(await routeRows(page)).toHaveLength(3);

  // Set a radius the ALPHA waypoint record does not carry, so a rebuild from
  // the waypoints would visibly lose it.
  await page.getByRole("row").filter({ hasText: "ALPHA" }).click();
  const tp = page.getByRole("dialog", { name: /^Edit / });
  await tp.getByRole("button", { name: "Set radius 3000 metres" }).click();
  await tp.getByRole("button", { name: "Done" }).click();
  await expect(tp).toBeHidden();

  await page.getByRole("button", { name: "Quick entry" }).click();
  const quick = page.getByRole("dialog", { name: "Quick entry" });
  const line = quick.getByRole("textbox", { name: "Enter task" });
  // The sheet opens showing the route that is loaded — it edits a route as
  // well as entering one.
  await expect(line).toHaveValue(/ALPHA/);
  await expect(line).toHaveValue(/CHARL/);

  await line.fill("ALPHA, BRAVO");
  await quick.getByRole("button", { name: "Use this route" }).click();
  await expect(quick).toBeHidden();

  const rows = await routeRows(page);
  expect(rows.map((t) => t.split(" ")[1])).toEqual(["ALPHA", "BRAVO"]);
  // Reconciled, not rebuilt: the hand-set radius rode through the apply even
  // though the grammar has no way to have said it.
  expect(rows[0]).toContain("r. 3 km");

  // Leaving with the text changed asks first — the press is the commit.
  await page.getByRole("button", { name: "Quick entry" }).click();
  await quick.getByRole("textbox", { name: "Enter task" }).fill("ALPHA");
  await quick.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByRole("alertdialog");
  await expect(discard.getByText("Discard this text?")).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(quick).toBeVisible();
  await quick.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(quick).toBeHidden();
  // The route is untouched by a dismissed sheet.
  expect((await routeRows(page)).map((t) => t.split(" ")[1])).toEqual([
    "ALPHA",
    "BRAVO",
  ]);
});
