/**
 * Comp waypoints page (/comp/:id/waypoints) — interaction coverage for its
 * RAC + Tabulator surfaces (converted 2026-07-21, see
 * docs/2026-07-18-rac-adoption-guide.md):
 *
 * - Admins get an inline **Tabulator** editable grid (the app's standard for
 *   editable tables — Tabulator policy). Cell edits mirror into React state
 *   (the "N waypoints" count, dirty Save button, coordinate validation).
 * - Save lives in the page's fixed bottom bar beside an "Unsaved changes"
 *   hint, and while dirty a navigation guard offers Discard/Keep editing —
 *   the comp-settings behaviour (settings-save-ux.spec.ts), brought here
 *   after an admin lost a set of added waypoints to a tap on a link.
 * - The map maximises into a full-screen sheet carrying its own Add-from-map
 *   toggle, so several points can be placed from a phone-sized map.
 * - "Check altitudes" compares the whole set against the map's terrain and
 *   turns the grid into a review: two derived columns, a per-row accept, a
 *   snapshot-narrowed list and a live-region banner. Driven against a FLAT
 *   synthetic DEM (stubTerrainElevations), so every disagreement in the test
 *   is arithmetic the test chose rather than whatever the real terrain says.
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
 * RAC/Tabulator testing gotchas honoured here (rac-adoption-guide):
 * - Never wait on "networkidle" (freshness pollers elsewhere; DOM waits only).
 * - RAC checkboxes can't be *clicked* by role — the real input is visually
 *   hidden. Click the label text, assert by role (gotcha #13).
 * - The Tabulator grid renders rows virtually: only visible rows exist in the
 *   DOM, so counts are asserted via the page's "N waypoints" line (React
 *   state), not by counting .tabulator-row elements.
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
});

/** Watches for any mutating call to the competition API for the page's life. */
function trackMutations(page: Page): () => boolean {
  let mutated = false;
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/comp")) mutated = true;
  });
  return () => mutated;
}

