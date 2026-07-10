import { test, expect } from "@playwright/test";

test("dev login, onboarding, create competition and task", async ({ page }) => {
  // Use a short random suffix to stay within the 20-char username limit
  const suffix = String(Date.now()).slice(-6);
  const testUser = {
    name: "E2E Test Pilot",
    email: `e2e-${suffix}@test.local`,
  };
  const username = `e2e-pilot-${suffix}`;

  // Step 1: Dev login — POST sets session cookie
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: testUser,
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(
      `Dev login failed: ${loginRes.status()} ${loginRes.statusText()} — ${body}`
    );
  }

  // Extract session cookie from response and set in browser context
  const setCookieHeader = loginRes.headers()["set-cookie"];
  if (setCookieHeader) {
    const tokenMatch = setCookieHeader.match(
      /better-auth\.session_token=([^;]+)/
    );
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

  // Step 2: A brand-new user (no username yet) who lands anywhere in the app
  // must be pushed through onboarding first (#303). Sign-in drops them on
  // /comp; the Shell's onboarding gate should redirect them to /onboarding.
  await page.goto("/comp");
  await page.waitForURL("**/onboarding");

  // Step 3: Complete onboarding. The full-name field is pre-filled from the
  // auth user; assertion doubles as the "page is interactive" sync point.
  await expect(page.getByLabel("Full name")).toHaveValue(testUser.name);
  await page.getByLabel("Username").fill(username);
  await page.getByRole("button", { name: "Continue" }).click();

  // Should land on the user's dashboard (full page load so the user context
  // picks up the new username)
  await page.waitForURL(`**/u/${username}`);

  // Step 4: Navigate to competitions page. The "Start a new competition"
  // button renders once the signed-in user resolves; click auto-waits.
  await page.goto("/comp");

  // Step 5: Create a competition
  await page.getByRole("button", { name: "Start a new competition" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Name").fill("E2E Test Competition");
  // Category defaults to HG — no change needed. Mark as test competition.
  await createDialog
    .getByRole("checkbox", { name: /Test competition/ })
    .click();
  await createDialog.getByRole("button", { name: "Create" }).click();

  // Client-side navigation to the competition detail page; the heading
  // assertion polls until the comp fetch resolves.
  await page.waitForURL("**/comp/*");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "E2E Test Competition"
  );

  // Step 6: Create a task
  await page.getByRole("button", { name: "New Task" }).click();
  const taskDialog = page.getByRole("dialog");
  await taskDialog.getByLabel("Name").fill("Day 1 - Ridge Run");
  await taskDialog.getByLabel("Date").fill("2026-04-15");
  // Pilot class checkboxes default to all checked (just "open")
  await taskDialog.getByRole("button", { name: "Create" }).click();

  // A successful create closes the dialog and re-fetches the comp; the task
  // link assertion polls until the refreshed task list renders.
  await expect(
    page.getByRole("link", { name: /Day 1 - Ridge Run/ })
  ).toBeVisible();
});
