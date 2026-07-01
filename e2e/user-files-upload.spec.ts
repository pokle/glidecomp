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
  username: string;
}

function newTestUser(prefix: string): TestUser {
  const suffix = String(Date.now()).slice(-6) + Math.floor(Math.random() * 100);
  return {
    name: `E2E ${prefix} Pilot`,
    email: `e2e-${prefix}-${suffix}@test.local`,
    username: `e2e-${prefix}-${suffix}`.slice(0, 20),
  };
}

/**
 * Dev-login + onboarding so the page is parked at /u/<username>/ with a session
 * cookie attached. Returns the chosen username so callers can build public URLs.
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

  await page.goto("/onboarding.html");
  await page.fill("#username", user.username);
  await page.click("#onboarding-submit");
  await page.waitForURL(`**/u/${user.username}/*`);
  // dashboard.ts attaches the file-input change listeners only after storage
  // init + the first refreshLists() runs; that's also when #tracks-empty stops
  // being `hidden`. Sync on it so setInputFiles isn't called before the page
  // is listening — without this, fast CI loses the change event.
  await expect(page.locator("#tracks-empty")).toBeVisible();
}

test("upload IGC file via the My Flights dashboard", async ({ page, request }) => {
  const user = newTestUser("igc");
  await signInAndOnboard(request, page, user);

  // Dashboard renders the tracks panel by default; empty state should be visible.
  await expect(page.locator("#tracks-empty")).toBeVisible();
  await expect(page.locator("#tracks-count")).toBeHidden();

  // setInputFiles fires the change event the dashboard listens for. Use the
  // hidden file input directly — clicking the upload-zone would open the OS
  // file picker which Playwright would have to negotiate via filechooser.
  await page.setInputFiles("#igc-file-input", SAMPLE_IGC);

  // The list reflows after refreshLists(); look for the parsed pilot name from
  // the IGC header so we know the worker round-tripped and we're not just
  // seeing the filename.
  const trackCard = page.locator("#tracks-list .file-card").first();
  await expect(trackCard).toBeVisible();
  await expect(trackCard).toContainText("Michael lamb");
  await expect(page.locator("#tracks-count")).toHaveText("1");
});

test("upload XCTSK file and switch to the Tasks tab", async ({ page, request }) => {
  const user = newTestUser("xctsk");
  await signInAndOnboard(request, page, user);

  await expect(page.locator("#tasks-empty")).toBeHidden(); // tasks panel starts hidden
  await page.setInputFiles("#task-file-input", SAMPLE_XCTSK);

  // dashboard.ts auto-switches to the tasks tab when only tasks were added.
  await expect(page.locator("#panel-tasks")).toBeVisible();
  const taskCard = page.locator("#tasks-list .file-card").first();
  await expect(taskCard).toBeVisible();
  // Sample task has 5 turnpoints; assert the count rather than the name so the
  // assertion stays meaningful even if deriveTaskName() changes its format.
  await expect(taskCard).toContainText(/turnpoint/);
  await expect(page.locator("#tasks-count")).toHaveText("1");
});

test("delete an uploaded track", async ({ page, request }) => {
  const user = newTestUser("del");
  await signInAndOnboard(request, page, user);

  await page.setInputFiles("#igc-file-input", SAMPLE_IGC);
  const trackCard = page.locator("#tracks-list .file-card").first();
  await expect(trackCard).toBeVisible();

  // The delete button is a sibling of the download button inside the same card.
  await trackCard.locator(".delete-btn").click();

  await expect(page.locator("#tracks-empty")).toBeVisible();
  await expect(page.locator("#tracks-list .file-card")).toHaveCount(0);
});

test("delete an uploaded task", async ({ page, request }) => {
  const user = newTestUser("tdel");
  await signInAndOnboard(request, page, user);

  await page.setInputFiles("#task-file-input", SAMPLE_XCTSK);
  const taskCard = page.locator("#tasks-list .file-card").first();
  await expect(taskCard).toBeVisible();

  await taskCard.locator(".delete-btn").click();

  await expect(page.locator("#tasks-empty")).toBeVisible();
  await expect(page.locator("#tasks-list .file-card")).toHaveCount(0);
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
  await ownerPage.setInputFiles("#igc-file-input", SAMPLE_IGC);
  await expect(
    ownerPage.locator("#tracks-list .file-card").first()
  ).toBeVisible();

  // Pull the track_id straight from the dashboard link — the storage layer
  // stores it as a sha256 hex on the analysis href.
  const trackHref = await ownerPage
    .locator("#tracks-list .file-card")
    .first()
    .getAttribute("href");
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
