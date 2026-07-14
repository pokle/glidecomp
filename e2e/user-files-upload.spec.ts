import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAMPLE_IGC = resolve(
  __dirname,
  "..",
  "web/samples/comps/corryong-cup-2026-open-t1/lamb_18239_050126.igc"
);
const SAMPLE_XCTSK = resolve(
  __dirname,
  "..",
  "web/samples/comps/corryong-cup-2026-open-t1/task.xctsk"
);

interface TestUser {
  name: string;
  email: string;
  /** Auto-derived at sign-up; filled in by signInAndOnboard(). */
  username: string;
}

function newTestUser(prefix: string): TestUser {
  const suffix = String(Date.now()).slice(-6) + Math.floor(Math.random() * 100);
  return {
    // Suffix in the name so the auto-derived username is unique per run.
    name: `E2E ${prefix} ${suffix}`,
    email: `e2e-${prefix}-${suffix}@test.local`,
    username: "", // resolved from /api/auth/me after sign-in
  };
}

/**
 * Dev-login, read the auto-derived username, and park the page at
 * /u/<username> with a session cookie attached. Mutates `user.username` with
 * the derived handle. Returns once the dashboard's tracks panel has rendered —
 * the file inputs only exist after storage init + the first list refresh, so
 * syncing on the empty state guarantees setInputFiles has a target.
 */
async function signInAndOnboard(
  request: APIRequestContext,
  page: Page,
  user: TestUser
): Promise<void> {
  const loginRes = await request.post("/api/auth/dev-login", {
    data: { name: user.name, email: user.email },
  });
  if (!loginRes.ok()) {
    throw new Error(
      `dev-login failed for ${user.email}: ${loginRes.status()} ${await loginRes.text()}`
    );
  }
  const setCookie = loginRes.headers()["set-cookie"];
  const match = setCookie?.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("dev-login response missing session cookie");
  await page.context().addCookies([
    {
      name: "better-auth.session_token",
      value: match[1],
      domain: "localhost",
      path: "/",
    },
  ]);

  // Usernames are auto-assigned at sign-up now (no onboarding gate); read the
  // one this user got so we can navigate to their dashboard and build the
  // public-by-link URL later.
  const meRes = await request.get("/api/auth/me");
  const me = (await meRes.json()) as { user: { username: string } | null };
  if (!me.user?.username) {
    throw new Error("expected an auto-derived username after dev-login");
  }
  user.username = me.user.username;

  await page.goto(`/u/${user.username}`);
  await expect(page.getByText("No flight tracks yet")).toBeVisible();
}

test("upload IGC file via the My Flights dashboard", async ({ page, request }) => {
  const user = newTestUser("igc");
  await signInAndOnboard(request, page, user);

  // setInputFiles fires the change event the dashboard listens for. Use the
  // file input directly — clicking the upload-zone label would open the OS
  // file picker which Playwright would have to negotiate via filechooser.
  await page.setInputFiles('input[accept=".igc"]', SAMPLE_IGC);

  // The list reflows after the refresh; look for the parsed pilot name from
  // the IGC header so we know the round-trip happened and we're not just
  // seeing the filename.
  await expect(page.getByRole("link", { name: /Michael lamb/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Tracks (1)" })).toBeVisible();
});

test("upload XCTSK file via the Tasks tab", async ({ page, request }) => {
  const user = newTestUser("xctsk");
  await signInAndOnboard(request, page, user);

  // Base UI only mounts the active tab panel, so the .xctsk input exists
  // only once the Tasks tab is selected.
  await page.getByRole("tab", { name: /Tasks/ }).click();
  await expect(page.getByText("No competition tasks yet")).toBeVisible();
  await page.setInputFiles('input[accept=".xctsk"]', SAMPLE_XCTSK);

  // Sample task has 5 turnpoints; assert the count rather than the name so the
  // assertion stays meaningful even if deriveTaskName() changes its format.
  await expect(page.getByText(/turnpoint/).first()).toBeVisible();
  await expect(page.getByRole("tab", { name: "Tasks (1)" })).toBeVisible();
});

test("delete an uploaded track", async ({ page, request }) => {
  const user = newTestUser("del");
  await signInAndOnboard(request, page, user);

  await page.setInputFiles('input[accept=".igc"]', SAMPLE_IGC);
  const trackItem = page.locator("li", { hasText: "Michael lamb" });
  await expect(trackItem).toBeVisible();

  await trackItem.getByRole("button", { name: "Remove" }).click();
  // Removal now asks for confirmation (IA v2 #277).
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();

  await expect(page.getByText("No flight tracks yet")).toBeVisible();
  await expect(page.locator('a[href*="storedTrack="]')).toHaveCount(0);
});

test("delete an uploaded task", async ({ page, request }) => {
  const user = newTestUser("tdel");
  await signInAndOnboard(request, page, user);

  await page.getByRole("tab", { name: /Tasks/ }).click();
  await page.setInputFiles('input[accept=".xctsk"]', SAMPLE_XCTSK);
  const taskItem = page.locator("li", { hasText: /turnpoint/ });
  await expect(taskItem).toBeVisible();

  await taskItem.getByRole("button", { name: "Remove" }).click();
  // Removal now asks for confirmation (IA v2 #277).
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();

  await expect(page.getByText("No competition tasks yet")).toBeVisible();
  await expect(page.locator('a[href*="storedTask="]')).toHaveCount(0);
});

test("public-link viewer can read a track uploaded by another user", async ({
  browser,
  request,
}) => {
  // Owner uploads a track, then we open it as a separate, unauthenticated
  // browser context to make sure the public-link endpoint (/api/u/…) actually
  // serves it without the owner's session cookie.
  const owner = newTestUser("own");
  const ownerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  await signInAndOnboard(request, ownerPage, owner);
  await ownerPage.setInputFiles('input[accept=".igc"]', SAMPLE_IGC);

  // Pull the track_id straight from the dashboard link — the storage layer
  // stores it as a sha256 hex on the analysis href.
  const trackLink = ownerPage.locator('a[href*="storedTrack="]').first();
  await expect(trackLink).toBeVisible();
  const trackHref = await trackLink.getAttribute("href");
  const trackId = trackHref?.match(/storedTrack=([0-9a-f]{64})/)?.[1];
  expect(trackId, `expected a sha256 track id in ${trackHref}`).toBeTruthy();
  await ownerCtx.close();

  // Anonymous read via the worker — no cookies. This exercises the same
  // /api/u/:username/track/:sha endpoint the analysis page uses.
  const anonRes = await request.get(
    `/api/u/${owner.username}/track/${trackId}`
  );
  expect(anonRes.status()).toBe(200);
  const body = await anonRes.body();
  // The endpoint returns the gzipped IGC; expect the gzip magic header.
  expect(body[0]).toBe(0x1f);
  expect(body[1]).toBe(0x8b);

  // Display name and filename are echoed in custom headers so the analysis
  // page doesn't need an extra metadata round-trip.
  expect(anonRes.headers()["x-filename"]).toBe("lamb_18239_050126.igc");
  expect(anonRes.headers()["x-display-name"]).toContain("Michael lamb");
});