/** The (lazy-loaded) Tabulator grid's first row, once it has built. */
async function firstGridRow(page: Page): Promise<Locator> {
  const row = page.locator(".gc-grid .tabulator-row").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** Commit a value into a Tabulator input-editor cell (click → type → Enter). */
async function editCell(cell: Locator, value: string) {
  await cell.click();
  const editor = cell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill(value);
  await editor.press("Enter");
}

/**
 * The page has TWO editors, chosen by width: the Tabulator grid at 64rem and
 * up, a list of waypoints opening full-screen sheets below it (the grid scrolls
 * sideways on a phone and hides its own altitude column behind the frozen Code
 * column — see comp/WaypointList.tsx). Tests that are about editing a waypoint
 * rather than about either editor go through these, so they mean the same thing
 * in both projects.
 */
/** The editor list's rows, and the review sheet's. Both are RAC GridLists. */
const editorRows = (page: Page) =>
  page.getByRole("grid", { name: "Edit waypoints" }).getByRole("row");
const reviewRows = (page: Page) =>
  page.getByRole("grid", { name: "Waypoints to look at" }).getByRole("row");

/**
 * The device-export panel's trigger. Its LABEL depends on the pointer, not on
 * the editor: a coarse pointer gets hosted links to open in a flight app, a
 * fine one gets a client-side download menu (WaypointDeviceExport). Tests that
 * only care that the panel is there match either.
 */
const deviceExportButton = (page: Page) =>
  page.getByRole("button", {
    name: /Download waypoints|Open waypoints in a flight app/,
  });

/**
 * Which editor is on screen — after WAITING for one to arrive.
 *
 * Not a bare count(): the grid is lazily imported and builds a tick or two
 * after mount, so an instant check races it and reports "no grid" on a wide
 * screen. Waiting on the union of the two selectors settles either way.
 */
async function usingGrid(page: Page): Promise<boolean> {
  const anyRow = page.locator(
    ".gc-grid .tabulator-row, [aria-label='Edit waypoints'] [role='row']"
  );
  await expect(anyRow.first()).toBeVisible({ timeout: 15_000 });
  return (await page.locator(".gc-grid .tabulator-row").count()) > 0;
}

async function firstWaypointRow(page: Page): Promise<Locator> {
  if (await usingGrid(page)) return firstGridRow(page);
  return editorRows(page).first();
}

/** The row for one waypoint code, in whichever editor. */
async function waypointRow(page: Page, code: string): Promise<Locator> {
  return (await usingGrid(page))
    ? page.locator('.gc-grid .tabulator-row', { hasText: code }).first()
    : editorRows(page).filter({ hasText: code }).first();
}

/** Set one field of the first waypoint, whichever editor is on screen. */
async function editFirstWaypoint(
  page: Page,
  field: "code" | "name" | "coords" | "altitude" | "radius",
  value: string
) {
  if (await usingGrid(page)) {
    const row = await firstGridRow(page);
    await editCell(row.locator(`[tabulator-field="${field}"]`), value);
    return;
  }
  const row = await firstWaypointRow(page);
  await row.click();
  const sheet = page.getByRole("dialog");
  const label = {
    code: "Code",
    name: "Name",
    coords: "Coordinates",
    altitude: "Altitude (m)",
    radius: "Radius (m)",
  }[field];
  await expect(sheet.getByRole("heading", { level: 2 })).toBeVisible();
  await sheet.getByRole("textbox", { name: label, exact: true }).fill(value);
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** What the first waypoint's row shows for a field, in either editor. */
async function firstWaypointText(page: Page): Promise<string> {
  const row = await firstWaypointRow(page);
  return (await row.innerText()).replace(/\s+/g, " ").trim();
}

test("admin grid: Tabulator builds, edits mirror to state, bad coords block save", async ({
  page,
  isMobile,
}) => {
  // This one is ABOUT the Tabulator grid, which is the wide-screen editor.
  // The phone's list-and-sheet editor has its own test below.
  test.skip(!!isMobile, "the Tabulator grid is the wide-screen editor");
  const mutated = trackMutations(page);

  const firstRow = await firstGridRow(page);
  // The admin view is the Tabulator grid — the read-only RAC table is gone.
  await expect(page.getByRole("grid", { name: "Waypoints" })).toHaveCount(0);
  // React state drives the count line and the pristine Save button.
  await expect(page.getByText(`${waypoints.length} waypoints`)).toBeVisible();
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveButton).toBeDisabled();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // An in-grid edit mirrors into React state: the Save button turns dirty.
  await editCell(firstRow.locator('[tabulator-field="name"]'), "E2E Waypoint");
  await expect(firstRow.locator('[tabulator-field="name"]')).toHaveText("E2E Waypoint");
  await expect(saveButton).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Garbage coordinates flag the cell and the count line…
  const coordsCell = firstRow.locator('[tabulator-field="coords"]');
  await editCell(coordsCell, "not coordinates");
  await expect(coordsCell).toHaveClass(/gc-cell-invalid/);
  await expect(page.getByText("1 need valid coordinates")).toBeVisible();

  // …and Save refuses (client-side) instead of PUTting bad data.
  await saveButton.click();
  await expect(
    page.getByText("Every waypoint needs valid coordinates before saving")
  ).toBeVisible();

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
  if (await usingGrid(page)) {
    await firstRow.locator('span[title="Remove waypoint"]').click();
  } else {
    await firstRow.click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Remove this waypoint" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
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
  await expect(await waypointRow(page, "E2E1")).toBeVisible();

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
    await editFirstWaypoint(page, "name", "E2E Renamed");

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
  await editFirstWaypoint(page, "name", "E2E Unsaved");
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
  // agrees with the map.
  await expect(topRow).toContainText("file 4000 m");
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

/**
 * The phone editor. Not a variant of the grid test: the whole point is that
 * there is no grid here, nothing scrolls sideways, and a waypoint's own
 * altitude is on its row rather than behind a frozen column.
 */
test("the phone editor lists waypoints and edits one in a sheet", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "the list-and-sheet editor is the narrow-screen editor");
  const mutated = trackMutations(page);

  // No Tabulator at this width, and no sideways scrolling anywhere.
  await expect(page.locator(".tabulator")).toHaveCount(0);
  const row = await firstWaypointRow(page);
  await expect(row).toContainText(waypoints[0].code);
  // The altitude is ON the row — this is the thing the grid could not do.
  await expect(row).toContainText(
    waypoints[0].altitude === undefined ? "no altitude" : `${waypoints[0].altitude} m`
  );
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(scrolls, "the page must not scroll sideways on a phone").toBe(false);

  // A row opens one waypoint, with every field it has.
  await row.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: waypoints[0].code })).toBeVisible();
  for (const label of ["Code", "Name", "Coordinates"]) {
    await expect(sheet.getByRole("textbox", { name: label, exact: true })).toBeVisible();
  }
  await expect(sheet.getByRole("textbox", { name: "Altitude (m)" })).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "Radius (m)" })).toBeVisible();

  // The draft applies on the way out, and the page turns dirty.
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveButton).toBeDisabled();
  await sheet.getByRole("textbox", { name: "Name", exact: true }).fill("E2E Phone Edit");
  await sheet.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(await firstWaypointRow(page)).toContainText("E2E Phone Edit");
  await expect(saveButton).toBeEnabled();

  // A radius chip is a one-tap answer to the field beside it.
  await (await firstWaypointRow(page)).click();
  await page.getByRole("dialog").getByRole("button", { name: "5 km" }).click();
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "Radius (m)" })).toHaveValue(
    "5000"
  );
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  // formatCylinderRadius's own spelling, the same one the read-only table uses.
  await expect(await firstWaypointRow(page)).toContainText("5km");

  // And the risky path: type an altitude, then tap Done WITHOUT blurring
  // first. The number field commits on the way out or the value is lost.
  await (await firstWaypointRow(page)).click();
  const sheet2 = page.getByRole("dialog");
  await sheet2.getByRole("textbox", { name: "Altitude (m)" }).fill("321");
  await sheet2.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(await firstWaypointRow(page)).toContainText("321 m");

  expect(mutated()).toBe(false);
});

test("anonymous visitors get the read-only table, no admin controls", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Waypoints" })).toBeVisible();

  // The read-only RAC table, with real content.
  const table = page.getByRole("grid", { name: "Waypoints" });
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
