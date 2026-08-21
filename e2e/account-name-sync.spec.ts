/**
 * Issue #539 — a display name edited in Settings must reach the ACCOUNT.
 *
 * `pilot.name` (the profile, shown in scores tables and on the roster) and
 * `"user".name` (the account, shown in the account menu and signed onto every
 * audit entry) are separate columns, and Settings used to write only the
 * first. The two agreed until the first rename and then never again.
 *
 * This drives the whole chain the fix runs through — the SPA's profile save,
 * competition-api's PATCH, auth-api's set-name write — and checks the header
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

/** Open the account menu and read the display name it renders. */
async function accountMenuName(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Account menu" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const name = (await menu.locator("header, [class*='truncate']").first().innerText()).trim();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return name;
}

async function gotoSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible({
    timeout: 15_000,
  });
}

/** Type a display name and save, waiting for the confirmation. */
async function saveDisplayName(page: Page, name: string): Promise<void> {
  await page.getByLabel("Display name").fill(name);
  const save = page.getByRole("button", { name: "Save profile" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(/Profile saved/)).toBeVisible();
}

test("a renamed profile renames the account, header included", async ({ page }) => {
  await devLogin(page);
  await gotoSettings(page);

  // Start from a known name however the last run ended.
  if ((await page.getByLabel("Display name").inputValue()) !== ORIGINAL_NAME) {
    await saveDisplayName(page, ORIGINAL_NAME);
  }
  expect(await accountMenuName(page)).toBe(ORIGINAL_NAME);

  await saveDisplayName(page, NEW_NAME);

  // No reload: the account is resolved once per page load, so the header used
  // to keep the old name until the next one.
  expect(await accountMenuName(page)).toBe(NEW_NAME);

  // And it really is the account's now, not just this page's idea of it.
  await gotoSettings(page);
  expect(await accountMenuName(page)).toBe(NEW_NAME);
  await expect(page.getByLabel("Display name")).toHaveValue(NEW_NAME);

  // Leave the fixture as we found it.
  await saveDisplayName(page, ORIGINAL_NAME);
  expect(await accountMenuName(page)).toBe(ORIGINAL_NAME);
});
