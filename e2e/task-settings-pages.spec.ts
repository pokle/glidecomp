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
 * - the route editor's own pages (#812) — a turnpoint, Quick entry, Load
 *   from XContest, Add waypoint, each a sheet or a dialog until then — over
 *   one draft of the route that survives going between them, Back and a
 *   reload;
 * - start and goal settings on the SSS / last-turnpoint pages (as well as
 *   the page disclosures);
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
import { test, expect, PHONE_ONLY, type Page } from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
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
      // Public, so the visitor test reaches the admin-only notice rather than
      // a hidden comp's 404.
      test: false,
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

test("a visitor is sent to the task, and a made-up editor 404s", async ({
  page,
}) => {
  // Before any admin test reshapes the task: a signed-in non-admin reaching
  // the URL is sent to the task page, where the task is to read.
  await devLogin(page, VISITOR_USER);
  await page.goto(`/comp/${compId}/task/${taskId}/settings`);
  await expect(page.getByText("That page is for the competition’s organisers.")).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/settings/);
  // The route editor's pages send them the same way.
  await page.goto(`/comp/${compId}/task/${taskId}/route`);
  await expect(page).not.toHaveURL(/\/route/, { timeout: 20_000 });

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
  await page.getByRole("button", { name: /^Start Speed Section \(SSS\)/ }).click();

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

test("the whole journey fits a phone: no horizontal overflow", { tag: PHONE_ONLY }, async ({
  page,
}) => {
  // The viewport comes from the `mobile` project (issue #643), which also
  // brings touch, a mobile user agent and `(pointer: coarse)`. The other tests
  // in this file run in both projects, so the pages are driven at a phone
  // width regardless; what is left here is the assertion that only means
  // something there.
  await devLogin(page, ADMIN_USER);

  await page.goto(`/comp/${compId}/task/${taskId}/settings`);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true })
  ).toBeVisible();
  // Wait for the lazy calendar, which is the widest thing on the page and so
  // the one most able to push it sideways.
  await expect(page.getByRole("main").getByRole("gridcell").first()).toBeVisible({
    timeout: 15_000,
  });
  await expectNoSidewaysScroll(page, "task settings");

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
  await expectNoSidewaysScroll(page, "the route editor");

  // Its Save is sticky to the bottom of the VIEWPORT — sticky in the page's
  // flow, never fixed (the overlays rule) — so it is reachable without
  // scrolling past the whole page.
  const save = page.getByRole("button", { name: "Save" });
  const saveBox = await save.boundingBox();
  const viewport = page.viewportSize()!;
  expect(saveBox, "the route editor's Save has a bounding box").not.toBeNull();
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(viewport.height);
  expect(
    await page
      .getByRole("button", { name: "Save" })
      .evaluate((el) => getComputedStyle(el.closest("form")!).position)
  ).toBe("sticky");

  // The route editor's other pages (#812), where they were a full-screen
  // sheet and a dialog: each a page that fits the phone.
  await page.goto(`/comp/${compId}/task/${taskId}/route/xcontest`);
  await expect(
    page.getByRole("heading", { name: "Load from XContest", exact: true })
  ).toBeVisible();
  await expectNoSidewaysScroll(page, "Load from XContest");
  await page.goto(`/comp/${compId}/task/${taskId}/route/add-waypoint?at=-36.9,148.1`);
  await expect(page.getByRole("heading", { name: "Add waypoint", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page, "Add waypoint");
});

/**
 * The route without the syntax (#661), and since #812 without overlays.
 *
 * The pieces that replaced the read-only listing plus a text field: rows that
 * open a turnpoint's own PAGE (/route/:n — a full-screen sheet until #812), a
 * Reorder MODE carrying Move up / Move down (no drag — see RAC gotcha #4), and
 * Quick entry, Load from XContest and Add waypoint as pages of their own.
 * They all edit one DRAFT of the route, kept in the tab's storage
 * (comp/route-draft.ts), so going to one and back — by Done or by Back — and
 * reloading all find the route as it was left.
 *
 * URLs are compared by the ids in them: the pages rewrite themselves to the
 * canonical slug form once the names arrive.
 */
