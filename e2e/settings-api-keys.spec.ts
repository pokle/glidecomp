/**
 * Creating an API key in account settings, on a phone and on a desktop (#821,
 * and #863 for the pages).
 *
 * It took two dialogs: one with a Label field, then one showing the new key.
 * A dialog with a text field is the overlay docs/interaction-guide.md rules out (the iPhone
 * keyboard), so both are gone. The keys are a list (/settings/api-keys) with
 * + in its bar; + opens a form page (/settings/api-keys/new) with Create in
 * the bar, and the new key takes the form's place on that page. These tests
 * hold that no dialog opens, that a refusal lands under Label rather than in
 * a toast, and that the secret lives only on the screen — a reload shows the
 * key in the list and the secret nowhere.
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

const main = (page: Page) => page.getByRole("main");
const label = (page: Page) => main(page).getByRole("textbox", { name: "Label (optional)" });
/** The bar's commit button on the page that makes a key. */
const create = (page: Page) => main(page).getByRole("button", { name: "Create", exact: true });
const created = (page: Page) => page.getByRole("region", { name: "API key created" });
const keyRow = (page: Page, text: string) => main(page).getByRole("row").filter({ hasText: text });

/** From the list: + in the bar opens the page that makes a key. */
async function openNewKey(page: Page): Promise<void> {
  await main(page).getByRole("link", { name: "Create API key" }).click();
  await expect(page).toHaveURL(/\/settings\/api-keys\/new$/);
  await expect(page.getByRole("heading", { name: "New API key", level: 1 })).toBeVisible();
}

/** Back, from the key or the form, to the list it belongs to. */
async function backToList(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Back to API keys" }).click();
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
}

test.beforeEach(async ({ page, baseURL }) => {
  await devLogin(page);
  await revokeAll(page, baseURL!);
  await page.goto("/settings/api-keys");
  await expect(main(page).getByText("No API keys yet.")).toBeVisible({ timeout: 15_000 });
});

test.afterEach(async ({ page, baseURL }) => {
  await revokeAll(page, baseURL!);
});

test("a key is created on its page, shown in place, and gone after a reload", async ({ page }) => {
  const name = `e2e key ${Date.now() % 100_000}`;
  await openNewKey(page);
  // A form page: Cancel where a read page has Back.
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  // SEC-57: every key lives 90 days, and the form says so before it is made.
  await expect(
    main(page).getByText("This key will expire in 90 days. Create a new one when it does.")
  ).toBeVisible();

  await label(page).fill(name);
  await create(page).click();

  // In place, not in a dialog, and in a live region.
  await expect(created(page)).toBeVisible();
  await expect(page.getByRole("status").filter({ has: created(page) })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(created(page).getByText("Copy this key now — it won't be shown again.")).toBeVisible();
  const secret = (await created(page).locator("code").textContent())?.trim() ?? "";
  expect(secret).toMatch(/^glc_/);
  await expect(created(page).getByRole("heading", { name: "API key created" })).toBeFocused();
  await expect(created(page)).toBeInViewport();
  await expect(created(page).getByRole("button", { name: "Copy" })).toBeVisible();
  // The key took the form's place: nothing is left to create or to cancel.
  await expect(create(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  // The secret never reached the URL or history state.
  expect(page.url()).not.toContain(secret);
  expect(JSON.stringify(await page.evaluate(() => history.state))).not.toContain(secret);

  // Back: the list has it, with its expiry.
  await backToList(page);
  const row = keyRow(page, name);
  const expected = await page.evaluate(() =>
    new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toLocaleDateString()
  );
  // The label is the row header; the grid cells are Created, Last used, Expires.
  await expect(row.getByRole("gridcell").nth(2)).toHaveText(expected);
  await expect(row.getByRole("gridcell").nth(1)).toHaveText("Never");
  await expect(page.getByText(secret)).toHaveCount(0);

  // A reload: the key is in the list, and its secret is nowhere on the page.
  await page.reload();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(created(page)).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);
});

test("a reload of the new key's page shows the form, and the secret nowhere", async ({ page }) => {
  await openNewKey(page);
  // The label is optional, so Create is live with nothing typed.
  await expect(create(page)).toBeEnabled();
  await create(page).click();
  await expect(created(page)).toBeVisible();
  const secret = (await created(page).locator("code").textContent())?.trim() ?? "";

  await page.reload();
  await expect(label(page)).toBeVisible({ timeout: 15_000 });
  await expect(created(page)).toHaveCount(0);
  await expect(page.getByText(secret)).toHaveCount(0);

  // No label: the list says so. The page is the form again, so its way out
  // is Cancel, and with nothing typed it leaves without asking.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/api-keys$/);
  await expect(keyRow(page, "Unnamed")).toBeVisible();
});

test("a label the server refuses is shown under Label, focused, and nothing is made", async ({
  page,
}) => {
  // One character past the api-key plugin's limit (32): a real refusal from
  // auth-api, in Better Auth's `{ code, message }`, mapped onto the field.
  const tooLong = "x".repeat(33);
  await openNewKey(page);
  await label(page).fill(tooLong);
  await create(page).click();

  const field = label(page);
  await expect(main(page)).toContainText("A label can be at most 32 characters.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(tooLong);
  await expect(created(page)).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Never a toast (sonner's list).
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  // And nothing was made.
  const list = await page.request.get("/api/auth/api-key/list");
  expect(((await list.json()) as { apiKeys: unknown[] }).apiKeys).toHaveLength(0);

  // Editing clears it, and a label that fits is made.
  await field.press("Backspace");
  await expect(main(page)).not.toContainText("A label can be at most 32 characters.");
  await create(page).click();
  await expect(created(page)).toBeVisible();
  await backToList(page);
  await expect(keyRow(page, "x".repeat(32))).toBeVisible();
});
