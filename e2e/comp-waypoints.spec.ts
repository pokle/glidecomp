/**
 * Comp waypoints (/comp/:id/waypoints) and the editor's pages under it. Runs
 * in BOTH Playwright projects (see e2e/fixtures/mobile.ts):
 *
 * - Admins get a LIST of waypoints at every width. The Tabulator grid this
 *   replaced on 2026-09-19 is gone rather than hidden behind a breakpoint (the
 *   mobile-first rule in CLAUDE.md), so the tests assert `.tabulator` is
 *   absent and that the page never scrolls sideways.
 * - A row opens that waypoint's PAGE (/waypoints/:n), where it opened a
 *   full-screen sheet until #811. Add waypoint (/waypoints/new) and the map
 *   at full size (/waypoints/map) are pages too. Each is left by the
 *   browser's Back or the bar's, and a waypoint's Done returns to the list.
 * - Every action is in the page's bar (issue #863): Save is its commit
 *   button, and the rest are rows of ⋯ ("More actions").
 * - What they edit is a DRAFT of the whole file in sessionStorage (#811,
 *   docs/drafts.md), so an edit survives going between the pages and a
 *   reload; Save on the list sends it, and "Discard changes" throws it away.
 * - Leaving the editor by a link with unsaved edits asks first; going
 *   between its own pages does not; Back keeps the draft for later.
 * - Anonymous visitors get the same list, read-only, and are sent to it from
 *   the editor's pages.
 * - The device rows of ⋯ (the download formats behind one row, the QR, the
 *   code/name swap).
 * - One save round-trip against the real API, restored afterwards from the
 *   captured original so the seeded comp is left exactly as found.
 *
 * The altitude review has a spec of its own: waypoint-altitude-review.spec.ts.
 *
 * Every test is mutation-free (trackMutations) except the save round-trips,
 * which restore via the API in a finally block. Each test has a fresh browser
 * context, so a fresh sessionStorage: no draft leaks from one to the next.
 *
 * RAC testing gotchas honoured here (rac-adoption-guide):
 * - Never wait on "networkidle" (freshness pollers elsewhere; DOM waits only).
 * - RAC checkboxes can't be *clicked* by role — the real input is visually
 *   hidden. Click the label text, assert by role (gotcha #13).
 * - `getByRole` matches an accessible name as a SUBSTRING: "Waypoints" also
 *   matches "Edit waypoints", so exact names are passed `exact: true`.
 */
import { test, expect, DESKTOP_ONLY, type Page, type Locator } from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { FRONTEND_URL } from "./fixtures/stack";
import { coordsFields, fillCoords } from "./fixtures/coords";
import {
  COMP_NAME,
  barAction,
  barActionLabels,
  editorRows,
  firstWaypointRow,
  h1,
  onEditorList,
  seededWaypoints,
  signInAsSuperAdmin,
  trackMutations,
  waypointRow,
  waypointUrl,
  type Waypoint,
} from "./fixtures/waypoints";

let compId: string;
let waypoints: Waypoint[];

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  ({ compId, waypoints } = await seededWaypoints(api));
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  await signInAsSuperAdmin(page);
  await page.goto(`/comp/${compId}/waypoints`);
  await expect(h1(page, "Waypoints")).toBeVisible();
  await onEditorList(page, waypoints.length);
});

/**
 * A target a thumb can actually hit.
 *
 * 44 px is the figure both platform guidelines use, and comfortably clears
 * WCAG 2.5.8's 24 px minimum. Measured on the RENDERED box rather than
 * asserted about classes: the locate pin's strip overrides a variant's sizing,
 * and tailwind-merge does NOT resolve `size-*` against `h-*`/`w-*` — so a
 * `size` prop added in good faith later would leave two competing rules and a
 * 28 px target, with every class-level assertion still passing.
 */
async function expectBigEnoughToTap(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box, "the target must be rendered to be measured").not.toBeNull();
  expect(box!.width, "tap target width").toBeGreaterThanOrEqual(44);
  expect(box!.height, "tap target height").toBeGreaterThanOrEqual(44);
}

/**
 * The first device row of ⋯. Its LABEL depends on the pointer: a coarse
 * pointer gets hosted links to open in a flight app, a fine one gets
 * client-side downloads (WaypointDeviceExport).
 */
