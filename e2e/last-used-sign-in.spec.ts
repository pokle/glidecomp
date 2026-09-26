/**
 * The sign-in page's "Last used" pill follows a Google sign-in
 * (web/frontend/src/auth/last-sign-in.ts).
 *
 * Local dev has no Google, so the OAuth round trip is stood in for: the
 * social sign-in request is intercepted, a real session is made with
 * dev-login, and the client is sent back to the app on the SAME origin —
 * which is what production does. (A branch preview cannot show this: its
 * auth worker's BETTER_AUTH_URL is production, so Google hands the session
 * to glidecomp.com, not to the preview.)
 */
import { test, expect, type Page } from "./fixtures/test";

const TEST_USER = { name: "Last Used Fixture", email: "last-used-signin@test.local" };

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

/** Arrive at /signin signed out, having last signed in by email. */
async function openSignInLastUsedEmail(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.evaluate(() => localStorage.setItem("glidecomp:last-sign-in", "email"));
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Email me a sign-in code/ }).getByTestId("last-used-pill")
  ).toBeVisible();
}

const googlePill = (page: Page) =>
  page.getByRole("button", { name: /Continue with Google/ }).getByTestId("last-used-pill");
const emailPill = (page: Page) =>
  page.getByRole("button", { name: /Email me a sign-in code/ }).getByTestId("last-used-pill");

test("a completed Google sign-in moves the pill to Google", async ({ page }) => {
  await openSignInLastUsedEmail(page);

  await page.route("**/api/auth/sign-in/social", async (route) => {
    await devLogin(page);
    await route.fulfill({ json: { url: "/comp", redirect: true } });
  });
  await page.getByRole("button", { name: /Continue with Google/ }).click();
  await page.waitForURL("**/comp");
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/signin");
  await expect(googlePill(page)).toHaveText("Last used");
  await expect(emailPill(page)).toHaveCount(0);
});

test("a cancelled Google sign-in leaves the pill where it was", async ({ page }) => {
  await openSignInLastUsedEmail(page);

  // Back from Google without a session (the pilot pressed Cancel).
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ json: { url: "/signin", redirect: true } })
  );
  await page.getByRole("button", { name: /Continue with Google/ }).click();
  await page.waitForLoadState("networkidle");

  await expect(emailPill(page)).toHaveText("Last used");
  await expect(googlePill(page)).toHaveCount(0);
});
