/**
 * The page bar — the one bar every page of the app has (issue #863,
 * web/frontend/src/react/rac/page-bar.tsx). The page is for information, and
 * every action goes in the bar: back or Cancel on the left, the title over
 * its menu in the centre, a form's commit button or ⋯ on the right.
 *
 * What this spec pins, at a desktop width and on a phone (it is in
 * MOBILE_SPEC_FILES, e2e/fixtures/mobile.ts):
 * - every control in the bar and every row of its menus has a hit area of
 *   44 px or more;
 * - no page scrolls sideways under the bar;
 * - Back from a page a row opened restores the list's scroll and focus;
 * - a refused Save scrolls to the field with the bar still on screen;
 * - Save is greyed out until something changes;
 * - Cancel on a changed form asks first.
 *
 * What each page puts in its bar is that page's own spec's business.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from "./fixtures/test";
import { e2eCompName, FRONTEND_URL } from "./fixtures/stack";
import { expectNoSidewaysScroll } from "./fixtures/layout";

const TEST_USER = { name: "E2E Page Bar", email: "e2e-page-bar@test.local" };

/** Enough pilots that the list is several screens long on a desktop too. */
const ROSTER = Array.from({ length: 60 }, (_, i) => ({
  registered_pilot_name: `Pilot ${String(i + 1).padStart(2, "0")}`,
  pilot_class: "open",
}));

/** The floor: a control a finger can hit. Half a pixel of slack for rounding. */
const TARGET = 43.5;

let api: APIRequestContext;
let compId: string;
let compName: string;

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const login = await api.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);
  compName = e2eCompName("Page bar");
  const res = await api.post("/api/comp", {
    data: { name: compName, category: "hg", pilot_classes: ["open"] },
  });
  expect(res.ok(), await res.text()).toBe(true);
  compId = ((await res.json()) as { comp_id: string }).comp_id;
  const bulk = await api.post(`/api/comp/${compId}/pilot/bulk`, {
    data: { pilots: ROSTER, remove: [] },
  });
  expect(bulk.ok(), await bulk.text()).toBe(true);
  // Any save marks the settings reviewed. Until then an untouched Save is
  // live on purpose: it is the review the setup guide asks for
  // (canSaveSettings, comp/settings/CompSettingsIndex.tsx).
  const reviewed = await api.patch(`/api/comp/${compId}`, { data: { name: compName } });
  expect(reviewed.ok(), await reviewed.text()).toBe(true);
});

test.afterAll(async () => {
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  const login = await page.request.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
});

/** The bar: the header inside <main>, which holds the page's <h1>. */
// Not a direct child of <main>: a form wraps its page, and so do tabs.
const bar = (page: Page) => page.locator("main#main-content header").first();

