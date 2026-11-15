/**
 * Account settings' save models (see pages/Settings.tsx), each group on a
 * page of its own under /settings (#863):
 *
 * - Instant groups (Appearance, Units) apply on click and flash a transient
 *   "Saved ✓" under the control.
 * - The Profile page saves explicitly: Save is in the bar and disabled until
 *   the form is dirty, Cancel asks before it throws a change away, and while
 *   dirty a capture-phase guard intercepts in-app navigation with a
 *   Discard/Keep confirm dialog (BrowserRouter has no useBlocker).
 *
 * Runs as a dedicated fixture user (not the seeded super-admin) so unit and
 * profile mutations never touch state other specs depend on. Cookie plumbing
 * matches comp-waypoints.spec.ts.
 */
import { test, expect, type Page } from "./fixtures/test";

const TEST_USER = { name: "Settings UX Fixture", email: "settings-ux@test.local" };

async function devLogin(page: Page): Promise<void> {
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: TEST_USER,
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
}

const save = (page: Page) => page.getByRole("button", { name: "Save", exact: true });

/** The Profile page, once its form has loaded. */
async function openProfile(page: Page): Promise<void> {
  await page.goto("/settings/profile");
  // The profile fetch is what the page waits on: its first field is the sync
  // point that the signed-in page is fully interactive.
  await expect(page.getByLabel("Display name")).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await devLogin(page);
});

test("the index lists the groups, and each opens a page with a way back", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  // A top-level page: the main menu, not a back link.
  await expect(page.getByRole("button", { name: "Main menu" })).toBeVisible();
  for (const group of ["Account", "Profile", "Appearance", "Units", "Connected AI Assistants", "API keys"]) {
    await expect(page.getByRole("link", { name: new RegExp(`^${group}`) })).toBeVisible();
  }

  await page.getByRole("link", { name: /^Units/ }).click();
  await expect(page).toHaveURL(/\/settings\/units$/);
  await expect(page.getByRole("heading", { name: "Units", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test("units apply instantly and flash a Saved confirmation", async ({ page }) => {
  await page.goto("/settings/units");
  // Base UI radios render a span[role=radio] over a hidden native input, so
  // state reads go to the input and selections click the pill label.
  const distanceGroup = page.getByRole("radiogroup", { name: "Distance" });
  const checkedValue = () =>
    distanceGroup
      .locator('input[type="radio"]')
      .evaluateAll((els) => (els as HTMLInputElement[]).find((e) => e.checked)?.value);
  const pill = (label: string) =>
    distanceGroup.locator("label").filter({ hasText: new RegExp(`^${label}$`) });

  const original = await checkedValue();
  const target = original === "km" ? "mi" : "km";

  await pill(target).click();
  await expect.poll(checkedValue).toBe(target);
  await expect(page.getByText("Saved ✓").first()).toBeVisible();

  // Restore, so the fixture user's preferences stay stable across runs.
  const originalLabel = original === "nmi" ? "NM" : (original ?? "km");
  await pill(originalLabel).click();
  await expect.poll(checkedValue).toBe(original);
});

test("profile Save enables only when dirty, and saving resets the baseline", async ({
  page,
}) => {
  await openProfile(page);
  await expect(save(page)).toBeDisabled();

  // The fixture user needs a display name for the form to be valid.
  const name = page.getByLabel("Display name");
  if ((await name.inputValue()) === "") await name.fill(TEST_USER.name);

  const glider = page.getByLabel("Glider");
  await glider.fill(`E2E Glider ${Date.now()}`);
  await expect(save(page)).toBeEnabled();

  await save(page).click();
  await expect(page.getByText(/Profile saved/)).toBeVisible();
  // The just-saved values are the new baseline: clean form, disabled button.
  await expect(save(page)).toBeDisabled();
});

test("leaving a dirty profile is guarded: Keep stays, Discard leaves", async ({ page }) => {
  await openProfile(page);
  const glider = page.getByLabel("Glider");
  const originalGlider = await glider.inputValue();
  await glider.fill("Unsaved Wing");
  await expect(save(page)).toBeEnabled();

  // Cancel asks before it throws a change away. Keep editing: still here,
  // edit retained.
  await page.getByRole("button", { name: "Cancel" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Discard profile changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(glider).toHaveValue("Unsaved Wing");

  // An in-app link asks the same question: the title's menu, up to Settings.
  await page.getByRole("button", { name: "Profile: go to another page" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(dialog.getByText("Discard profile changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(glider).toHaveValue("Unsaved Wing");

  // Discard: Cancel leaves for the index, and nothing was saved.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await openProfile(page);
  await expect(page.getByLabel("Glider")).toHaveValue(originalGlider);
});

test("a clean profile leaves without any prompt", async ({ page }) => {
  await openProfile(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("alertdialog")).toBeHidden();
});
