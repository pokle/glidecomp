/**
 * Issue #539 — a display name edited in Settings must reach the ACCOUNT.
 *
 * `pilot.name` (the profile, shown in scores tables and on the roster) and
 * `"user".name` (the account, shown in the main menu and signed onto every
 * audit entry) are separate columns, and Settings used to write only the
 * first. The two agreed until the first rename and then never again.
 *
 * This drives the whole chain the fix runs through — the SPA's profile save,
 * competition-api's PATCH, auth-api's set-name write — and checks the main menu
 * both immediately (no reload) and after a reload (the value really landed).
 *
 * Its own fixture user, and it puts the name back afterwards, so a re-run
 * starts where the last one did.
 */
import { test, expect, type Page } from "./fixtures/test";

const ORIGINAL_NAME = "Rename Fixture";
const NEW_NAME = "Renamed Fixture";
const TEST_USER = { name: ORIGINAL_NAME, email: "settings-rename@test.local" };

async function devLogin(page: Page): Promise<void> {
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: TEST_USER,
  });
  if (!loginRes.ok()) {
    throw new Error(
      `Dev login failed: ${loginRes.status()} — ${await loginRes.text()}`
    );
  }
  const setCookieHeader = loginRes.headers()["set-cookie"];
  const tokenMatch = setCookieHeader?.match(/better-auth\.session_token=([^;]+)/);
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

/**
 * Open the main menu and read the display name it renders. The account is in
 * the main menu, which a top-level page has in its bar: the settings index.
 */
async function accountMenuName(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Main menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const name = (await menu.locator("[class*='truncate']").first().innerText()).trim();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return name;
}

/** The Profile page, by a page load: the account is resolved afresh. */
async function gotoProfile(page: Page): Promise<void> {
  await page.goto("/settings/profile");
  await expect(page.getByLabel("Display name")).toBeVisible({ timeout: 15_000 });
}

/** From a clean Profile page to the settings index, with no page load. */
async function toIndex(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/settings$/);
}

/** From the index to the Profile page, with no page load. */
async function toProfile(page: Page): Promise<void> {
  await page.getByRole("link", { name: /^Profile/ }).click();
  await expect(page.getByLabel("Display name")).toBeVisible({ timeout: 15_000 });
}

/** Type a display name and save, waiting for the confirmation. */
async function saveDisplayName(page: Page, name: string): Promise<void> {
  await page.getByLabel("Display name").fill(name);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/Profile saved/)).toBeVisible();
}

test("a renamed profile renames the account, main menu included", async ({ page }) => {
  await devLogin(page);
  await gotoProfile(page);

  // Start from a known name however the last run ended.
  if ((await page.getByLabel("Display name").inputValue()) !== ORIGINAL_NAME) {
    await saveDisplayName(page, ORIGINAL_NAME);
  }
  await toIndex(page);
  expect(await accountMenuName(page)).toBe(ORIGINAL_NAME);

  await toProfile(page);
  await saveDisplayName(page, NEW_NAME);

  // No reload: the account is resolved once per page load, so the menu used
  // to keep the old name until the next one. The index's Profile row prints
  // the same name.
  await toIndex(page);
  expect(await accountMenuName(page)).toBe(NEW_NAME);
  await expect(page.getByRole("link", { name: /^Profile/ })).toContainText(NEW_NAME);

  // And it really is the account's now, not just this page's idea of it.
  await gotoProfile(page);
  await expect(page.getByLabel("Display name")).toHaveValue(NEW_NAME);

  // Leave the fixture as we found it.
  await saveDisplayName(page, ORIGINAL_NAME);
  await toIndex(page);
  expect(await accountMenuName(page)).toBe(ORIGINAL_NAME);
});
