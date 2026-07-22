/**
 * Settings page save models (see the Settings.tsx section comments):
 *
 * - Instant sections (Appearance, Units) apply on click and flash a
 *   transient "Saved ✓" in the card header.
 * - The Profile form saves explicitly: Save is disabled until the form is
 *   dirty, an "Unsaved changes" hint appears beside it, and while dirty a
 *   capture-phase guard intercepts in-app navigation with a Discard/Keep
 *   confirm dialog (BrowserRouter has no useBlocker).
 *
 * Runs as a dedicated fixture user (not the seeded super-admin) so unit and
 * profile mutations never touch state other specs depend on. Cookie plumbing
 * matches comp-waypoints.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";

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

test.beforeEach(async ({ page }) => {
  await devLogin(page);
  await page.goto("/settings");
  // The profile form fetch is the slowest section — its Save button is the
  // sync point that the signed-in page is fully interactive.
  await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible({
    timeout: 15_000,
  });
});

test("units apply instantly and flash a Saved confirmation", async ({ page }) => {
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
  const save = page.getByRole("button", { name: "Save profile" });
  await expect(save).toBeDisabled();
  await expect(page.getByText("Unsaved changes")).toBeHidden();

  // The fixture user needs a display name for the form to be valid.
  const name = page.getByLabel("Display name");
  if ((await name.inputValue()) === "") await name.fill(TEST_USER.name);

  const glider = page.getByLabel("Glider");
  await glider.fill(`E2E Glider ${Date.now()}`);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(save).toBeEnabled();

  await save.click();
  await expect(page.getByText(/Profile saved/)).toBeVisible();
  // The just-saved values are the new baseline: clean form, disabled button.
  await expect(save).toBeDisabled();
  await expect(page.getByText("Unsaved changes")).toBeHidden();
});

test("navigating away from a dirty profile is guarded", async ({ page }) => {
  const glider = page.getByLabel("Glider");
  const originalGlider = await glider.inputValue();
  await glider.fill("Unsaved Wing");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Keep editing: navigation cancelled, edit retained.
  await page.getByRole("link", { name: "Competitions" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Discard profile changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(glider).toHaveValue("Unsaved Wing");

  // Discard: navigation proceeds, nothing was saved.
  await page.getByRole("link", { name: "Competitions" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(/\/comp$/);

  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Save profile" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel("Glider")).toHaveValue(originalGlider);
});

test("a clean profile navigates without any prompt", async ({ page }) => {
  await page.getByRole("link", { name: "Competitions" }).click();
  await expect(page).toHaveURL(/\/comp$/);
  await expect(page.getByRole("alertdialog")).toBeHidden();
});
