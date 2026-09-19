/**
 * Comp waypoints page (/comp/:id/waypoints) — interaction coverage for its RAC
 * surfaces. Runs in BOTH Playwright projects (see e2e/fixtures/mobile.ts):
 *
 * - Admins get a LIST of waypoints, each row opening a full-screen sheet, at
 *   every width. The Tabulator grid this replaced on 2026-09-19 is gone rather
 *   than hidden behind a breakpoint (the mobile-first rule in CLAUDE.md), so
 *   the tests assert `.tabulator` is absent and that the page never scrolls
 *   sideways. A sheet's edits are a draft applied on the way out, and mirror
 *   into React state then (the "N waypoints" count, the dirty Save button,
 *   coordinate validation).
 * - Save lives in the page's fixed bottom bar beside an "Unsaved changes"
 *   hint, and while dirty a navigation guard offers Discard/Keep editing —
 *   the comp-settings behaviour (settings-save-ux.spec.ts), brought here
 *   after an admin lost a set of added waypoints to a tap on a link.
 * - The map maximises into a full-screen sheet carrying its own Add-from-map
 *   toggle, so several points can be placed from a phone-sized map.
 * - "Check altitudes" is the page's only altitude action and reports nothing
 *   until pressed. It compares the whole set against the map's terrain in a
 *   sheet of its own: a snapshot-narrowed list (frozen in membership AND
 *   order), a per-row accept, a per-waypoint detail view, and a live-region
 *   banner. Driven against a FLAT synthetic DEM (stubTerrainElevations), so
 *   every disagreement in the test is arithmetic the test chose rather than
 *   whatever the real terrain says.
 * - Every sheet is dismissable with the browser's Back (lib/use-back-dismiss),
 *   one layer per press — the review's detail view back to its list, not out
 *   of the page.
 * - Anonymous visitors get the read-only RAC table instead.
 * - The device-export panel (RAC Menu of download formats, QR toggle, swap
 *   checkbox) and the RAC Add-waypoint dialog.
 * - One save round-trip against the real API, restored afterwards from the
 *   captured original so the seeded comp is left exactly as found.
 *
 * Drives the seeded "Corryong Cup 2026" sample comp. Every test except the
 * save round-trip is mutation-free (trackMutations pattern from
 * comp-detail.spec.ts); the round-trip restores via API in a finally block.
 *
 * RAC testing gotchas honoured here (rac-adoption-guide):
 * - Never wait on "networkidle" (freshness pollers elsewhere; DOM waits only).
 * - RAC checkboxes can't be *clicked* by role — the real input is visually
 *   hidden. Click the label text, assert by role (gotcha #13).
 * - `getByRole` matches an accessible name as a SUBSTRING: "Waypoints" also
 *   matches "Edit waypoints", so exact names are passed `exact: true`.
 * - The rows rebuild when the page's fetch lands, which detaches a node
 *   mid-click; `beforeEach` waits for the full row count before any test
 *   touches one.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page, type Locator } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";
import { stubTerrainElevations } from "./fixtures/mapbox";

const BASE_URL = FRONTEND_URL;
const COMP_NAME = "Corryong Cup 2026";

interface Waypoint {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  altitude: number;
  radius: number;
}

let compId: string;
let waypoints: Waypoint[];

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: BASE_URL });

  const findComp = async (): Promise<string | null> => {
    const res = await api.get("/api/comp");
    if (!res.ok()) return null;
    const { comps } = (await res.json()) as {
      comps: Array<{ comp_id: string; name: string }>;
    };
    return comps.find((c) => c.name === COMP_NAME)?.comp_id ?? null;
  };

  let id = await findComp();
  if (!id) {
    execSync("bun run seed corryong-cup-2026", {
      stdio: "inherit",
      timeout: 240_000,
    });
    id = await findComp();
  }
  if (!id) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  compId = id;

  const wpRes = await api.get(`/api/comp/${compId}/waypoints`);
  expect(wpRes.ok()).toBe(true);
  waypoints = ((await wpRes.json()) as { waypoints: Waypoint[] }).waypoints;
  // The seed builds the comp waypoint set as the union of task turnpoints —
  // a seeded comp always has some.
  expect(waypoints.length).toBeGreaterThan(0);

  await api.dispose();
});

/**
 * Dev-login as the super-admin and open the waypoints page. Same cookie
 * plumbing as comp-detail.spec.ts.
 */
