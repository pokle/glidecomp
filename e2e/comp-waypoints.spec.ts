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

test("admin grid: Tabulator builds, edits mirror to state, bad coords block save", async ({
  page,
}) => {
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

  const firstRow = await firstGridRow(page);
  const firstCode = (
    await firstRow.locator('[tabulator-field="code"]').innerText()
  ).trim();

  // Remove the first row: the count line (React state) drops by one.
  await firstRow.locator('span[title="Remove waypoint"]').click();
  await expect(page.getByText(`${waypoints.length - 1} waypoints`)).toBeVisible();
  await expect(
    page.locator('.gc-grid .tabulator-row [tabulator-field="code"]').first()
  ).not.toHaveText(firstCode);

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
  await expect(
    page.locator('.gc-grid .tabulator-row [tabulator-field="code"]', {
      hasText: "E2E1",
    })
  ).toBeVisible();

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
    const firstRow = await firstGridRow(page);
    await editCell(firstRow.locator('[tabulator-field="name"]'), "E2E Renamed");

    const putDone = page.waitForResponse(
      (r) => r.url().includes("/waypoints") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await putDone).ok()).toBe(true);
    // The saved values are the new baseline: clean page, disabled button.
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(page.getByText("Unsaved changes")).toBeHidden();

    // A reload proves it persisted (the grid rebuilds from the API).
    await page.reload();
    const reloadedRow = await firstGridRow(page);
    await expect(reloadedRow.locator('[tabulator-field="name"]')).toHaveText(
      "E2E Renamed"
    );
  } finally {
    const restore = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: original.waypoints },
    });
    expect(restore.ok()).toBe(true);
  }
});

test("device export: download menu lists every format, QR + swap toggle", async ({
  page,
}) => {
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
  const firstRow = await firstGridRow(page);

  await editCell(firstRow.locator('[tabulator-field="name"]'), "E2E Unsaved");
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
  await expect(firstRow.locator('[tabulator-field="name"]')).toHaveText("E2E Unsaved");

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
    await expect(page.getByRole("button", { name: "Download waypoints" })).toHaveCount(0);
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
    await expect(page.getByRole("button", { name: "Download waypoints" })).toHaveCount(0);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download waypoints" })).toBeVisible();
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
 * accept, the narrowing and the way out are what this asserts, and they are
 * the parts a real DEM cannot make deterministic.
 */
test("Check altitudes reviews the set in the grid and accepts one row", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  await stubTerrainElevations(page.context(), 4000);

  await firstGridRow(page);
  // Before the check the comparison columns are hidden. Tabulator builds them
  // with the grid (so entering the review costs no rebuild) and keeps their
  // cells in the DOM, so this is a visibility check rather than a count.
  const deltaCol = page.locator('.gc-grid .tabulator-col[tabulator-field="delta"]');
  await expect(deltaCol).toBeHidden();

  await page.getByRole("button", { name: "Check altitudes" }).click();

  // The banner reports the finding, and the whole set is flagged.
  const banner = page.getByRole("status").filter({ hasText: "to look at" });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText(`${waypoints.length} waypoints to look at`);
  await expect(banner).toContainText("check the coordinates first");
  // Corrections here do not reach into tasks already built — the review says so.
  await expect(banner).toContainText("Tasks already built keep their own copy");

  // The comparison columns are now in the grid, beside the altitude.
  await expect(page.locator('.gc-grid .tabulator-col[tabulator-field="mapAlt"]')).toBeVisible();
  await expect(deltaCol).toBeVisible();

  // Biggest disagreement first. Against flat ground that is the LOWEST
  // waypoint, whichever of them it is if several share the altitude.
  const lowest = Math.min(...waypoints.map((w) => w.altitude ?? 0));
  const firstRow = await firstGridRow(page);
  await expect(firstRow.locator('[tabulator-field="altitude"]')).toHaveText(String(lowest));

  // Flat 4000 m ground: the map column reads 4000 and every Δ is negative.
  const mapCell = firstRow.locator('[tabulator-field="mapAlt"]');
  await expect(mapCell).toHaveText("4000");
  const deltaCell = firstRow.locator('[tabulator-field="delta"]');
  // Past the coordinate threshold the delta carries a visible "!", so the
  // warning does not live in the colour alone.
  await expect(deltaCell).toContainText("!");
  await expect(deltaCell.locator(".gc-cell-alert")).toBeVisible();

  // Accepting one row takes the map's value into the editable altitude cell,
  // which is an ordinary unsaved edit.
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveButton).toBeDisabled();
  await firstRow.locator('[tabulator-field="accept"] span').click();
  await expect(firstRow.locator('[tabulator-field="altitude"]')).toHaveText("4000");
  await expect(saveButton).toBeEnabled();
  // Its disagreement is gone, and the row STAYS in the list rather than
  // vanishing under the cursor.
  await expect(deltaCell).toHaveText("0");

  // Done puts the grid back, and the accepted edit survives as an unsaved
  // change. Not asserted on `firstRow`: leaving the review clears the sort,
  // so the first row is a different waypoint again (and the accepted one,
  // being the lowest, may not even be among the rows Tabulator renders).
  await page.getByRole("button", { name: "Done" }).click();
  await expect(deltaCol).toBeHidden();
  await expect(page.locator('.gc-grid .tabulator-col[tabulator-field="mapAlt"]')).toBeHidden();
  await expect(saveButton).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // A review reads the map, never the API.
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

  await firstGridRow(page);
  await page.getByRole("button", { name: "Check altitudes" }).click();

  const banner = page.getByRole("status").filter({ hasText: "to look at" });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner).toContainText(`${toLookAt} waypoints to look at`);
  await expect(banner).toContainText(`${agreeing} agree`);

  // Narrowed by default: the agreeing rows are counted, not listed.
  const widen = page.getByRole("button", { name: `Show all ${waypoints.length} waypoints` });
  await expect(widen).toBeVisible();
  await widen.click();
  await expect(
    page.getByRole("button", { name: `Show only the ${toLookAt} to look at` })
  ).toBeVisible();
  // Back to the narrowed list, so "all shown" means the rows to look at.
  await page.getByRole("button", { name: `Show only the ${toLookAt} to look at` }).click();
  await expect(widen).toBeVisible();

  // Accept the lot: every disagreement goes, and it is all one unsaved edit.
  const saveButton = page.getByRole("button", { name: "Save", exact: true });
  await expect(saveButton).toBeDisabled();
  await page.getByRole("button", { name: "Use the map’s altitude for all shown" }).click();
  await expect(saveButton).toBeEnabled();
  await expect(
    page.getByRole("status").filter({ hasText: "agrees with the map" })
  ).toBeVisible();

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
  await expect(page.getByRole("button", { name: "Download waypoints" })).toBeVisible();
});
