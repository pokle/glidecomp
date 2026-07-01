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

  // Step 2: Navigate to onboarding (new user has no username)
  await page.goto("/onboarding.html");

  // Step 3: Complete onboarding
  await expect(page.locator("#onboarding-name")).toHaveValue(testUser.name);
  await page.fill("#username", username);
  await page.click("#onboarding-submit");

  // Should redirect to the user's dashboard
  await page.waitForURL(`**/u/${username}/*`);

  // Step 4: Navigate to competitions page
  await page.goto("/comp");
  await page.waitForSelector("#comp-page:not(.hidden)");

  // The "New Competition" button should be visible for authenticated users
  await expect(page.locator("#create-comp-btn")).toBeVisible();

  // comp.ts attaches the dialog-opening click handler only after loadComps()
  // resolves. Wait for the loading skeleton to be gone (replaced by cards or
  // the empty state) — that's the actual signal the listener is attached.
  // networkidle is the wrong tool here: it can resolve during a brief gap
  // between unrelated requests before loadComps() has even started, or hang
  // indefinitely on an unrelated in-flight request left over from the
  // previous page.
  await expect(
    page.locator('[aria-label="Loading competitions"]')
  ).toBeHidden();

  // Step 5: Create a competition
  await page.click("#create-comp-btn");
  await page.waitForSelector("dialog#create-comp-dialog[open]");
  await page.fill("#comp-name", "E2E Test Competition");
  // Category defaults to HG (pre-checked) — no change needed
  // Mark as test competition
  await page.check("#comp-test");
  await page.click("#create-submit-btn");

  // Should navigate to the competition detail page. toHaveText already
  // polls until comp-detail.ts's fetch resolves and populates the title —
  // no need to wait on networkidle first, which was both redundant (the
  // assertion already retries) and a source of hangs when a leftover
  // in-flight request from the previous page never settles.
  await page.waitForURL("**/comp/*");
  await expect(page.locator("#comp-title")).toHaveText("E2E Test Competition");

  // Step 6: Create a task
  await expect(page.locator("#create-task-btn")).toBeVisible();
  await page.click("#create-task-btn");
  await page.waitForSelector("dialog#create-task-dialog[open]");
  await page.fill("#task-name", "Day 1 - Ridge Run");
  await page.fill("#task-date", "2026-04-15");
  // Pilot class checkboxes default to all checked (just "open")
  // Click submit and wait for both the POST response and the subsequent
  // page reload. The form handler calls window.location.reload() after a
  // successful POST — we need to capture that reload navigation so the
  // assertions below run against the fresh page, not the pre-reload DOM.
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/comp/") &&
        r.url().includes("/task") &&
        r.request().method() === "POST"
    ),
    page.click("#task-submit-btn"),
  ]);

  // The reload is now in-flight. toContainText polls until initCompDetail()
  // has fetched and rendered the task list — see the toHaveText assertion
  // above for why we don't wait on networkidle here either.
  await expect(page.locator("#tasks-list")).toContainText("Day 1 - Ridge Run");
});