test.beforeEach(async ({ page }) => {
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: SUPER_ADMIN,
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(
      `Dev login failed: ${loginRes.status()} ${loginRes.statusText()} — ${body}`
    );
  }
  const setCookieHeader = loginRes.headers()["set-cookie"];
  if (setCookieHeader) {
    const tokenMatch = setCookieHeader.match(/better-auth\.session_token=([^;]+)/);
    if (tokenMatch) {
      await page.context().addCookies([
        {
          name: "better-auth.session_token",
          value: tokenMatch[1],
          domain: "localhost",
          path: "/",
        },
      ]);
    }
  }

  await page.goto(`/comp/${compId}/waypoints`);
  await expect(page.getByRole("heading", { level: 1, name: "Waypoints" })).toBeVisible();
  // Admin affordances appear once /api/auth/me + the comp fetch resolve — the
  // Upload button is the sync point that the admin view is active.
  await expect(page.getByRole("button", { name: "Upload file" })).toBeVisible({
    timeout: 15_000,
  });
  // And wait for the editor to SETTLE, not merely to appear. The list is keyed
  // by row id and the page rebuilds those ids when the waypoint fetch lands,
  // so every row detaches a moment after the first paint. A test whose first
  // act is a click (rather than an auto-retrying assertion) caught that and
  // spent its whole timeout on "element was detached from the DOM, retrying".
  await expect(
    page.getByRole("grid", { name: "Edit waypoints" }).getByRole("row")
  ).toHaveCount(waypoints.length, { timeout: 15_000 });
});

/** Watches for any mutating call to the competition API for the page's life. */
function trackMutations(page: Page): () => boolean {
  let mutated = false;
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/comp")) mutated = true;
  });
  return () => mutated;
}

/** The editor list's rows, and the altitude review's. Both are RAC GridLists. */
const editorRows = (page: Page) =>
  page.getByRole("grid", { name: "Edit waypoints" }).getByRole("row");
const reviewRows = (page: Page) =>
  page.getByRole("grid", { name: "Waypoints to look at" }).getByRole("row");

async function firstWaypointRow(page: Page): Promise<Locator> {
  const row = editorRows(page).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** The row for one waypoint code. */
const waypointRow = (page: Page, code: string) =>
  editorRows(page).filter({ hasText: code }).first();

/**
 * The device-export panel's trigger. Its LABEL depends on the pointer: a
 * coarse pointer gets hosted links to open in a flight app, a fine one gets a
 * client-side download menu (WaypointDeviceExport). Tests that only care that
 * the panel is there match either.
 */
const deviceExportButton = (page: Page) =>
  page.getByRole("button", {
    name: /Download waypoints|Open waypoints in a flight app/,
  });

/** Open one waypoint's sheet, set a field, and apply it on the way out. */
async function editWaypoint(
  page: Page,
  row: Locator,
  field: "Code" | "Name" | "Coordinates" | "Altitude (m)" | "Radius (m)",
  value: string
) {
  await row.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { level: 2 })).toBeVisible();
  await sheet.getByRole("textbox", { name: field, exact: true }).fill(value);
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("the editor lists waypoints, edits in a sheet, and blocks bad coords", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  // The editor is a LIST at every width — no Tabulator, and nothing scrolls
  // sideways. The read-only RAC table is the anonymous view and is gone here.
  await expect(page.locator(".tabulator")).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Waypoints", exact: true })).toHaveCount(0);
  const firstRow = await firstWaypointRow(page);
  await expect(firstRow).toContainText(waypoints[0].code);
  // Everything a waypoint has is ON its row, the altitude included — the one
  // thing the grid could not do at a phone's width.
  await expect(firstRow).toContainText(
    waypoints[0].altitude === undefined ? "no altitude" : `${waypoints[0].altitude} m`
  );
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(scrolls, "the page must not scroll sideways").toBe(false);

  // React state drives the count line and the pristine Save button.
  await expect(page.getByText(`${waypoints.length} waypoints`)).toBeVisible();
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveButton).toBeDisabled();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // A row opens one waypoint, with every field it has.
  await firstRow.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: waypoints[0].code })).toBeVisible();
  for (const label of ["Code", "Name", "Coordinates", "Altitude (m)", "Radius (m)"]) {
    await expect(sheet.getByRole("textbox", { name: label, exact: true })).toBeVisible();
  }
  // No second way to look at the same point: the row's pin does that.
  await expect(sheet.getByRole("button", { name: "Show on the map" })).toHaveCount(0);

  // The draft applies on the way out and the page turns dirty.
  await sheet.getByRole("textbox", { name: "Name", exact: true }).fill("E2E Waypoint");
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(await firstWaypointRow(page)).toContainText("E2E Waypoint");
  await expect(saveButton).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // A radius chip is a one-tap answer to the field beside it.
  await (await firstWaypointRow(page)).click();
  await page.getByRole("dialog").getByRole("button", { name: "5 km" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  // formatCylinderRadius's own spelling, as the read-only table prints it.
  await expect(await firstWaypointRow(page)).toContainText("5km");

  // A number field commits on the way out even without an explicit blur, or
  // the value would be lost silently.
  await editWaypoint(page, await firstWaypointRow(page), "Altitude (m)", "321");
  await expect(await firstWaypointRow(page)).toContainText("321 m");

  // Garbage coordinates flag the row and the count line…
  await editWaypoint(page, await firstWaypointRow(page), "Coordinates", "not coordinates");
  await expect(await firstWaypointRow(page)).toContainText("invalid");
  await expect(page.getByText("1 need valid coordinates")).toBeVisible();

  // …and Save refuses (client-side) instead of PUTting bad data.
  await saveButton.click();
  await expect(
    page.getByText("Every waypoint needs valid coordinates before saving")
  ).toBeVisible();

  expect(mutated()).toBe(false);
});

