/**
 * The altitude review — "Check altitudes" on the waypoints page — as pages
 * (#811): the list of what the check found at /comp/:id/waypoints/altitudes,
 * and one waypoint of it at /altitudes/:n. It was a full-screen sheet with
 * its two views swapped inside it. Runs in BOTH Playwright projects (see
 * e2e/fixtures/mobile.ts).
 *
 * What it holds:
 * - the check reports nothing until pressed, and changes nothing on its own;
 * - every row states BOTH altitudes, and a difference of zero prints nothing;
 * - the list is a snapshot in membership AND order, and keeps both across a
 *   visit to one waypoint and across a reload (it lives in the waypoints
 *   draft, comp/waypoints-draft.ts);
 * - inside one waypoint, Back, Done and "All N" return to the review's LIST,
 *   never out of the review; the list's Done leaves it;
 * - accepting is an ordinary unsaved edit, saved by Save on the waypoints
 *   page.
 *
 * Driven against a FLAT synthetic DEM (stubTerrainElevations), so every
 * disagreement is arithmetic the test chose rather than whatever the real
 * terrain says. Mutation-free throughout: a review reads the map, never the
 * API.
 */
import { test, expect, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";
import { stubTerrainElevations } from "./fixtures/mapbox";
import {
  firstWaypointRow,
  h1,
  onEditorList,
  reviewRows,
  reviewUrl,
  reviewWaypointUrl,
  seededWaypoints,
  signInAsSuperAdmin,
  trackMutations,
  waypointRow,
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
});