async function expectTarget(control: Locator, what: string): Promise<void> {
  // Waited for: the bar is drawn before the page's data and again with it,
  // and a control measured between the two has no box at all.
  await expect(control, `${what} must be on screen`).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${what} must be on screen`).not.toBeNull();
  expect(box!.width, `${what} must be 44 px wide or more`).toBeGreaterThanOrEqual(TARGET);
  expect(box!.height, `${what} must be 44 px tall or more`).toBeGreaterThanOrEqual(TARGET);
}

/** Every row of the menu that is open is a 44 px target. */
async function expectMenuRows(page: Page, what: string): Promise<void> {
  const rows = page.getByRole("menuitem");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count, `${what} must have rows`).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    // Polled: a menu opens with a short scale animation, and a row measured
    // in the middle of it is a few per cent smaller than it will be.
    await expect
      .poll(async () => (await rows.nth(i).boundingBox())?.height ?? 0, {
        message: `${what}, row ${i + 1} must be 44 px tall or more`,
      })
      .toBeGreaterThanOrEqual(TARGET);
  }
}

test.describe("the page bar", () => {
  test("every control in the bar and its menus is a 44 px target", async ({ page }) => {
    await page.goto(`/comp/${compId}/pilots`);
    await expect(page.getByRole("heading", { level: 1, name: "Pilots" })).toBeVisible();
    // The roster is in: the bar is the page's own now, not the loading one.
    await expect(page.getByRole("row", { name: /Pilot 01/ })).toBeVisible();

    // The three slots: back, the title's menu, + and ⋯.
    const back = bar(page).getByRole("link", { name: /^Back to / });
    await expectTarget(back, "Back");
    const titleMenu = bar(page).getByRole("button", { name: /go to another page$/ });
    await expectTarget(titleMenu, "the title's menu button");
    await expectTarget(bar(page).getByRole("link", { name: "Add pilot" }), "+");
    const more = bar(page).getByRole("button", { name: "More actions" });
    await expectTarget(more, "⋯");

    await more.click();
    await expectMenuRows(page, "the ⋯ menu");
    await page.keyboard.press("Escape");
    // Gone, not going: a closing menu's rows are still in the DOM for a moment.
    await expect(page.getByRole("menuitem")).toHaveCount(0);

    await titleMenu.click();
    await expectMenuRows(page, "the title's menu");
    // The tree: the pages above, this page ticked, and the other places.
    await expect(page.getByRole("menuitem", { name: "Competitions", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: compName })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Submit track" })).toBeVisible();
    await page.keyboard.press("Escape");

    // A top-level page: the main menu is the way out.
    await page.goto("/comp");
    const main = bar(page).getByRole("button", { name: "Main menu" });
    await expectTarget(main, "the main menu button");
    await main.click();
    await expectMenuRows(page, "the main menu");
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");

    // A form: Cancel and the commit button.
    await page.goto(`/comp/${compId}/settings/general`);
    await expectTarget(bar(page).getByRole("button", { name: "Cancel" }), "Cancel");
    await expectTarget(bar(page).getByRole("button", { name: "Save" }), "Save");
  });

  test("no page scrolls sideways under the bar", async ({ page }) => {
    for (const path of [
      "/comp",
      `/comp/${compId}`,
      `/comp/${compId}/pilots`,
      `/comp/${compId}/pilots/new`,
      `/comp/${compId}/settings`,
      `/comp/${compId}/settings/general`,
      `/comp/${compId}/waypoints`,
      "/submit",
      "/settings",
    ]) {
      await page.goto(path);
      await expect(bar(page).getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoSidewaysScroll(page, path);
    }
  });

  test("the bar holds the page's only h1, and the trail is in the markup", async ({ page }) => {
    await page.goto(`/comp/${compId}/pilots`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(bar(page).getByRole("heading", { level: 1, name: "Pilots" })).toBeVisible();

    // With the menus closed, the pages above are still real links (for a
    // crawler, and for the accessibility standard's Breadcrumb landmark).
    const trail = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(trail.getByRole("link", { name: "Competitions" })).toHaveAttribute("href", "/comp");
    await expect(trail.getByRole("link", { name: compName })).toHaveCount(1);
    await expect(trail.locator('[aria-current="page"]')).toHaveText("Pilots");
  });

  test("Back from a page a row opened restores the list's scroll and focus", async ({ page }) => {
    await page.goto(`/comp/${compId}/pilots`);
    const row = page.getByRole("row", { name: /Pilot 45/ });
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    const before = await page.evaluate(() => window.scrollY);
    expect(before, "the list must be scrolled for this to mean anything").toBeGreaterThan(100);

    await row.click();
    await expect(page.getByRole("heading", { level: 1, name: "Pilot 45" })).toBeVisible();

    // A pilot's page is a form, so its way out is Cancel. On an unchanged
    // form it is a real Back: the list returns as it was left.
    await bar(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Pilots" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { message: "scroll restored" })
      .toBeGreaterThan(before - 80);
    expect(await page.evaluate(() => window.scrollY)).toBeLessThan(before + 80);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.activeElement?.closest("[data-key]")?.textContent?.includes("Pilot 45") ?? false
          ),
        { message: "focus is back on the row the page was opened from" }
      )
      .toBe(true);
  });

  test("Save is greyed out until something changes", async ({ page }) => {
    await page.goto(`/comp/${compId}/settings/general`);
    const save = bar(page).getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();

    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill(`${compName} x`);
    await expect(save).toBeEnabled();

    // Put back as it was: nothing to save again.
    await name.fill(compName);
    await expect(save).toBeDisabled();
  });

  test("a refused Save scrolls to the field with the bar still on screen", async ({ page }) => {
    await page.goto(`/comp/${compId}/settings/general`);
    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("");
    // Leave the field at the top of the page, so the refusal has to bring it back.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    await bar(page).getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Enter a competition name")).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toBeInViewport();

    // The bar did not go anywhere, and the field is not under it.
    await expect(bar(page).getByRole("button", { name: "Save" })).toBeInViewport();
    const barBox = await bar(page).boundingBox();
    const fieldBox = await name.boundingBox();
    expect(fieldBox!.y, "the field must clear the bar").toBeGreaterThanOrEqual(
      barBox!.y + barBox!.height - 12
    );
  });

  test("Cancel on a changed form asks first", async ({ page }) => {
    await page.goto(`/comp/${compId}/settings`);
    await page.getByRole("link", { name: /General/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "General" })).toBeVisible();

    await page.getByRole("textbox", { name: "Name" }).fill(`${compName} changed`);
    await bar(page).getByRole("button", { name: "Cancel" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(dialog.getByText("Discard changes?")).toBeVisible();

    // Keep editing: still on the form, the change still there.
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(`${compName} changed`);

    // Discard: back on the page above, nothing saved.
    await bar(page).getByRole("button", { name: "Cancel" }).click();
    await dialog.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByText(`${compName} changed`)).toHaveCount(0);

    // Unchanged, Cancel just leaves.
    await page.getByRole("link", { name: /General/ }).click();
    await bar(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });
});
