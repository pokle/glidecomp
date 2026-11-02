/**
 * A hidden competition's share link, end to end against the real Workers.
 *
 * The comp id is sequential in a public encoding, so a hidden comp opens only
 * for its admins and for a URL that carries its share key after the id
 * (`/comp/<slug>-vzuq_7hq2m9xk4rwd`, web/workers/competition-api/src/share-key.ts).
 * What this pins, as the people who use it see it:
 *  - the organiser's own address bar is the link to share — no share button;
 *  - a visitor with the link reads the comp signed out, keeps the key as they
 *    click into a task, and is told the comp is not yet published;
 *  - the id alone is still "not found";
 *  - the Google Sheets formula is the private link, and works signed out;
 *  - "Reset link" retires every link shared so far.
 *
 * The fixture is a fresh scored comp (fixtures/scored-comp.ts), hidden, and
 * deleted again afterwards.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";
import { createScoredComp, readScore, type ScoredComp } from "./fixtures/scored-comp";
import { idFromSegment } from "../web/frontend/src/react/lib/slug";

const BASE_URL = FRONTEND_URL;

let admin: APIRequestContext;
let fixture: ScoredComp;
/** The comp's key, as the API tells its admin. Changed by the reset test. */
let shareKey: string;

const ORGANISER_NOTE = "Hidden. Anyone you send this page’s link to can see it.";
const VISITOR_NOTE =
  "Not yet published. You can see this competition because someone shared its link with you.";

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  if (!res.ok()) throw new Error(`Dev login failed: ${res.status()}`);
  const token = res.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/)?.[1];
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token, domain: "localhost", path: "/" },
    ]);
  }
}

/** The comp id in the page's current URL — sqid, plus the key if any. */
function urlCompId(page: Page): string {
  return idFromSegment(new URL(page.url()).pathname.split("/")[2] ?? "");
}

async function readShareKey(): Promise<string> {
  const res = await admin.get(`/api/comp/${fixture.compId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { share_key } = (await res.json()) as { share_key: string | null };
  expect(share_key).toMatch(/^[a-z0-9]{12}$/);
  return share_key!;
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(180_000);
  admin = await playwright.request.newContext({ baseURL: BASE_URL });
  const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(signIn.ok(), "super admin dev-login").toBeTruthy();
  fixture = await createScoredComp(admin, "share link");
  // Materialise the task's scores while the comp is public, so no page below
  // waits on a cold compute; then hide it.
  await readScore(admin, fixture);
  const hide = await admin.patch(`/api/comp/${fixture.compId}`, { data: { test: true } });
  expect(hide.ok(), await hide.text()).toBeTruthy();
  shareKey = await readShareKey();
});

test.afterAll(async () => {
  if (fixture?.compId) await admin.delete(`/api/comp/${fixture.compId}`);
  await admin.dispose();
});

test("the organiser's address bar is the share link", async ({ page }) => {
  await devLogin(page);
  // A bare URL — an old bookmark, a search result — settles on the keyed one.
  await page.goto(`/comp/${fixture.compId}`);
  await expect(page.getByText(ORGANISER_NOTE)).toBeVisible();
  await expect.poll(() => urlCompId(page)).toBe(`${fixture.compId}_${shareKey}`);
  // The organiser can still submit to their own hidden comp — which is what
  // makes the visitor's missing button below a real finding.
  await expect(page.getByRole("main").getByRole("link", { name: "Submit track" })).toBeVisible();
});

test("a visitor with the link reads the comp signed out and keeps the key", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    await page.goto(`/comp/${fixture.compId}_${shareKey}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("share link");
    await expect(page.getByText(VISITOR_NOTE)).toBeVisible();
    // The link is for reading a draft: no Submit track, which every write
    // route would refuse. (The organiser sees it on this same page — see the
    // test above.)
    await expect(page.getByRole("main").getByRole("link", { name: "Submit track" })).toHaveCount(0);

    // Into a task: the key rides along in the id, so the page still opens.
    await page.getByRole("link", { name: "Task 4" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Task 4");
    expect(urlCompId(page)).toBe(`${fixture.compId}_${shareKey}`);
    await expect(page.getByRole("main").getByRole("button", { name: "Submit track" })).toHaveCount(0);

    // The id alone opens nothing.
    await page.goto(`/comp/${fixture.compId}`);
    await expect(page.getByText(VISITOR_NOTE)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).not.toContainText("share link");
  } finally {
    await context.close();
  }
});

test("a keyed API response is never shared-cached or indexed", async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: BASE_URL });
  try {
    const keyed = await anon.get(`/api/comp/${fixture.compId}_${shareKey}/scores`);
    expect(keyed.status()).toBe(200);
    expect(keyed.headers()["cache-control"]).toBe("private, no-store");
    expect(keyed.headers()["x-robots-tag"]).toBe("noindex");
    expect((await anon.get(`/api/comp/${fixture.compId}/scores`)).status()).toBe(404);
  } finally {
    await anon.dispose();
  }
});

