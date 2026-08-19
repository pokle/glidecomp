/**
 * The hierarchical competition settings pages (/comp/:id/settings[/:group]) —
 * the mobile-first replacement for the old 21-control settings dialog: an
 * index of grouped rows, a focused sub-page per group, explicit Save per
 * page, and the unsaved-changes guard shared with /settings.
 *
 * What this spec pins:
 * - the index rows and their current-value summaries, and that a group save
 *   PATCHes ONLY that group's fields (the server diffs per field, so a page
 *   sending another group's values would silently widen every save);
 * - the Discard/Keep navigation guard on a dirty sub-page;
 * - the whole journey at a phone viewport (390×844) with no horizontal
 *   overflow — the point of the restructure;
 * - non-admin fallback and the unknown-group 404.
 *
 * Runs against its own comp (named through e2eCompName so the pre-run sweep
 * can catch strays) with a dedicated fixture admin, so nothing here touches
 * the seeded sample comp other specs read.
 */
import { test, expect, type Page } from "./fixtures/test";
import { e2eCompName } from "./fixtures/stack";

const ADMIN_USER = {
  name: "Comp Settings Fixture",
  email: "comp-settings@test.local",
};
const VISITOR_USER = {
  name: "Comp Settings Visitor",
  email: "comp-settings-visitor@test.local",
};
const COMP_NAME = e2eCompName("Comp Settings Pages");

let compId: string;

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
    data: { name: COMP_NAME, category: "hg", pilot_classes: ["open"] },
  });
  expect(created.ok(), await created.text()).toBe(true);
  compId = ((await created.json()) as { comp_id: string }).comp_id;
  await api.dispose();
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test("a visitor gets the admin-only notice, and an unknown group 404s", async ({
  page,
}) => {
  // Before any admin test hides or reshapes the comp: a signed-in non-admin
  // reaches the URL but not the settings.
  await devLogin(page, VISITOR_USER);
  await page.goto(`/comp/${compId}/settings`);
  await expect(
    page.getByText("Competition settings are for competition admins.")
  ).toBeVisible();

  // An unknown group is a dead URL, not an empty page.
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings/nonsense`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("the index groups the settings; a group save PATCHes only its own fields", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings`);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  // The four group rows, each carrying a current-value summary. Scoped to
  // main: the Shell footer also carries a "Scoring" link, and substring name
  // matching would resolve both (strict-mode violation).
  const main = page.getByRole("main");
  const general = main.getByRole("link", { name: /^General/ });
  await expect(general).toContainText(COMP_NAME);
  await expect(main.getByRole("link", { name: /^Pilot classes/ })).toContainText(
    "open"
  );
  await expect(main.getByRole("link", { name: /^Scoring/ })).toContainText("GAP");
  const access = main.getByRole("link", { name: /^Access/ });
  await expect(access).toContainText("Open registration");
  // The destructive action is a row on the index, not a hidden sub-page.
  await expect(
    page.getByRole("button", { name: "Delete competition" })
  ).toBeVisible();

  // Into a group, change one thing, save.
  await access.click();
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  const box = page.getByLabel("Let pilots register themselves by submitting a track");
  await expect(box).toBeChecked();
  // Click the visible label, not the input: the kit hides the real checkbox
  // under a styled span (rac gotcha #13).
  await page
    .getByText("Let pilots register themselves by submitting a track")
    .click();
  await expect(box).not.toBeChecked();

  const [patch] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === "PATCH" && r.url().includes("/api/comp/")
    ),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  // ONLY the Access group's fields travel — the server diffs per field, so a
  // page that also sent name/classes/gap_params would quietly turn every
  // Access save into a whole-comp save.
  const body = patch.postDataJSON() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "admin_emails",
    "open_igc_upload",
    "open_registration",
    "test",
  ]);
  expect(body.open_registration).toBe(false);

  // A successful save lands back on the index, and the row's summary reads
  // the new state.
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: /^Access/ })).toContainText(
    "Admins add pilots"
  );
});

test("leaving a dirty sub-page is guarded: Keep stays, Discard leaves", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings/general`);
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();

  const name = page.getByLabel("Name");
  await name.fill(`${COMP_NAME} (edited)`);
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // exact: the comp-name crumb ("E2E Comp Settings Pages") also contains the
  // word Settings, and name matching is substring by default.
  const settingsCrumb = page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Settings", exact: true });

  // Keep editing: navigation cancelled, edit retained.
  await settingsCrumb.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Discard changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(name).toHaveValue(`${COMP_NAME} (edited)`);

  // Discard: navigation proceeds, and nothing was saved.
  await settingsCrumb.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^General/ })
  ).toContainText(COMP_NAME);
});

test("the whole journey fits a phone: no horizontal overflow at 390×844", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await devLogin(page, ADMIN_USER);

  const noHorizontalOverflow = async (where: string) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow, `${where} must not scroll sideways on a phone`).toBeLessThanOrEqual(0);
  };

  // Comp page → Settings link → index.
  await page.goto(`/comp/${compId}`);
  const settingsLink = page.getByRole("link", { name: "Settings", exact: true });
  await expect(settingsLink).toBeVisible();
  await settingsLink.click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await noHorizontalOverflow("the settings index");

  // Rows are comfortably tappable (44px minimum target).
  const general = page.getByRole("main").getByRole("link", { name: /^General/ });
  const rowBox = await general.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);

  // Index → sub-page → untouched Save → back on the index.
  await general.click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await noHorizontalOverflow("the General sub-page");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await noHorizontalOverflow("the settings index after saving");
});