/**
 * Back closes one layer at a time.
 *
 * The sheets are React state, not routes — the page behind them is unsaved
 * work, so a sibling route would unmount it and the unsaved-changes guard
 * would prompt on the way in. That left them invisible to the history stack,
 * and one Back from a waypoint's details left the whole editor. Each sheet
 * now owns a history entry (lib/use-back-dismiss.ts) and pops it again on the
 * way out.
 */
test("the browser back button closes a sheet, not the page", async ({ page }) => {
  const mutated = trackMutations(page);
  const url = page.url();

  // One sheet: back closes it and stays on the page.
  await (await firstWaypointRow(page)).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(url);
  await expect(await firstWaypointRow(page)).toBeVisible();

  // Closing from the UI leaves the stack as it was found, so the NEXT back
  // still goes nowhere unexpected: open, Done, then back stays on the page.
  await (await firstWaypointRow(page)).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(url);
  await page.goForward();
  await expect(page).toHaveURL(url);

  expect(mutated()).toBe(false);
});

test("remove a row and add one via the RAC dialog (nothing saved)", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  const firstRow = await firstWaypointRow(page);
  const firstCode = waypoints[0].code;
  await expect(firstRow).toContainText(firstCode);

  // Remove the first waypoint: the count line (React state) drops by one.
  // The grid has a ✕ on the row; the phone editor removes from the sheet,
  // which is where every other field of that waypoint lives too.
  await firstRow.click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Remove this waypoint" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(`${waypoints.length - 1} waypoints`)).toBeVisible();
  await expect(await firstWaypointRow(page)).not.toContainText(firstCode);

  // Add a waypoint through the shared RAC dialog. Nothing joins the API until
  // Save — this stays a client-side row.
  await page.getByRole("button", { name: "Add waypoint" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add waypoint" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Code" }).fill("E2E1");
  await dialog
    .getByRole("textbox", { name: "Coordinates (lat, lon)" })
    .fill("-36.5, 148.2");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Back to the original count, and the grid scrolled the new row into view.
  await expect(page.getByText(`${waypoints.length} waypoints`)).toBeVisible();
  await expect(waypointRow(page, "E2E1")).toBeVisible();

  expect(mutated()).toBe(false);
});

test("save round-trip persists an edit, restore leaves the comp as found", async ({
  page,
}) => {
  // Capture the original set so the finally block can put it back verbatim.
  const origRes = await page.request.get(`/api/comp/${compId}/waypoints`);
  expect(origRes.ok()).toBe(true);
  const original = (await origRes.json()) as { waypoints: Waypoint[] };

  try {
    await editWaypoint(page, await firstWaypointRow(page), "Name", "E2E Renamed");

    const putDone = page.waitForResponse(
      (r) => r.url().includes("/waypoints") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await putDone).ok()).toBe(true);
    // The saved values are the new baseline: clean page, disabled button.
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByText("Unsaved changes")).toBeHidden();

    // A reload proves it persisted (the editor rebuilds from the API).
    await page.reload();
    await expect(await firstWaypointRow(page)).toContainText("E2E Renamed");
  } finally {
    const restore = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: original.waypoints },
    });
    expect(restore.ok()).toBe(true);
  }
});