const DEVICE_FILES = /^(Download|Open in a flight app)$/;

const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true });

/** Open a row's page: its own URL, its code as the heading, no dialog. */
async function openWaypoint(page: Page, row: Locator, code: string): Promise<void> {
  await row.click();
  await expect(page).toHaveURL(waypointUrl);
  await expect(h1(page, code)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Open a row's page, set a field, and press Done. */
async function editWaypoint(
  page: Page,
  row: Locator,
  code: string,
  field: "Code" | "Name" | "Latitude" | "Longitude" | "Altitude (m)" | "Radius (m)",
  value: string
) {
  await openWaypoint(page, row, code);
  await page.getByRole("textbox", { name: field, exact: true }).fill(value);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
}

/**
 * Re-enter the waypoints page through the comp page's title menu, and answer
 * with the comp page's URL — so there is a real in-app page underneath, which
 * is what a reader has.
 */
async function reachWaypointsFromCompPage(page: Page): Promise<string> {
  await page.getByRole("link", { name: `Back to ${COMP_NAME}` }).click();
  await expect(h1(page, COMP_NAME)).toBeVisible();
  const compUrl = page.url();
  await page.getByRole("button", { name: `${COMP_NAME}: go to another page` }).click();
  await page.getByRole("menuitem", { name: "Waypoints", exact: true }).click();
  await onEditorList(page, waypoints.length);
  return compUrl;
}

test("the editor lists waypoints, edits one on its own page, and blocks bad coords", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  const code = waypoints[0].code;

  // The editor is a LIST at every width — no Tabulator, and nothing scrolls
  // sideways. An admin's list is named apart from a visitor's, which is the
  // same component with nothing behind its rows.
  await expect(page.locator(".tabulator")).toHaveCount(0);
  await expect(page.getByRole("grid", { name: "Waypoints", exact: true })).toHaveCount(0);
  const firstRow = await firstWaypointRow(page);
  await expect(firstRow).toContainText(code);
  // Everything a waypoint has is ON its row, the altitude included.
  await expect(firstRow).toContainText(
    waypoints[0].altitude === undefined ? "no altitude" : `${waypoints[0].altitude} m`
  );
  await expectNoSidewaysScroll(page);

  // The locate pin is the row's whole left-hand strip. In the editor the row
  // itself opens the waypoint, so the pin is a genuinely separate action and
  // needs a target of its own — and pressing it must NOT open the page.
  const pin = firstRow.getByRole("button", { name: /Show .* on the map/ });
  await expectBigEnoughToTap(pin);
  const listHref = page.url();
  await pin.click();
  await expect(page).toHaveURL(listHref);

  // React state drives the count line and the pristine Save button.
  await expect(page.getByText(`${waypoints.length} waypoints`)).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // A row opens one waypoint — a page, with every field it has.
  await openWaypoint(page, firstRow, code);
  for (const label of ["Code", "Name", "Latitude", "Longitude", "Altitude (m)", "Radius (m)"]) {
    await expect(page.getByRole("textbox", { name: label, exact: true })).toBeVisible();
  }
  await expectNoSidewaysScroll(page);
  // No second way to look at the same point: the row's pin does that.
  await expect(page.getByRole("button", { name: "Show on the map" })).toHaveCount(0);

  // Done returns to the list, and the edit is there, unsaved.
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("E2E Waypoint");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect(await firstWaypointRow(page)).toContainText("E2E Waypoint");
  await expect(saveButton(page)).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // A radius chip is a one-tap answer to the field beside it.
  await openWaypoint(page, await firstWaypointRow(page), code);
  await page.getByRole("button", { name: "5 km" }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
  // formatCylinderRadius's own spelling.
  await expect(await firstWaypointRow(page)).toContainText("5km");

  // A number field commits on the way out even without an explicit blur.
  await editWaypoint(page, await firstWaypointRow(page), code, "Altitude (m)", "321");
  await expect(await firstWaypointRow(page)).toContainText("321 m");

  // Done will not leave with coordinates that do not parse: it is a kit form,
  // so the reason is under the half it is about, and that half has focus.
  await openWaypoint(page, await firstWaypointRow(page), code);
  const coords = coordsFields(page).lat;
  await coords.fill("not coordinates");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Enter a latitude between -90 and 90.")).toBeVisible();
  await expect(coords).toBeFocused();
  await expect(page).toHaveURL(waypointUrl);

  // Back still leaves — it is the browser's — and the list flags the row…
  await page.goBack();
  await onEditorList(page, waypoints.length);
  await expect(await firstWaypointRow(page)).toContainText("invalid");
  await expect(page.getByText("1 need valid coordinates")).toBeVisible();

  // …and Save refuses (client-side) instead of PUTting bad data, saying why
  // under the bar rather than in a toast.
  await saveButton(page).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Every waypoint needs valid coordinates before saving" })
  ).toBeVisible();

  expect(mutated()).toBe(false);
});

/**
 * A waypoint is a page: Back and Done both return to the list, and the list
 * comes back where it was scrolled to (lib/scroll-restoration.ts). Restoration
 * runs before late content lands, so the scroll is compared with a tolerance.
 */
test("Back and Done leave a waypoint's page for the list, at its scroll", async ({
  page,
  isMobile,
}) => {
  const mutated = trackMutations(page);
  // Short on a desktop, so the list scrolls there too. (A phone's pinned map
  // pane already pushes the list well down the page.)
  if (!isMobile) {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: 600 });
  }

  // The last row, scrolled to the MIDDLE of the screen, clear of the bar and
  // the sticky map pane above it.
  const index = waypoints.length - 1;
  const lastCode = waypoints[index].code;
  const centre = async () => {
    const row = editorRows(page).nth(index);
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    return row;
  };
  const last = await centre();
  await expect(last).toContainText(lastCode);
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled, "the list must scroll for this test to mean anything").toBeGreaterThan(0);

  // Back.
  await openWaypoint(page, last, lastCode);
  await page.goBack();
  await onEditorList(page, waypoints.length);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
    .toBeGreaterThan(scrolled - 120);

  // Done.
  await openWaypoint(page, await centre(), lastCode);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect
    .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
    .toBeGreaterThan(scrolled - 120);

  // Done went BACK rather than forward to a second copy of the list: one more
  // Back leaves the editor.
  const listHref = page.url();
  await page.goBack();
  await expect(page).not.toHaveURL(listHref);

  expect(mutated()).toBe(false);
});

