/**
 * Creating an API key on Settings, on a phone and on a desktop (#821).
 *
 * It took two dialogs: one with a Label field, then one showing the new key.
 * A dialog with a text field is the overlay CLAUDE.md rules out (the iPhone
 * keyboard), so both are gone: the Label field and Create are a kit form on
 * the page, and the new key shows in place under them. These tests hold that
 * no dialog opens, that a refusal lands under Label rather than in a toast,
 * and that the secret lives only on the screen — a reload shows the key in
 * the list and the secret nowhere.
 *
 * Runs as its own fixture user so its keys never meet another spec's, and
 * revokes whatever it made, because the local D1 persists between runs.
 */
import { test, expect, type Page } from "./fixtures/test";

const TEST_USER = { name: "API Keys Fixture", email: "settings-api-keys@test.local" };

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

/**
 * Revoke every key the fixture user holds, through the same routes Settings
 * uses. Better Auth refuses a POST without the site's Origin, as a browser
 * would send it.
 */
async function revokeAll(page: Page, origin: string): Promise<void> {
  const res = await page.request.get("/api/auth/api-key/list");
  expect(res.ok(), "listing the fixture user's keys").toBe(true);
  const { apiKeys } = (await res.json()) as { apiKeys: Array<{ id: string }> };
  for (const { id } of apiKeys) {
    const del = await page.request.post("/api/auth/api-key/delete", {
      data: { keyId: id },
      headers: { origin },
    });
    expect(del.ok(), `revoking key ${id}`).toBe(true);
  }
}

const keysCard = (page: Page) =>
  page
    .locator("section[data-slot=card]")
    .filter({ has: page.getByRole("heading", { name: "API keys", exact: true }) });
const label = (page: Page) => keysCard(page).getByRole("textbox", { name: "Label (optional)" });
const create = (page: Page) => keysCard(page).getByRole("button", { name: "Create API key" });
const created = (page: Page) => page.getByRole("region", { name: "API key created" });

test.beforeEach(async ({ page, baseURL }) => {
  await devLogin(page);
  await revokeAll(page, baseURL!);
  await page.goto("/settings");
  await expect(keysCard(page).getByText("No API keys yet.")).toBeVisible({ timeout: 15_000 });
});

test.afterEach(async ({ page, baseURL }) => {
  await revokeAll(page, baseURL!);
});

test("a key is created on the page, shown in place, and gone after a reload", async ({ page }) => {
  const name = `e2e key ${Date.now() % 100_000}`;
  // SEC-57: every key lives 90 days, and the form says so before it is made.
  await expect(
    keysCard(page).getByText("This key will expire in 90 days. Create a new one when it does.")
  ).toBeVisible();

  await label(page).fill(name);
  await create(page).click();

  // In place, not in a dialog.
  await expect(created(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(created(page).getByText("Copy this key now — it won't be shown again.")).toBeVisible();
  const secret = (await created(page).locator("code").textContent())?.trim() ?? "";
  expect(secret).toMatch(/^glc_/);
  await expect(created(page).getByRole("heading", { name: "API key created" })).toBeFocused();
  await expect(created(page).getByRole("button", { name: "Copy" })).toBeVisible();
  // Ready for another: the label is cleared.
  await expect(label(page)).toHaveValue("");

  // The list already has it, with its expiry.
  const row = keysCard(page).getByRole("row").filter({ hasText: name });
  const expected = await page.evaluate(() =>
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toLocaleDateString()
  );
  // The label is the row header; the grid cells are Created, Last used, Expires.
  await expect(row.getByRole("gridcell").nth(2)).toHaveText(expected);
  await expect(row.getByRole("gridcell").nth(1)).toHaveText("Never");

  // The secret never reached the URL or history state.
  expect(page.url()).not.toContain(secret);
  expect(JSON.stringify(await page.evaluate(() => history.state))).not.toContain(secret);

  // A reload: the key is in the list, and its secret is nowhere on the page.
  await page.reload();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(created(page)).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);
});

test("Done puts the key away and hands focus back to Label", async ({ page }) => {
  await create(page).click();
  await expect(created(page)).toBeVisible();
  // No label: the list says so.
  await expect(keysCard(page).getByRole("row").filter({ hasText: "Unnamed" })).toBeVisible();

  await created(page).getByRole("button", { name: "Done" }).click();
  await expect(created(page)).toHaveCount(0);
  await expect(label(page)).toBeFocused();
});

test("a label the server refuses is shown under Label, focused, and nothing is made", async ({
  page,
}) => {
  // One character past the api-key plugin's limit (32): a real refusal from
  // auth-api, in Better Auth's `{ code, message }`, mapped onto the field.
  const tooLong = "x".repeat(33);
  await label(page).fill(tooLong);
  await create(page).click();

  const field = label(page);
  await expect(keysCard(page)).toContainText("A label can be at most 32 characters.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(tooLong);
  await expect(created(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Never a toast (sonner's list).
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  await expect(keysCard(page).getByText("No API keys yet.")).toBeVisible();

  // Editing clears it, and a label that fits is made.
  await field.press("Backspace");
  await expect(keysCard(page)).not.toContainText("A label can be at most 32 characters.");
  await create(page).click();
  await expect(created(page)).toBeVisible();
  await expect(keysCard(page).getByRole("row").filter({ hasText: "x".repeat(32) })).toBeVisible();
});