test("device export: download menu lists every format, QR + swap toggle", async ({
  page,
  isMobile,
}) => {
  // A coarse pointer gets "Open in app" with hosted links instead of the
  // client-side download menu (WaypointDeviceExport), so the menu this
  // asserts on is the fine-pointer one.
  test.skip(!!isMobile, "a coarse pointer gets Open in app, not the download menu");
  const mutated = trackMutations(page);

  // Desktop (fine pointer) shows the client-side "Download" menu.
  await page.getByRole("button", { name: "Download waypoints" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // All 8 engine export formats (WAYPOINT_EXPORT_FORMATS).
  await expect(menu.getByRole("menuitem")).toHaveCount(8);
  await expect(menu.getByRole("menuitem", { name: "SeeYou (.cup)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // QR toggles on (caption + code render) and off again.
  await page.getByRole("button", { name: "QR code" }).click();
  await expect(page.getByText(/Scan with XCTrack, Flyskyhy/)).toBeVisible();
  await page.getByRole("button", { name: "Hide QR" }).click();
  await expect(page.getByText(/Scan with XCTrack, Flyskyhy/)).toHaveCount(0);

  // Swap checkbox: click the label text, read state by role (gotcha #13).
  const swap = page.getByRole("checkbox", { name: /Swap code & name/ });
  await expect(swap).not.toBeChecked();
  await page.getByText(/Swap code & name/).click();
  await expect(swap).toBeChecked();

  expect(mutated()).toBe(false);
});

test("navigating away from unsaved waypoints is guarded", async ({ page }) => {
  const mutated = trackMutations(page);
  await editWaypoint(page, await firstWaypointRow(page), "Name", "E2E Unsaved");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Keep editing: the navigation is cancelled and the edit survives.
  await page.getByRole("link", { name: "Competitions" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("This page has unsaved changes. Leaving will discard them.")
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/waypoints$/);
  await expect(await firstWaypointRow(page)).toContainText("E2E Unsaved");

  // Discard: the navigation proceeds and nothing was ever sent to the API.
  await page.getByRole("link", { name: "Competitions" }).first().click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(page).toHaveURL(/\/comp$/);

  expect(mutated()).toBe(false);
});

test("the map maximises into a full-screen sheet with its own Add from map", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  await page.getByRole("button", { name: "Maximise" }).click();
  const sheet = page.getByRole("dialog", { name: "Waypoint map" });
  await expect(sheet).toBeVisible();

  // The pane's own copy of the control stands down while the sheet holds the
  // map: exactly one Add-from-map toggle on the page, and it is in the sheet.
  await expect(page.getByRole("button", { name: "Add from map" })).toHaveCount(1);
  await sheet.getByRole("button", { name: "Add from map" }).click();
  await expect(sheet.getByRole("button", { name: /Tap the map to place/ })).toBeVisible();

  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Maximise" })).toBeVisible();

  expect(mutated()).toBe(false);
});

test("the device panel follows the SAVED set, not the editor's rows", async ({
  page,
}) => {
  // A file parsed into the grid is not yet on the server, so the panel — whose
  // links are hosted endpoints — must not offer it. Emptied and restored via
  // the API, like the save round-trip above.
  const origRes = await page.request.get(`/api/comp/${compId}/waypoints`);
  expect(origRes.ok()).toBe(true);
  const original = (await origRes.json()) as { waypoints: Waypoint[] };

  try {
    const emptied = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: [] },
    });
    expect(emptied.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Upload file" })).toBeVisible({
      timeout: 15_000,
    });

    // Nothing published: no panel, and the editor's own job is what's left.
    await expect(deviceExportButton(page)).toHaveCount(0);
    await expect(page.getByText("Get these waypoints on your device")).toHaveCount(0);

    // Adding a waypoint in the editor does NOT bring it back — only a save does.
    await page.getByRole("button", { name: "Add waypoint" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Code" }).fill("E2E2");
    await dialog
      .getByRole("textbox", { name: "Coordinates (lat, lon)" })
      .fill("-36.5, 148.2");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await expect(deviceExportButton(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(deviceExportButton(page)).toBeVisible();
  } finally {
    const restore = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: original.waypoints },
    });
    expect(restore.ok()).toBe(true);
  }
});

/**
 * The altitude review, over flat ground at a height no Corryong waypoint sits
 * at — so every waypoint disagrees with the map by a known amount and the
 * review must find them all.
 *
 * 4000 m is chosen to be far above the whole set (the highest Corryong
 * waypoint is under 1000 m), which puts every row past the
 * coordinate-suspicion threshold. That is the point: the flagging, the
 * accept and the way out are what this asserts, and they are the parts a real
 * DEM cannot make deterministic.
 *
 * The review is a SHEET at every width now, so this runs in both projects.
 */
test("Check altitudes reviews the set in a sheet and accepts one row", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  // alpha 128: the coastal no-data case. Read off a canvas this same pixel
  // comes back thousands of metres out (a Great Ocean Road waypoint read
  // 13273 m); the elevation the review shows must be 4000 regardless.
  await stubTerrainElevations(page.context(), 4000, 128);

  await firstWaypointRow(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Check altitudes" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Check altitudes" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(sheet.getByRole("status")).toContainText(
    `${waypoints.length} of ${waypoints.length} waypoints to look at`
  );
  await expect(sheet).toContainText("check the coordinates");
  // Corrections here do not reach into tasks already built — the sheet says so.
  await expect(sheet).toContainText("Tasks already built keep their own copy");

  // Biggest disagreement first. Against flat ground that is the LOWEST
  // waypoint, and its row states BOTH altitudes — the failure this design
  // replaces was a reader who could only see one of them.
  const lowest = Math.min(...waypoints.map((w) => w.altitude ?? 0));
  const topRow = reviewRows(page).first();
  await expect(topRow).toContainText(`file ${lowest} m`);
  await expect(topRow).toContainText("map 4000 m");

  // Accepting one row takes the map's value, as an ordinary unsaved edit.
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveButton).toBeDisabled();
  await topRow.getByRole("button", { name: "Use 4000 m" }).click();
  // The row STAYS in the list rather than vanishing under the thumb, and now
  // agrees with the map — with no "0 m" beside it, because a difference of
  // zero is the absence of a finding rather than one worth printing.
  await expect(topRow).toContainText("file 4000 m");
  // A signed delta is what a finding looks like; there must be none.
  await expect(topRow).not.toContainText(/[+-]\d+\s*m/);
  await expect(saveButton).toBeEnabled();

  // Done closes the sheet and the edit survives as an unsaved change.
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(saveButton).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // A review reads the map, never the API.
  expect(mutated()).toBe(false);
});

test("a review row opens one waypoint, with both altitudes and no map", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  await stubTerrainElevations(page.context(), 4000, 128);

  await firstWaypointRow(page);
  await page.getByRole("button", { name: "Check altitudes" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Check altitudes" })).toBeVisible({
    timeout: 20_000,
  });

  const lowest = Math.min(...waypoints.map((w) => w.altitude ?? 0));
  await reviewRows(page).first().click();

  // One waypoint: both numbers, labelled, and the difference between them.
  await expect(sheet.getByText("In the file")).toBeVisible();
  await expect(sheet.getByText("From the map")).toBeVisible();
  await expect(sheet).toContainText(`${lowest} m`);
  await expect(sheet).toContainText("4000 m");
  await expect(sheet).toContainText("apart");
  // No map in this view (decided deliberately: the page owns one Mapbox
  // instance and hands it between the pane and the full-screen map).
  await expect(sheet.locator(".mapboxgl-canvas")).toHaveCount(0);

  // The altitude is editable here, which is the alternative to accepting.
  // A NumberField commits on blur rather than per keystroke, which is what
  // tapping anything else in the sheet does anyway.
  const altInput = sheet.getByRole("textbox", { name: "Altitude (m)" });
  await altInput.fill("123");
  await altInput.blur();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  // Back returns to the list, which is the "leave it as it is" path.
  await sheet.getByRole("button", { name: /^All \d+$/ }).click();
  await expect(sheet.getByRole("heading", { name: "Check altitudes" })).toBeVisible();

  // And so does Done, from this view. It used to close the whole sheet, which
  // dropped the reader out to the waypoints page half way down a list of
  // twelve: "done with this waypoint" is not "done with the check".
  await reviewRows(page).first().click();
  await expect(sheet.getByText("In the file")).toBeVisible();
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(sheet.getByRole("heading", { name: "Check altitudes" })).toBeVisible();

  // Back walks one layer at a time too: into a waypoint, back to the list,
  // back to the page.
  await reviewRows(page).first().click();
  await expect(sheet.getByText("In the file")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Check altitudes" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(await firstWaypointRow(page)).toBeVisible();

  expect(mutated()).toBe(false);
});

test("typing a coordinate in the review keeps the comparison on screen", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  await stubTerrainElevations(page.context(), 4000, 128);

  await firstWaypointRow(page);
  await page.getByRole("button", { name: "Check altitudes" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Check altitudes" })).toBeVisible({
    timeout: 20_000,
  });

  await reviewRows(page).first().click();
  // Which waypoint that is depends on the disagreements, so read it off the
  // heading rather than assuming the editor's first row.
  const code = (await sheet.getByRole("heading", { level: 2 }).textContent()) ?? "";
  const accept = sheet.getByRole("button", { name: /^Use the map’s altitude/ });
  await expect(accept).toBeVisible();

  // Moving the waypoint makes its terrain reading stale, so the page forgets
  // the reading whenever the coordinates change — which per keystroke used to
  // destroy the comparison this view exists to show. The first character
  // typed took the map's altitude away, so "From the map" fell to "—", the
  // difference line vanished and the accept button unmounted, mid-paste. The
  // field is a draft now, so type a character at a time and none of that
  // moves.
  const coords = sheet.getByRole("textbox", { name: "Coordinates" });
  await coords.fill("");
  await coords.pressSequentially("-36.61234, 146.61234", { delay: 10 });
  await expect(sheet).toContainText("4000 m");
  await expect(sheet).toContainText("apart");
  await expect(accept).toBeVisible();
  await expect(sheet.getByText("Enter coordinates as")).toHaveCount(0);

  // Applied on the way out, once — and the stale reading goes with it, which
  // is what the row underneath now says.
  await sheet.getByRole("button", { name: /^All \d+$/ }).click();
  await expect(sheet.getByRole("heading", { name: "Check altitudes" })).toBeVisible();
  await expect(reviewRows(page).first()).toContainText("no map reading");

  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(waypointRow(page, code)).toContainText("-36.61234");

  expect(mutated()).toBe(false);
});

