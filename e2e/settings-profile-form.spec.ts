/**
 * The profile form on Settings, and the card actions beside it, on a phone and
 * on a desktop (#808).
 *
 * The profile saves through the kit form (rac/form.tsx), so a refusal lands
 * under the field it is about, an error about no field sits beside Save, and
 * neither is a toast. The kit's own rules are held by forms.spec.ts; this file
 * holds only that the profile's fields are wired to them — that each one
 * carries the server's name for it, and the page's own check lands the same
 * way. Revoke and Delete account are buttons, not forms, and their failures
 * are shown in their own card, also never as a toast.
 *
 * Runs as its own fixture user, so nothing it saves meets another spec.
 */
import { test, expect, type Page } from "./fixtures/test";

const TEST_USER = { name: "Profile Form Fixture", email: "settings-profile-form@test.local" };

async function devLogin(page: Page): Promise<void> {
  const loginRes = await page.request.post("/api/auth/dev-login", { data: TEST_USER });
  if (!loginRes.ok()) {
    throw new Error(`Dev login failed: ${loginRes.status()} — ${await loginRes.text()}`);
  }
  const token = loginRes.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
}

const profileCard = (page: Page) =>
  page
    .locator("section[data-slot=card]")
    .filter({ has: page.getByRole("heading", { name: "Profile", exact: true }) });
const field = (page: Page, label: string) =>
  profileCard(page).getByRole("textbox", { name: label, exact: true });
const save = (page: Page) => profileCard(page).getByRole("button", { name: "Save profile" });
const toasts = (page: Page) => page.locator("[data-sonner-toast]");

test.beforeEach(async ({ page }) => {
  await devLogin(page);
  await page.goto("/settings");
  await expect(save(page)).toBeVisible({ timeout: 15_000 });
  // The fixture user needs a display name for any other edit to save.
  const name = field(page, "Display name");
  if ((await name.inputValue()).trim() === "") {
    await name.fill(TEST_USER.name);
    await save(page).click();
    await expect(profileCard(page).getByText(/Profile saved/)).toBeVisible();
  }
});

test("a value the server refuses is shown under its field, focused, and kept", async ({
  page,
}) => {
  // A real refusal: competition-api's validator names the field it refuses.
  const glider = field(page, "Glider");
  await glider.fill("Moyes <Litespeed>");
  await save(page).click();

  await expect(glider).toHaveAttribute("aria-invalid", "true");
  await expect(glider).toHaveAccessibleDescription(/must not contain < or >/);
  await expect(glider).toBeFocused();
  await expect(glider).toHaveValue("Moyes <Litespeed>");
  await expect(toasts(page)).toHaveCount(0);
  await expect(profileCard(page).getByText(/Profile saved/)).toHaveCount(0);

  // Editing clears it, and the corrected value saves.
  await glider.fill(`Moyes Litespeed ${Date.now() % 100_000}`);
  await expect(glider).not.toHaveAttribute("aria-invalid", "true");
  await save(page).click();
  await expect(profileCard(page).getByText(/Profile saved/)).toBeVisible();
});

test("a blank display name is refused under Display name, before anything is sent", async ({
  page,
}) => {
  let patched = false;
  await page.route("**/api/comp/pilot", (route) => {
    if (route.request().method() === "PATCH") patched = true;
    return route.continue();
  });

  const name = field(page, "Display name");
  await name.fill("   ");
  await save(page).click();

  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription("Display name is required");
  await expect(name).toBeFocused();
  expect(patched).toBe(false);
  await expect(toasts(page)).toHaveCount(0);
});

test("a dropped connection is shown beside Save, and keeps what was typed", async ({ page }) => {
  await page.route("**/api/comp/pilot", (route) =>
    route.request().method() === "PATCH" ? route.abort("internetdisconnected") : route.continue()
  );

  const glider = field(page, "Glider");
  const typed = `Unsent Wing ${Date.now() % 100_000}`;
  await glider.fill(typed);
  await save(page).click();

  const banner = profileCard(page).getByRole("alert").filter({
    hasText: "Could not reach GlideComp. Check your connection, then try again.",
  });
  await expect(banner).toBeVisible();
  await expect(banner).toBeFocused();
  await expect(glider).toHaveValue(typed);
  await expect(glider).not.toHaveAttribute("aria-invalid", "true");
  await expect(toasts(page)).toHaveCount(0);
  // Still unsaved, so still guarded.
  await expect(profileCard(page).getByText("Unsaved changes")).toBeVisible();

  // Back online, the same Save goes through.
  await page.unroute("**/api/comp/pilot");
  await save(page).click();
  await expect(profileCard(page).getByText(/Profile saved/)).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("a failed Revoke is shown in the API keys card, not a toast", async ({ page }) => {
  // A key that exists only in this response, and a revoke the server refuses:
  // no real key is made or lost.
  await page.route("**/api/auth/api-key/list", (route) =>
    route.fulfill({
      json: {
        apiKeys: [
          {
            id: "fake-key",
            name: "Fixture key",
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
            lastRequest: null,
            expiresAt: "2099-01-01T00:00:00Z",
          },
        ],
      },
    })
  );
  await page.route("**/api/auth/api-key/delete", (route) =>
    route.fulfill({ status: 500, json: { message: "boom" } })
  );
  await page.reload();

  const keysCard = page
    .locator("section[data-slot=card]")
    .filter({ has: page.getByRole("heading", { name: "API keys", exact: true }) });
  const row = keysCard.getByRole("row").filter({ hasText: "Fixture key" });
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();

  const failure = keysCard.getByRole("alert").filter({
    hasText: "Failed to revoke key. Please try again.",
  });
  await expect(failure).toBeVisible();
  await expect(failure).toBeFocused();
  await expect(row).toBeVisible();
  await expect(toasts(page)).toHaveCount(0);
});

test("a Delete account that never got an answer says so in its card", async ({ page }) => {
  await page.route("**/api/auth/delete-account", (route) => route.abort("internetdisconnected"));

  const dangerCard = page
    .locator("section[data-slot=card]")
    .filter({ has: page.getByRole("heading", { name: "Danger zone", exact: true }) });
  await dangerCard.getByRole("button", { name: "Delete account" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete my account" }).click();

  const failure = dangerCard.getByRole("alert").filter({
    hasText: "Could not reach GlideComp. Check your connection, then try again.",
  });
  await expect(failure).toBeVisible();
  await expect(failure).toBeFocused();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(toasts(page)).toHaveCount(0);
});