test("the Google Sheets formula is the private link, and works signed out", async ({
  browser,
  playwright,
}) => {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  try {
    await page.goto(`/comp/${fixture.compId}_${shareKey}/scores`);
    await page.getByRole("button", { name: "Download" }).click();
    await page.getByRole("menuitem", { name: /Open in Google Sheets/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(
        "This formula includes the competition’s private link. Anyone who can open the sheet can open the competition."
      )
    ).toBeVisible();
    const formula = (await dialog.locator("code").textContent()) ?? "";
    expect(formula).toContain(`${fixture.compId}_${shareKey}/scores.csv`);

    // What Google would fetch: signed out, the keyed CSV, whose rows link
    // back with the key too.
    const csvPath = new URL(formula.match(/"([^"]+)"/)![1]).pathname;
    const anon = await playwright.request.newContext({ baseURL: BASE_URL });
    try {
      const csv = await anon.get(csvPath);
      expect(csv.status()).toBe(200);
      const text = await csv.text();
      expect(text).toContain(`_${shareKey}`);
    } finally {
      await anon.dispose();
    }
  } finally {
    await context.close();
  }
});

test("Reset link retires every link shared so far", async ({ page, playwright }) => {
  const oldKey = shareKey;
  // Every path the address bar takes, as the page writes it. React Router
  // moves the address bar only through these two calls, and the record is
  // kept in the page, so even a flick that lasts one render is caught.
  await page.addInitScript(() => {
    const paths: string[] = [];
    (window as unknown as { __addressBar: string[] }).__addressBar = paths;
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        original.apply(this, args);
        paths.push(location.pathname);
      };
    }
  });
  const addressBar = () =>
    page.evaluate(() => (window as unknown as { __addressBar: string[] }).__addressBar.slice());

  await devLogin(page);
  await page.goto(`/comp/${fixture.compId}_${oldKey}/settings/access`);
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Not in the competition list or search. Only admins, and people you send this competition’s link to, can see it."
    )
  ).toBeVisible();

  await page.getByRole("button", { name: "Reset link" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText("Every link you’ve shared so far stops working.")).toBeVisible();
  const reset = page.waitForResponse(
    (r) => r.url().endsWith("/share-key") && r.request().method() === "POST"
  );
  // The page reading the comp again under its new key, after which nothing
  // is left for the canonical path to wait on.
  const refetchPath = new RegExp(`^/api/comp/${fixture.compId}_(?!${oldKey})[a-z0-9]{12}$`);
  const refetched = page.waitForResponse(
    (r) => r.request().method() === "GET" && refetchPath.test(new URL(r.url()).pathname)
  );
  // Nothing moves the address bar between this click and the POST's answer,
  // so whatever is recorded from here on is the page's reaction to the reset.
  const beforeReset = (await addressBar()).length;
  await confirm.getByRole("button", { name: "Reset link" }).click();
  expect((await reset).ok()).toBe(true);
  shareKey = await readShareKey();
  expect(shareKey).not.toBe(oldKey);

  // The page moves onto the new key: the address bar is the new link.
  await expect.poll(() => urlCompId(page)).toBe(`${fixture.compId}_${shareKey}`);
  expect((await refetched).ok()).toBe(true);
  await expect.poll(() => urlCompId(page)).toBe(`${fixture.compId}_${shareKey}`);

  // And it never stepped back onto the dead link on the way. The canonical
  // path used to be built from the comp the page loaded BEFORE the reset, so
  // the old key came back until the refetch landed (run 41430947899) — long
  // enough for an organiser to copy it.
  const afterReset = (await addressBar()).slice(beforeReset);
  expect(afterReset.length, "the reset moved the address bar").toBeGreaterThan(0);
  expect(afterReset.filter((path) => path.includes(`_${oldKey}`))).toEqual([]);

  const anon = await playwright.request.newContext({ baseURL: BASE_URL });
  try {
    expect((await anon.get(`/api/comp/${fixture.compId}_${oldKey}`)).status()).toBe(404);
    expect((await anon.get(`/api/comp/${fixture.compId}_${shareKey}`)).status()).toBe(200);
  } finally {
    await anon.dispose();
  }
});
