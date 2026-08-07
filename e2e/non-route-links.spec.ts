/**
 * Links that leave the SPA must LEAVE it.
 *
 * A RAC Link inside RacRouterProvider hands a same-origin click to
 * react-router. For a URL the server owns — a Pages Function download, another
 * Vite entry — react-router matches no route and renders the 404 page, and
 * only a reload (a real request) produces the file. The superadmin CIVL
 * rankings button did exactly that.
 *
 * Signs in as the seeded super admin because the Superadmin card is the only
 * place this link lives. It creates nothing, so there is nothing to sweep.
 */
import { test, expect } from "./fixtures/test";
import { SUPER_ADMIN } from "./fixtures/stack";

test.beforeEach(async ({ page }) => {
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: SUPER_ADMIN,
  });
  expect(loginRes.ok(), await loginRes.text()).toBe(true);
  const setCookie = loginRes.headers()["set-cookie"];
  const token = setCookie?.match(/better-auth\.session_token=([^;]+)/);
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
});

test("the CIVL rankings button downloads the CSV instead of routing to 404", async ({
  page,
}) => {
  await page.goto("/settings");
  const link = page.getByRole("link", { name: "CIVL rankings (CSV)" });
  await expect(link).toBeVisible({ timeout: 15_000 });

  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("civl-rankings.csv");

  // The reason this test exists: a client-side navigation would have swapped
  // the page for the 404 and moved the URL off /settings.
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});