test("the draft survives a reload, on the waypoint's page and on the list", async ({ page }) => {
  const mutated = trackMutations(page);
  const code = waypoints[0].code;

  // Every change goes straight into the draft: no Done needed.
  await openWaypoint(page, await firstWaypointRow(page), code);
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("E2E Reloaded");
  await page.reload();
  await expect(h1(page, code)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
    "E2E Reloaded"
  );

  // Opened directly, Done has no list behind it to go Back to: it goes to
  // the list instead — which has the edit, unsaved.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect(await firstWaypointRow(page)).toContainText("E2E Reloaded");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.reload();
  await onEditorList(page, waypoints.length);
  await expect(await firstWaypointRow(page)).toContainText("E2E Reloaded");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Discard changes is how the draft goes on purpose — asked first — and,
  // as the route editor's Cancel does, it leaves for the competition.
  await barAction(page, "Discard changes");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${compId}$`));
  // Coming back finds the saved set: the draft really is gone.
  await page.goto(`/comp/${compId}/waypoints`);
  await onEditorList(page, waypoints.length);
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  await expect(await firstWaypointRow(page)).not.toContainText("E2E Reloaded");
  await expect(saveButton(page)).toBeDisabled();
  // Nothing to discard, so ⋯ does not offer to.
  expect(await barActionLabels(page)).not.toContain("Discard changes");

  expect(mutated()).toBe(false);
});

test("remove a waypoint, and add one on a page of its own (nothing saved)", async ({ page }) => {
  const mutated = trackMutations(page);
  const firstCode = waypoints[0].code;

  // Remove is on the waypoint's page, where every other field of it lives.
  await openWaypoint(page, await firstWaypointRow(page), firstCode);
  await page.getByRole("button", { name: "Remove this waypoint" }).click();
  await onEditorList(page, waypoints.length - 1);
  await expect(page.getByText(`${waypoints.length - 1} waypoints`)).toBeVisible();
  await expect(await firstWaypointRow(page)).not.toContainText(firstCode);

  // Add waypoint is a page — no dialog — on the kit form, with Cancel and
  // Add in its bar.
  await barAction(page, "Add waypoint");
  await expect(page).toHaveURL(/\/waypoints\/new$/);
  await expect(h1(page, "Add waypoint")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page);
  await page.getByRole("textbox", { name: "Code" }).fill("E2E1");

  // Coordinates are the one thing it cannot do without: Add is not live
  // until there are some, and ones that do not parse are refused under the
  // field, which takes focus.
  const add = page.getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeDisabled();
  const coords = coordsFields(page);
  await coords.lat.fill("not a latitude");
  await add.click();
  await expect(page.getByText("Enter a latitude between -90 and 90.")).toBeVisible();
  await expect(page.getByText("Enter a longitude between -180 and 180.")).toBeVisible();
  await expect(coords.lat).toBeFocused();

  await fillCoords(page, "-36.5, 148.2");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect(page.getByText(`${waypoints.length} waypoints`)).toBeVisible();
  await expect(waypointRow(page, "E2E1")).toBeVisible();

  // Back from Add waypoint adds nothing, and nor does Cancel.
  await barAction(page, "Add waypoint");
  await expect(h1(page, "Add waypoint")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("textbox", { name: "Code" }).fill("E2E2");
  await fillCoords(page, "-36.6, 148.3");
  await page.goBack();
  await onEditorList(page, waypoints.length);
  await expect(waypointRow(page, "E2E2")).toHaveCount(0);

  await barAction(page, "Add waypoint");
  await expect(h1(page, "Add waypoint")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("textbox", { name: "Code" }).fill("E2E3");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect(waypointRow(page, "E2E3")).toHaveCount(0);

  expect(mutated()).toBe(false);
});

test("Add waypoint takes a map tap from its URL, and survives a reload", async ({ page }) => {
  const mutated = trackMutations(page);
  // A tap on either map arrives like this: the point, and what the map said
  // about it, in the URL.
  const pick = encodeURIComponent(JSON.stringify({ elevation: 812, placeName: "E2E Hill" }));
  await page.goto(`/comp/${compId}/waypoints/new?at=-36.5,148.2&pick=${pick}`);
  await expect(h1(page, "Add waypoint")).toBeVisible({ timeout: 20_000 });
  const coords = coordsFields(page);
  await expect(coords.lat).toHaveValue("-36.5");
  await expect(coords.lon).toHaveValue("148.2");
  await expect(page.getByRole("textbox", { name: /^Name/ })).toHaveValue("E2E Hill");
  await expect(page.getByText(/Filled coordinates, elevation and name from the map/)).toBeVisible();

  await page.reload();
  await expect(coords.lat).toHaveValue("-36.5", { timeout: 20_000 });
  await expect(coords.lon).toHaveValue("148.2");

  // Opened directly, Add has no list behind it to go Back to: it goes there.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await onEditorList(page, waypoints.length + 1);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  expect(mutated()).toBe(false);
});

test("save round-trip persists an edit, restore leaves the comp as found", async ({ page }) => {
  // Capture the original set so the finally block can put it back verbatim.
  const origRes = await page.request.get(`/api/comp/${compId}/waypoints`);
  expect(origRes.ok()).toBe(true);
  const original = (await origRes.json()) as { waypoints: Waypoint[] };

  try {
    await editWaypoint(page, await firstWaypointRow(page), waypoints[0].code, "Name", "E2E Renamed");

    const putDone = page.waitForResponse(
      (r) => r.url().includes("/waypoints") && r.request().method() === "PUT"
    );
    await saveButton(page).click();
    expect((await putDone).ok()).toBe(true);
    // The saved values are the new baseline: clean page, disabled button.
    await expect(saveButton(page)).toBeDisabled();
    await expect(page.getByText("Unsaved changes")).toBeHidden();

    // A reload proves it persisted (the editor rebuilds from the API, with no
    // draft left behind).
    await page.reload();
    await onEditorList(page, waypoints.length);
    await expect(await firstWaypointRow(page)).toContainText("E2E Renamed");
    await expect(page.getByText("Unsaved changes")).toBeHidden();
  } finally {
    const restore = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: original.waypoints },
    });
    expect(restore.ok()).toBe(true);
  }
});

test("device export: the QR section carries the swap toggle", async ({ page }) => {
  // Runs in BOTH projects. The pointer decides what the first device row
  // does, but the QR half is the same everywhere.
  const mutated = trackMutations(page);

  await expect(page.getByRole("checkbox", { name: /Swap code & name/ })).toHaveCount(0);
  await barAction(page, "QR code");
  await expect(page.getByText(/Scan with XCTrack, Flyskyhy/)).toBeVisible();
  // The QR is on the page, and the page still does not scroll sideways.
  await expectNoSidewaysScroll(page);

  const swap = page.getByRole("checkbox", { name: /Swap code & name/ });
  await expect(swap).not.toBeChecked();
  await page.getByText(/Swap code & name/).click();
  await expect(swap).toBeChecked();

  await barAction(page, "Hide QR");
  await expect(page.getByText(/Scan with XCTrack, Flyskyhy/)).toHaveCount(0);
  await expect(swap).toHaveCount(0);

  expect(mutated()).toBe(false);
});

test("the map folds away while it is stacked over the list", async ({ page, isMobile }) => {
  // Stacked only: side by side there is no fold and DetailFoldButton hides
  // itself, with the same `@5xl:` container query MasterDetail splits on.
  const mutated = trackMutations(page);
  const fold = page.getByRole("button", { name: "Hide map" });

  if (!isMobile) {
    await expect(fold).toBeHidden();
    expect(mutated()).toBe(false);
    return;
  }

  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  const unfold = page.getByRole("button", { name: "Show map" });
  await expect(unfold).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Waypoint map" })).toBeHidden();
  await expectNoSidewaysScroll(page);

  await unfold.click();
  await expect(page.getByRole("region", { name: "Waypoint map" })).toBeVisible();

  // Add from map needs the map: armed with the map folded away, it unfolds.
  await fold.click();
  await expect(page.getByRole("region", { name: "Waypoint map" })).toBeHidden();
  await barAction(page, "Add from map");
  await expect(page.getByRole("region", { name: "Waypoint map" })).toBeVisible();
  await expect(page.getByText("Tap the map to place…")).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Tap the map to place…")).toHaveCount(0);

  expect(mutated()).toBe(false);
});

test("nothing sticks to the bottom, and Enter in the filter is not Save", async ({ page }) => {
  const mutated = trackMutations(page);
  await editWaypoint(page, await firstWaypointRow(page), waypoints[0].code, "Name", "E2E Filter");
  await expect(saveButton(page)).toBeEnabled();

  // The filter is the bar's second layer, so it is inside the bar's form.
  const filter = page.getByRole("searchbox", { name: "Filter waypoints" });
  await filter.fill("E2E Filter");
  await expect(page.getByText(`1 of ${waypoints.length} match`)).toBeVisible();
  await filter.press("Enter");
  await expect(page.getByText(`1 of ${waypoints.length} match`)).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Save is in the bar at the top, not in a bar at the foot of the screen.
  const save = (await saveButton(page).boundingBox())!;
  expect(save.y, "Save is in the page bar").toBeLessThan(80);
  const stuck = await page.evaluate(() =>
    [...document.querySelectorAll("main *")].filter((el) => {
      const style = getComputedStyle(el);
      return (
        (style.position === "sticky" || style.position === "fixed") &&
        style.bottom === "0px" &&
        style.top === "auto" &&
        el.getBoundingClientRect().height > 0
      );
    }).length
  );
  expect(stuck, "nothing is stuck to the bottom of the screen").toBe(0);

  expect(mutated()).toBe(false);
});

// DESKTOP_ONLY: a coarse pointer gets "Open in a flight app" with hosted
// links instead of client-side downloads (WaypointDeviceExport).
test("device export: the Download row lists every format", { tag: DESKTOP_ONLY }, async ({ page }) => {
  const mutated = trackMutations(page);
  await barAction(page, "Download");
  // The formats are a second menu, behind the row.
  const formats = page
    .getByRole("menu")
    .filter({ has: page.getByRole("menuitem", { name: "SeeYou (.cup)" }) });
  await expect(formats).toBeVisible();
  // The swap row, then all 8 engine export formats (WAYPOINT_EXPORT_FORMATS).
  await expect(formats.getByRole("menuitem")).toHaveCount(9);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(mutated()).toBe(false);
});

// DESKTOP_ONLY: fine pointer only, for the same reason as the test above.
test("device export: the formats menu carries its own swap row", { tag: DESKTOP_ONLY }, async ({
  page,
}) => {
  const mutated = trackMutations(page);
  await expect(page.getByRole("checkbox", { name: /Swap code & name/ })).toHaveCount(0);

  await barAction(page, "Download");
  await page.getByRole("menuitem", { name: "Swap code & name: off" }).click();
  // The row says what it is set to the next time the menu is opened.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await barAction(page, "Download");
  await expect(page.getByRole("menuitem", { name: "Swap code & name: on" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "SeeYou (.cup)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // One piece of state behind both: the QR section opens already swapped.
  await barAction(page, "QR code");
  await expect(page.getByRole("checkbox", { name: /Swap code & name/ })).toBeChecked();

  expect(mutated()).toBe(false);
});

test("leaving the editor by a link asks; going between its pages does not", async ({ page }) => {
  const mutated = trackMutations(page);
  const code = waypoints[0].code;
  await editWaypoint(page, await firstWaypointRow(page), code, "Name", "E2E Unsaved");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Into a waypoint's page and back out by the bar's Back: the editor's own
  // pages, so nothing asks.
  await openWaypoint(page, await firstWaypointRow(page), code);
  await page.getByRole("link", { name: "Back to Waypoints" }).click();
  await onEditorList(page, waypoints.length);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(await firstWaypointRow(page)).toContainText("E2E Unsaved");

  // Out of the editor: asked. Keep editing stays, with the edit. The trail's
  // links are in the markup but visually hidden (the title's menu is the way
  // to them), so the link is clicked where it is rather than aimed at.
  const competitions = page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Competitions", exact: true });
  await competitions.evaluate((a: HTMLElement) => a.click());
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByText("This page has unsaved changes. Leaving will discard them.")
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/waypoints$/);
  await expect(await firstWaypointRow(page)).toContainText("E2E Unsaved");

  // Discard: the navigation proceeds, and the draft really is gone — the
  // waypoints come back as saved.
  await competitions.evaluate((a: HTMLElement) => a.click());
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(/\/comp$/);
  await page.goto(`/comp/${compId}/waypoints`);
  await onEditorList(page, waypoints.length);
  await expect(page.getByText("Unsaved changes")).toBeHidden();
  await expect(await firstWaypointRow(page)).not.toContainText("E2E Unsaved");

  expect(mutated()).toBe(false);
});

/**
 * Back is the browser's, and means "not now": it leaves the editor without a
 * question, and the draft is there when the reader comes back. (Until #811 a
 * history entry held by the page asked on Back instead; the overlays rule in
 * CLAUDE.md retired that machinery, and with the draft in storage there is
 * nothing for Back to lose.)
 */
test("Back leaves the editor without asking, and the draft waits for Forward", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  const compUrl = await reachWaypointsFromCompPage(page);
  await editWaypoint(page, await firstWaypointRow(page), waypoints[0].code, "Name", "E2E Later");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(compUrl);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await page.goForward();
  await onEditorList(page, waypoints.length);
  await expect(await firstWaypointRow(page)).toContainText("E2E Later");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  expect(mutated()).toBe(false);
});

test("the map opens at full size on a page of its own, with its own Add from map", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  await page.getByRole("link", { name: "Maximise map" }).click();
  await expect(page).toHaveURL(/\/waypoints\/map$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Waypoint map" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`${waypoints.length} waypoints · nothing is saved`)).toBeVisible();
  await expectNoSidewaysScroll(page);

  // The page is the bar and the map: it does not scroll, and there is no
  // Done — the bar's Back does that.
  await expect(page.getByRole("button", { name: "Done" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight
    ),
    "the map page does not scroll"
  ).toBeLessThanOrEqual(1);

  // Armed is in the URL, so coming back from Add waypoint finds it armed.
  await barAction(page, "Add from map");
  await expect(page.getByText("Tap the map to place…")).toBeVisible();
  await expect(page).toHaveURL(/\/waypoints\/map\?add=1$/);
  await barAction(page, "Stop adding from map");
  await expect(page.getByText("Tap the map to place…")).toHaveCount(0);
  await expect(page).toHaveURL(/\/waypoints\/map$/);

  // The bar's Back goes back to the list.
  await page.getByRole("link", { name: "Back to Waypoints" }).click();
  await onEditorList(page, waypoints.length);

  // And so does Back.
  await page.getByRole("link", { name: "Maximise map" }).click();
  await expect(page).toHaveURL(/\/waypoints\/map$/);
  await page.goBack();
  await onEditorList(page, waypoints.length);

  expect(mutated()).toBe(false);
});

test("the device rows follow the SAVED set, not the editor's rows", async ({ page }) => {
  // A file parsed into the editor is not yet on the server, so the device
  // rows — whose links are hosted endpoints — must not offer it.
  const deviceRows = async () =>
    (await barActionLabels(page)).filter((l) => DEVICE_FILES.test(l) || l === "QR code");
  const origRes = await page.request.get(`/api/comp/${compId}/waypoints`);
  expect(origRes.ok()).toBe(true);
  const original = (await origRes.json()) as { waypoints: Waypoint[] };

  try {
    const emptied = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: [] },
    });
    expect(emptied.ok()).toBe(true);
    await page.reload();
    await onEditorList(page, 0);

    expect(await deviceRows()).toEqual([]);

    // Adding a waypoint in the editor does NOT bring them back — only a save does.
    await barAction(page, "Add waypoint");
    await expect(h1(page, "Add waypoint")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("textbox", { name: "Code" }).fill("E2E2");
    await fillCoords(page, "-36.5, 148.2");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await onEditorList(page, 1);
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    expect(await deviceRows()).toEqual([]);

    await saveButton(page).click();
    await expect(saveButton(page)).toBeDisabled();
    expect(await deviceRows()).toHaveLength(2);
  } finally {
    const restore = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: original.waypoints },
    });
    expect(restore.ok()).toBe(true);
  }
});

test("waypoints that fail to load are said to, not shown as none, and offer no Save", async ({
  page,
}) => {
  // A failure to ask is not an answer (#481): an empty editor here offered a
  // Save that would have replaced the real set with nothing.
  await page.route("**/api/comp/*/waypoints", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" })
      : route.fallback()
  );
  await page.goto(`/comp/${compId}/waypoints`);
  await expect(page.getByText("Could not load the waypoints. Reload the page to try again.")).toBeVisible({
    timeout: 30_000,
  });
  await expect(saveButton(page)).toHaveCount(0);
  await expect(page.getByText("No waypoints")).toHaveCount(0);
});

test("anonymous visitors get the same list, read-only, and no editor pages", async ({ page }) => {
  await page.context().clearCookies();
  await page.reload();
  await expect(h1(page, "Waypoints")).toBeVisible();

  // The SAME list an admin gets, named apart and with nothing behind a row.
  const list = page.getByRole("grid", { name: "Waypoints", exact: true });
  await expect(list).toBeVisible({ timeout: 15_000 });
  const row = list.getByRole("row").filter({ hasText: waypoints[0].code }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(`${waypoints[0].altitude} m`);
  const pin = row.getByRole("button", { name: /Show .* on the map/ });
  await expect(pin).toBeVisible();
  await expectBigEnoughToTap(pin);

  // The whole row flies the map; nothing opens and nothing navigates.
  const here = page.url();
  await expect(row).toHaveCSS("cursor", "pointer");
  await row.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(here);

  await expectNoSidewaysScroll(page);

  // No admin chrome, no Tabulator: ⋯ holds the device rows, which are for
  // everyone, and nothing else; and there is no Save.
  const labels = await barActionLabels(page);
  expect(labels).toHaveLength(2);
  expect(labels[0]).toMatch(DEVICE_FILES);
  expect(labels[1]).toBe("QR code");
  await expect(page.getByRole("link", { name: "Add waypoint" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(page.locator(".tabulator")).toHaveCount(0);
  // The filter is in the bar for a visitor too.
  await expect(page.getByRole("searchbox", { name: "Filter waypoints" })).toBeVisible();

  // The editor's pages are the organisers': a visitor is sent to the list.
  for (const sub of ["1", "new", "map", "altitudes"]) {
    await page.goto(`/comp/${compId}/waypoints/${sub}`);
    await expect(page).toHaveURL(/\/waypoints$/, { timeout: 20_000 });
    await expect(page.getByRole("grid", { name: "Waypoints", exact: true })).toBeVisible();
  }
});