/** Open the waypoints list and run the check against flat ground at `alt`. */
async function checkAltitudes(page: Page, alt: number, alpha?: number): Promise<void> {
  await stubTerrainElevations(page.context(), alt, alpha);
  await page.goto(`/comp/${compId}/waypoints`);
  await onEditorList(page, waypoints.length);
  await page.getByRole("button", { name: "Check altitudes" }).click();
  await expect(page).toHaveURL(reviewUrl, { timeout: 20_000 });
  await expect(h1(page, "Check altitudes")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** The page must never scroll sideways, at either project's width. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(scrolls, "the page must not scroll sideways").toBe(false);
}

/** The codes down the review's list, in order. */
async function listedCodes(page: Page): Promise<string[]> {
  const titles = await reviewRows(page).allInnerTexts();
  return titles.map((t) => t.split("\n")[0].trim());
}

/**
 * 4000 m is far above the whole Corryong set (its highest waypoint is under
 * 1000 m), which puts every row past the coordinate-suspicion threshold — so
 * the review must find them all.
 */
test("Check altitudes reviews the set on a page and accepts one row", async ({ page }) => {
  const mutated = trackMutations(page);
  // alpha 128: the coastal no-data case. Read off a canvas this same pixel
  // comes back thousands of metres out; the review must show 4000 regardless.
  await checkAltitudes(page, 4000, 128);

  await expect(page.getByRole("status").filter({ hasText: "to look at" })).toContainText(
    `${waypoints.length} of ${waypoints.length} waypoints to look at`
  );
  await expect(page.getByRole("main")).toContainText("check the coordinates");
  // Corrections here do not reach into tasks already built — the page says so.
  await expect(page.getByRole("main")).toContainText("Existing tasks keep their own copies");

  // Biggest disagreement first. Against flat ground that is the LOWEST
  // waypoint, and its row states BOTH altitudes.
  const lowest = Math.min(...waypoints.map((w) => w.altitude ?? 0));
  const topRow = reviewRows(page).first();
  await expect(topRow).toContainText(`file ${lowest} m`);
  await expect(topRow).toContainText("map 4000 m");
  await expectNoSidewaysScroll(page);

  // Accepting one row takes the map's value. The row STAYS in the list rather
  // than vanishing under the thumb, now agreeing — with no "0 m" beside it.
  await topRow.getByRole("button", { name: "Use 4000 m" }).click();
  await expect(topRow).toContainText("file 4000 m");
  await expect(topRow).not.toContainText(/[+-]\d+\s*m/);

  // Done leaves the review for the waypoints, where the edit is unsaved.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  expect(mutated()).toBe(false);
});

test("one waypoint of the review is a page; Back and Done return to the review", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  await checkAltitudes(page, 4000, 128);
  const lowest = Math.min(...waypoints.map((w) => w.altitude ?? 0));
  const reviewHref = page.url();

  await reviewRows(page).first().click();
  await expect(page).toHaveURL(reviewWaypointUrl);
  // One waypoint: both numbers, labelled, and the difference between them.
  await expect(page.getByText("In the file")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("From the map")).toBeVisible();
  await expect(page.getByRole("main")).toContainText(`${lowest} m`);
  await expect(page.getByRole("main")).toContainText("4000 m");
  await expect(page.getByRole("main")).toContainText("apart");
  // No map on this page, by decision.
  await expect(page.locator(".mapboxgl-canvas")).toHaveCount(0);
  await expectNoSidewaysScroll(page);

  // The altitude is editable here, which is the alternative to accepting.
  const altInput = page.getByRole("textbox", { name: "Altitude (m)" });
  await altInput.fill("123");
  await altInput.blur();

  // "All N" returns to the list…
  await page.getByRole("button", { name: /^All \d+$/ }).click();
  await expect(page).toHaveURL(reviewHref);
  await expect(h1(page, "Check altitudes")).toBeVisible();

  // …and so does Done, from one waypoint: "done with this waypoint" is not
  // "done with the check".
  await reviewRows(page).first().click();
  await expect(page.getByText("In the file")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL(reviewHref);
  await expect(h1(page, "Check altitudes")).toBeVisible();

  // And the browser's Back walks one page at a time: the waypoint, the
  // review, the waypoints.
  await reviewRows(page).first().click();
  await expect(page.getByText("In the file")).toBeVisible({ timeout: 20_000 });
  await page.goBack();
  await expect(page).toHaveURL(reviewHref);
  await expect(h1(page, "Check altitudes")).toBeVisible();
  await page.goBack();
  await onEditorList(page, waypoints.length);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Back from the review left it open: Forward finds it as it was.
  await page.goForward();
  await expect(h1(page, "Check altitudes")).toBeVisible({ timeout: 20_000 });

  expect(mutated()).toBe(false);
});

test("the review keeps its list, in membership and order, across a reload", async ({ page }) => {
  const mutated = trackMutations(page);
  await checkAltitudes(page, 4000, 128);
  const before = await listedCodes(page);
  expect(before.length).toBe(waypoints.length);

  // Accept the top row: live, it would sink to the bottom (its disagreement
  // is now zero). The snapshot keeps it where it was.
  await reviewRows(page).first().getByRole("button", { name: "Use 4000 m" }).click();
  await expect(reviewRows(page).first()).toContainText("file 4000 m");
  expect(await listedCodes(page)).toEqual(before);

  await page.reload();
  await expect(h1(page, "Check altitudes")).toBeVisible({ timeout: 20_000 });
  await expect(reviewRows(page)).toHaveCount(before.length);
  expect(await listedCodes(page)).toEqual(before);
  await expect(reviewRows(page).first()).toContainText("file 4000 m");

  // One waypoint of it survives a reload too, with its reading.
  await reviewRows(page).nth(1).click();
  await expect(page).toHaveURL(reviewWaypointUrl);
  await page.reload();
  await expect(page.getByText("From the map")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("main")).toContainText("4000 m");
  // Opened by a reload, its way back is to the review's list all the same.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page).toHaveURL(reviewUrl);
  expect(await listedCodes(page)).toEqual(before);

  expect(mutated()).toBe(false);
});

test("typing a coordinate in the review keeps the comparison on screen", async ({ page }) => {
  const mutated = trackMutations(page);
  await checkAltitudes(page, 4000, 128);

  await reviewRows(page).first().click();
  // Which waypoint that is depends on the disagreements, so read it off the
  // heading rather than assuming the editor's first row.
  const heading = page.getByRole("heading", { level: 1 });
  await expect(page.getByText("In the file")).toBeVisible({ timeout: 20_000 });
  const code = ((await heading.textContent()) ?? "").trim();
  const accept = page.getByRole("button", { name: /^Use the map’s altitude/ });
  await expect(accept).toBeVisible();

  // Moving the waypoint makes its terrain reading stale — which per keystroke
  // used to destroy the comparison this page exists to show. The page holds
  // the reading it opened with, so type a character at a time and none of
  // that moves.
  const coords = page.getByRole("textbox", { name: "Coordinates" });
  await coords.fill("");
  await coords.pressSequentially("-36.61234, 146.61234", { delay: 10 });
  await expect(page.getByRole("main")).toContainText("4000 m");
  await expect(page.getByRole("main")).toContainText("apart");
  await expect(accept).toBeVisible();
  await expect(page.getByText("Enter coordinates as")).toHaveCount(0);

  // Back on the list the waypoint has moved, so its reading is gone.
  await page.getByRole("button", { name: /^All \d+$/ }).click();
  await expect(h1(page, "Check altitudes")).toBeVisible();
  await expect(reviewRows(page).first()).toContainText("no map reading");

  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(waypointRow(page, code)).toContainText("-36.61234");

  expect(mutated()).toBe(false);
});

test("the review narrows to the rows worth looking at, and can widen again", async ({ page }) => {
  const mutated = trackMutations(page);
  // Flat ground AT one of the set's own altitudes, so some rows agree and the
  // rest do not — which is what the narrowing is for.
  const altitudes = waypoints.map((w) => w.altitude ?? 0);
  const commonest = [...altitudes].sort(
    (a, b) => altitudes.filter((x) => x === b).length - altitudes.filter((x) => x === a).length
  )[0];
  const agreeing = altitudes.filter((a) => Math.abs(a - commonest) < 50).length;
  const toLookAt = waypoints.length - agreeing;
  // The fixture only makes sense if the set really is mixed.
  expect(toLookAt).toBeGreaterThan(0);
  expect(agreeing).toBeGreaterThan(0);

  await checkAltitudes(page, commonest);
  await expect(page.getByRole("status").filter({ hasText: "to look at" })).toContainText(
    `${toLookAt} of ${waypoints.length} waypoints to look at`
  );
  await expect(page.getByRole("main")).toContainText(`${agreeing} agree`);

  // Narrowed by default: the agreeing rows are counted, not listed.
  await expect(reviewRows(page)).toHaveCount(toLookAt);
  await page.getByRole("button", { name: `Show all ${waypoints.length} waypoints` }).click();
  await expect(reviewRows(page)).toHaveCount(waypoints.length);
  // Widened is in the URL, so a waypoint's page comes back to it widened.
  await expect(page).toHaveURL(/altitudes\?all=1$/);
  await reviewRows(page).last().click();
  await expect(page.getByText("In the file")).toBeVisible({ timeout: 20_000 });
  await page.goBack();
  await expect(reviewRows(page)).toHaveCount(waypoints.length);

  await page.getByRole("button", { name: `Show only the ${toLookAt} to look at` }).click();
  await expect(reviewRows(page)).toHaveCount(toLookAt);

  // Accept the lot: every disagreement goes, and it is all one unsaved edit.
  await page
    .getByRole("button", { name: `Use the map’s altitude for all ${toLookAt}` })
    .click();
  await expect(page.getByRole("status").filter({ hasText: "agrees" })).toContainText(
    "agrees with the map"
  );

  await page.getByRole("button", { name: "Done", exact: true }).click();
  await onEditorList(page, waypoints.length);
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(await firstWaypointRow(page)).toBeVisible();

  expect(mutated()).toBe(false);
});

test("with no review in progress, the review page offers the check", async ({ page }) => {
  const mutated = trackMutations(page);
  await stubTerrainElevations(page.context(), 4000, 128);

  // A link opened in a fresh tab: no draft, so no review. One waypoint of it
  // goes to the list, and the list offers the check rather than an error.
  await page.goto(`/comp/${compId}/waypoints/altitudes/1`);
  await expect(page).toHaveURL(reviewUrl, { timeout: 20_000 });
  await expect(h1(page, "Check altitudes")).toBeVisible({ timeout: 20_000 });
  await expect(reviewRows(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Check altitudes" }).click();
  await expect(reviewRows(page)).toHaveCount(waypoints.length, { timeout: 20_000 });

  expect(mutated()).toBe(false);
});