const ROUTE_WAYPOINTS = [
  { code: "ALPHA", name: "Alpha Hill", latitude: -36.5, longitude: 147.8, altitude: 900, radius: 400 },
  { code: "BRAVO", name: "Bravo Gap", latitude: -36.6, longitude: 147.9, altitude: 800, radius: 400 },
  { code: "CHARL", name: "Charlie Field", latitude: -36.7, longitude: 148.0, altitude: 700, radius: 400 },
];

/** A three-turnpoint route on the fixture task, straight through the API. */
async function seedRoute(page: Page, opts?: { withSpeedSection?: boolean }) {
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
          ...(opts?.withSpeedSection && i === 1 ? { type: "SSS" as const } : {}),
          radius: 400,
          waypoint: {
            name: w.code,
            description: w.name,
            lat: w.latitude,
            lon: w.longitude,
            altSmoothed: w.altitude,
          },
        })),
        ...(opts?.withSpeedSection
          ? {
              sss: { type: "RACE" as const, direction: "EXIT" as const },
              goal: { type: "CYLINDER" as const },
            }
          : {}),
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

/**
 * The turnpoint codes, in route order: each row's first word that is not its
 * role, its Exit badge or (while reordering) its position.
 */
async function routeCodes(page: Page): Promise<string[]> {
  return (await routeRows(page)).map(
    (t) => t.split(" ").find((w) => !/^(TAKEOFF|SSS|ESS|GOAL|Exit|\d+\.)$/.test(w)) ?? ""
  );
}

/**
 * Open a turnpoint's page from its row. Scrolled into view first: on a phone
 * the sticky Save bar can sit over the row a click is aimed at.
 */
async function openTurnpoint(page: Page, code: string) {
  const row = page.getByRole("row").filter({ hasText: code });
  await row.scrollIntoViewIfNeeded();
  await row.click();
}

/** The route editor's own page, whatever slug the URL has settled on. */
const ROUTE_URL = /\/route$/;