test("the review narrows to the rows worth looking at, and can widen again", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  // Flat ground AT one of the set's own altitudes, so some rows agree and the
  // rest do not — which is what the narrowing is for.
  const altitudes = waypoints.map((w) => w.altitude ?? 0);
  const commonest = [...altitudes]
    .sort(
      (a, b) =>
        altitudes.filter((x) => x === b).length - altitudes.filter((x) => x === a).length
    )[0];
  await stubTerrainElevations(page.context(), commonest);
  const agreeing = altitudes.filter((a) => Math.abs(a - commonest) < 50).length;
  const toLookAt = waypoints.length - agreeing;
  // The fixture only makes sense if the set really is mixed.
  expect(toLookAt).toBeGreaterThan(0);
  expect(agreeing).toBeGreaterThan(0);

  await firstWaypointRow(page);
  await page.getByRole("button", { name: "Check altitudes" }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("status")).toContainText(
    `${toLookAt} of ${waypoints.length} waypoints to look at`,
    { timeout: 20_000 }
  );
  await expect(sheet).toContainText(`${agreeing} agree`);

  // Narrowed by default: the agreeing rows are counted, not listed.
  await expect(reviewRows(page)).toHaveCount(toLookAt);
  const widen = sheet.getByRole("button", { name: `Show all ${waypoints.length} waypoints` });
  await expect(widen).toBeVisible();
  await widen.click();
  await expect(reviewRows(page)).toHaveCount(waypoints.length);
  await sheet
    .getByRole("button", { name: `Show only the ${toLookAt} to look at` })
    .click();
  await expect(reviewRows(page)).toHaveCount(toLookAt);

  // Accept the lot: every disagreement goes, and it is all one unsaved edit.
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveButton).toBeDisabled();
  await sheet
    .getByRole("button", { name: `Use the map’s altitude for all ${toLookAt}` })
    .click();
  await expect(saveButton).toBeEnabled();
  await expect(sheet.getByRole("status")).toContainText("agrees with the map");

  expect(mutated()).toBe(false);
});

test("anonymous visitors get the read-only table, no admin controls", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Waypoints" })).toBeVisible();

  // The read-only RAC table, with real content.
  const table = page.getByRole("grid", { name: "Waypoints", exact: true });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(
    table.getByRole("rowheader", { name: waypoints[0].code }).first()
  ).toBeVisible();

  // No admin chrome, no Tabulator.
  await expect(page.getByRole("button", { name: "Upload file" })).toHaveCount(0);
  await expect(page.locator(".tabulator")).toHaveCount(0);

  // The device-export panel is for everyone.
  await expect(deviceExportButton(page)).toBeVisible();
});
