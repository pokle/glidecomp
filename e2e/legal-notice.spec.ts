/**
 * The "our terms changed" toast (web/frontend/src/react/lib/legal-notice.ts):
 * shown to signed-in readers of the SPA during the 14-day notice window, and
 * never again once closed for that version.
 *
 * The toast stays quiet under `navigator.webdriver` so it cannot sit over the
 * rest of the suite's clicks; this spec clears that flag, and fixes the clock
 * inside the window so the spec keeps meaning something after the cutoff.
 */
import { test, expect, type Page } from "./fixtures/test";
import {
  LEGAL_NOTICE,
  LEGAL_NOTICE_DAYS,
} from "../web/frontend/src/react/lib/legal-notice";

const TEST_USER = { name: "Notice Reader", email: "legal-notice@test.local" };
const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLISHED = Date.parse(`${LEGAL_NOTICE.version}T00:00:00Z`);

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/dev-login", { data: TEST_USER });
  if (!res.ok()) throw new Error(`Dev login failed: ${res.status()} — ${await res.text()}`);
  const token = res.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false });
  });
});

const notice = (page: Page) => page.getByText(LEGAL_NOTICE.message);

/** The page has loaded and knows who is reading it. */
async function settled(page: Page, signedIn: boolean): Promise<void> {
  await expect(page.getByRole("searchbox")).toBeVisible({ timeout: 15_000 });
  await expect(
    signedIn
      ? page.getByRole("button", { name: "Account menu" })
      : page.getByRole("button", { name: "Sign in", exact: true })
  ).toBeVisible({ timeout: 15_000 });
}

test("a signed-in reader sees it once, and not after closing it", async ({ page }) => {
  await page.clock.setFixedTime(new Date(PUBLISHED + 2 * DAY_MS));
  await devLogin(page);
  await page.goto("/comp");
  await expect(notice(page)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Read" })).toBeVisible();

  await page.getByRole("button", { name: /close/i }).click();
  await expect(notice(page)).toBeHidden();

  await page.reload();
  await settled(page, true);
  // The toast appears ~1 s after load; give it well past that to NOT appear.
  await page.waitForTimeout(2_500);
  await expect(notice(page)).toBeHidden();
});

test("Read goes to the legal page", async ({ page }) => {
  await page.clock.setFixedTime(new Date(PUBLISHED + DAY_MS));
  await devLogin(page);
  await page.goto("/comp");
  await page.getByRole("button", { name: "Read" }).click({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/legal$/);
});

test("nobody sees it after the cutoff", async ({ page }) => {
  await page.clock.setFixedTime(new Date(PUBLISHED + LEGAL_NOTICE_DAYS * DAY_MS));
  await devLogin(page);
  await page.goto("/comp");
  await settled(page, true);
  await page.waitForTimeout(2_500);
  await expect(notice(page)).toBeHidden();
});

test("a signed-out visitor does not see it", async ({ page }) => {
  await page.clock.setFixedTime(new Date(PUBLISHED + DAY_MS));
  await page.goto("/comp");
  await settled(page, false);
  await page.waitForTimeout(2_500);
  await expect(notice(page)).toBeHidden();
});