test("a turnpoint is edited on its own page, and reordered in a mode", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await seedRoute(page);
  await page.goto(`/comp/${compId}/task/${taskId}/route`);

  expect(await routeRows(page)).toHaveLength(3);

  // A row opens the turnpoint's PAGE, addressed by the draft's row id — not
  // an overlay: nothing traps focus or dims the route behind it.
  await openTurnpoint(page, "BRAVO");
  await expect(page).toHaveURL(/\/route\/2$/);
  await expect(page.getByRole("heading", { name: "Edit turnpoint" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // There is no Cancel: nothing here is saved, so Done and Back both keep
  // the edits, and Delete is the only way to lose a turnpoint.
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  await page.getByRole("button", { name: "Set radius 2000 metres" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(ROUTE_URL);
  expect(await routeRows(page)).toEqual(
    expect.arrayContaining([expect.stringContaining("r. 2 km")])
  );
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // The route is a draft in this tab's storage: a reload finds it.
  await page.reload();
  expect(await routeRows(page)).toEqual(
    expect.arrayContaining([expect.stringContaining("r. 2 km")])
  );

  // The route is dirty now, and the guard asks before a link LEAVES it — but
  // a turnpoint's page is inside the editor, so opening one asks nothing.
  await openTurnpoint(page, "CHARL");
  await expect(page).toHaveURL(/\/route\/3$/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Set radius 5000 metres" }).click();
  // Back keeps the edit as surely as Done does: it went into the draft as it
  // was made.
  await page.goBack();
  await expect(page).toHaveURL(ROUTE_URL);
  expect((await routeRows(page)).find((t) => t.includes("CHARL"))).toContain("r. 5 km");

  // Delete is on the turnpoint's page, and takes it out of the route.
  await openTurnpoint(page, "CHARL");
  await page.getByRole("button", { name: "Delete turnpoint" }).click();
  await expect(page).toHaveURL(ROUTE_URL);
  expect(await routeCodes(page)).toEqual(["ALPHA", "BRAVO"]);
  // A link to the deleted turnpoint names nothing now, not some other row.
  await page.goto(`/comp/${compId}/task/${taskId}/route/3`);
  await expect(page.getByRole("heading", { name: "Turnpoint not found" })).toBeVisible();

  // Throwing the draft away on purpose: Cancel asks, then the saved route is
  // back.
  await page.goto(`/comp/${compId}/task/${taskId}/route`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("heading", { name: TASK_NAME })).toBeVisible();
  await page.goto(`/comp/${compId}/task/${taskId}/route`);
  expect(await routeCodes(page)).toEqual(["ALPHA", "BRAVO", "CHARL"]);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);

  // Reorder is a MODE: at rest the rows carry no per-row chrome at all.
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
  await page.getByRole("button", { name: "Reorder", exact: true }).click();
  await page.getByRole("button", { name: "Move CHARL up" }).click();

  expect(await routeCodes(page)).toEqual(["ALPHA", "CHARL", "BRAVO"]);
  // Rows swapping places is invisible to a screen reader, so it is said.
  await expect(page.getByText("CHARL moved to 2 of 3")).toBeAttached();
  // Focus follows the turnpoint, not the position it left — otherwise a
  // second press would move whatever slid in underneath.
  await expect(page.getByRole("button", { name: "Move CHARL up" })).toBeFocused();

  await page.getByRole("button", { name: "Done reordering" }).click();
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);

  // A row id follows its turnpoint through the reorder: CHARL is still 3.
  await openTurnpoint(page, "CHARL");
  await expect(page).toHaveURL(/\/route\/3$/);
  await expect(page.getByRole("textbox", { name: "Code" })).toHaveValue("CHARL");
});

test("start and goal settings live on the turnpoint they belong to", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await seedRoute(page, { withSpeedSection: true });
  await page.goto(`/comp/${compId}/task/${taskId}/route`);

  // Opening the start cylinder is how you change start type, direction and
  // gates — the page disclosure still has them, but that is not where an
  // organiser looking at the SSS row goes.
  await openTurnpoint(page, "BRAVO");
  await expect(
    page.getByRole("heading", { name: "Start Speed Section (SSS)" })
  ).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Enter start/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Goal line/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Turnpoint", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Turnpoint (last is goal)" })).toHaveCount(0);
  await page.getByText("Enter start — cross inward").click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(ROUTE_URL);
  // The Start disclosure badge reads the live config without expanding.
  await expect(page.getByText(/enter start/)).toBeVisible();

  // The last turnpoint is the goal: its page carries type and deadline.
  await openTurnpoint(page, "CHARL");
  await expect(page.getByRole("heading", { name: "Goal", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Goal line/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Enter start/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Turnpoint (last is goal)" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Goal", exact: true })).toBeChecked();
  await page.getByText("Goal line — perpendicular to the last leg").click();
  // A reload of the turnpoint's page keeps what was chosen on it.
  await page.reload();
  await expect(page.getByRole("radio", { name: /^Goal line/ })).toBeChecked();
  // And Done after the reload still lands on the route.
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(ROUTE_URL);

  await page.getByRole("button", { name: /^Goal$/ }).click();
  await expect(page.getByRole("radio", { name: /^Goal line/ })).toBeChecked();
});

test("adding a turnpoint infers Takeoff, Start, then Goal after a Goal", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await seedRoute(page, { withSpeedSection: true });
  await page.goto(`/comp/${compId}/task/${taskId}/route`);

  // Seeded last (CHARL) is untyped in the file, so the UI loads it as Goal.
  // Add turnpoint opens a page for the new one, under a row id of its own.
  await page.getByRole("button", { name: "Add turnpoint" }).click();
  await expect(page).toHaveURL(/\/route\/4$/);
  await expect(page.getByRole("heading", { name: "Add turnpoint" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Goal", exact: true })).toBeChecked();
  await page.getByRole("textbox", { name: "Code" }).fill("DELTA");
  await page.getByRole("textbox", { name: "Coordinates (lat, lon)" }).fill("-36.8, 148.1");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(ROUTE_URL);

  // The new last is Goal; the previous Goal is an ordinary Turnpoint.
  await openTurnpoint(page, "CHARL");
  await expect(page.getByRole("radio", { name: "Turnpoint", exact: true })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Goal", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Done" }).click();

  await openTurnpoint(page, "DELTA");
  await expect(page.getByRole("radio", { name: "Goal", exact: true })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Goal", exact: true })).toBeVisible();
  // Coordinates that do not read as coordinates are refused under their
  // field, and Done stays on the page.
  await page.getByRole("textbox", { name: "Coordinates (lat, lon)" }).fill("nowhere");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText('Enter "lat, lon" decimal degrees')).toBeVisible();
  await expect(page).toHaveURL(/\/route\/4$/);
  await page.getByRole("textbox", { name: "Coordinates (lat, lon)" }).fill("-36.8, 148.1");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(ROUTE_URL);

  await page.getByRole("button", { name: "Clear turnpoints" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clear" }).click();
  await page.getByRole("button", { name: "Add turnpoint" }).click();
  await expect(page.getByRole("radio", { name: "Takeoff" })).toBeChecked();
  await expect(page.getByRole("heading", { name: "Goal", exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Code" }).fill("ONE");
  await page.getByRole("textbox", { name: "Coordinates (lat, lon)" }).fill("-36.5, 147.8");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(ROUTE_URL);

  await page.getByRole("button", { name: "Add turnpoint" }).click();
  await expect(
    page.getByRole("radio", { name: "Start Speed Section (SSS)", exact: true })
  ).toBeChecked();
  await expect(page.getByRole("heading", { name: "Goal", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Start Speed Section (SSS)" })).toBeVisible();

  // An Add left empty adds nothing: Back from it, and the route is as it was.
  await page.goBack();
  await expect(page).toHaveURL(ROUTE_URL);
  expect(await routeCodes(page)).toEqual(["ONE"]);
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
  await openTurnpoint(page, "ALPHA");
  await page.getByRole("button", { name: "Set radius 3000 metres" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(ROUTE_URL);

  // Quick entry is a page of its own now, not a sheet over the route.
  await page.getByRole("button", { name: "Quick entry" }).click();
  await expect(page).toHaveURL(/\/route\/quick$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const line = page.getByRole("textbox", { name: "Enter task" });
  // It opens showing the route in the draft — it edits a route as well as
  // entering one.
  await expect(line).toHaveValue(/ALPHA/);
  await expect(line).toHaveValue(/CHARL/);

  await line.fill("ALPHA, BRAVO");
  await page.getByRole("button", { name: "Use this route" }).click();
  await expect(page).toHaveURL(ROUTE_URL);

  expect(await routeCodes(page)).toEqual(["ALPHA", "BRAVO"]);
  const rows = await routeRows(page);
  // Reconciled, not rebuilt: the hand-set radius rode through the apply even
  // though the grammar has no way to have said it.
  expect(rows[0]).toContain("r. 3 km");

  // Leaving with the text changed asks first — the press is the commit.
  await page.getByRole("button", { name: "Quick entry" }).click();
  await page.getByRole("textbox", { name: "Enter task" }).fill("ALPHA");
  await page.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByRole("alertdialog");
  await expect(discard.getByText("Discard this text?")).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  // Gone, rather than closing: on its way out the dialog's own buttons fall
  // back to their default words, one of which is "Cancel".
  await expect(discard).toHaveCount(0);
  await expect(page).toHaveURL(/\/route\/quick$/);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
  await expect(page).toHaveURL(ROUTE_URL);
  // The route is untouched by a line that was not used.
  expect(await routeCodes(page)).toEqual(["ALPHA", "BRAVO"]);

  // And Back is the browser's: it leaves without using the line, too.
  await page.getByRole("button", { name: "Quick entry" }).click();
  await page.getByRole("textbox", { name: "Enter task" }).fill("BRAVO");
  await page.goBack();
  await expect(page).toHaveURL(ROUTE_URL);
  expect(await routeCodes(page)).toEqual(["ALPHA", "BRAVO"]);
});

test("Load from XContest is a page, and refuses a code under its field", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await seedRoute(page);

  // XContest is not ours to call from a test: answer for it. An unknown code
  // is a 404 there.
  const xcontest = "https://tools.xcontest.org/api/xctsk/load/**";
  const cors = { "Access-Control-Allow-Origin": "*" };
  await page.route(xcontest, (route) =>
    route.request().url().endsWith("/NOPE")
      ? route.fulfill({ status: 404, headers: cors, body: "" })
      : route.fulfill({
          status: 200,
          headers: { ...cors, "Content-Type": "application/json" },
          body: JSON.stringify({
            taskType: "CLASSIC",
            version: 1,
            turnpoints: [
              { type: "TAKEOFF", radius: 400, waypoint: { name: "XC1", lat: -36.1, lon: 147.1, altSmoothed: 500 } },
              { radius: 1000, waypoint: { name: "XC2", lat: -36.2, lon: 147.2, altSmoothed: 600 } },
            ],
          }),
        })
  );

  await page.goto(`/comp/${compId}/task/${taskId}/route`);
  await page.getByRole("button", { name: "Load from XContest" }).click();
  await expect(page).toHaveURL(/\/route\/xcontest$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const code = page.getByRole("textbox", { name: "Task code" });
  await code.fill("NOPE");
  await page.getByRole("button", { name: "Load", exact: true }).click();
  // Under the field it is about, which keeps what was typed.
  await expect(page.getByText('Task code "NOPE" not found')).toBeVisible();
  await expect(code).toHaveValue("NOPE");
  await expect(code).toHaveAttribute("aria-invalid", "true");

  await code.fill("ABC123");
  await page.getByRole("button", { name: "Load", exact: true }).click();
  // The route already has turnpoints, so it asks before replacing them.
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click();
  // Straight back to the route: no dialog holds a history entry to wait for
  // (#817), so the page goes while the question is still fading out.
  await expect(page).toHaveURL(ROUTE_URL);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await routeCodes(page)).toEqual(["XC1", "XC2"]);

  // Back to the route leaves the editor's draft where it was; Cancel there
  // throws it away so the next test starts from the seeded route.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByRole("heading", { name: TASK_NAME })).toBeVisible();
});

test("a waypoint added from the route's map is a page, and is saved with the route", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await seedRoute(page);

  // What a tap on the map with "Add from map" armed opens: the tap rides in
  // the URL, so this is the page as the tap leaves it (and as a reload finds
  // it). Reached without the route underneath, its way out is the route.
  await page.goto(`/comp/${compId}/task/${taskId}/route/add-waypoint?at=-36.9,148.2`);
  await expect(page.getByRole("heading", { name: "Add waypoint", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Coordinates (lat, lon)" })).toHaveValue(
    "-36.9,148.2"
  );
  await page.getByRole("textbox", { name: "Code" }).fill("ECHO");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page).toHaveURL(ROUTE_URL);
  expect(await routeCodes(page)).toEqual(["ALPHA", "BRAVO", "CHARL", "ECHO"]);
  await expect(
    page.getByText("1 new — saved to the competition when you save the route")
  ).toBeVisible();

  // Nothing reached the competition yet.
  const before = await page.request.get(`/api/comp/${compId}/waypoints`);
  expect(
    ((await before.json()) as { waypoints: { code: string }[] }).waypoints.map((w) => w.code)
  ).not.toContain("ECHO");

  // Save writes the waypoint, then the route, and goes back to the task.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: TASK_NAME })).toBeVisible();
  const after = await page.request.get(`/api/comp/${compId}/waypoints`);
  expect(
    ((await after.json()) as { waypoints: { code: string }[] }).waypoints.map((w) => w.code)
  ).toContain("ECHO");
  const task = await page.request.get(`/api/comp/${compId}/task/${taskId}`);
  expect(
    ((await task.json()) as { xctsk: { turnpoints: { waypoint: { name: string } }[] } }).xctsk
      .turnpoints.map((t) => t.waypoint.name)
  ).toEqual(["ALPHA", "BRAVO", "CHARL", "ECHO"]);

  // Saved, the draft is gone: the route opens clean.
  await page.goto(`/comp/${compId}/task/${taskId}/route`);
  expect(await routeCodes(page)).toEqual(["ALPHA", "BRAVO", "CHARL", "ECHO"]);
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
});
