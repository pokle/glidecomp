/**
 * Where a refusal lands on the task's management tools (#808): the manage
 * grid's per-row actions, and the manual-flight page it links to.
 *
 * Each of them used to report a failed save as a toast — gone in seconds,
 * tied to nothing, and easy for a screen reader to miss. Now:
 *
 *  - The manual-flight page is a kit form (rac/form.tsx): a missing landing
 *    point, and a server refusal naming `landing_lat`, both land under the one
 *    Landing point field, which is focused.
 *  - A row action (the status select, Upload track, Restore track) has no
 *    field to put a refusal under, so it goes in the kit's fixed place beside
 *    the control — under that pilot's row of buttons — and takes focus.
 *
 * What the kit itself does (one submit at a time, an edit clearing its error,
 * the words for a dropped connection) is e2e/forms.spec.ts's. This file only
 * holds these surfaces to it. It runs on a phone as well, because a task is
 * run from a hill.
 *
 * Nothing here is allowed to reach the scores: the refusals are made either
 * before anything is sent, or by intercepting the request, and each test ends
 * by checking the server holds nothing new.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";
import { createScoredComp, type ScoredComp } from "./fixtures/scored-comp";

const BASE_URL = FRONTEND_URL;

/** A pilot with no tracklog, so every row action and the manual flight apply. */
const PILOT = "Nina NoTrack";

/** A landing point on the third leg — inside the route, short of goal. */
const LANDING = "-36.2212878474, 147.729549408";

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

let admin: APIRequestContext;
let fixture: ScoredComp;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120_000);
  admin = await playwright.request.newContext({ baseURL: BASE_URL });
  const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(signIn.ok(), "super admin dev-login").toBeTruthy();
  fixture = await createScoredComp(admin, "task admin refusals", [PILOT]);
});

test.afterAll(async () => {
  if (fixture?.compId) await admin.delete(`/api/comp/${fixture.compId}`);
  await admin.dispose();
});

test.beforeEach(async ({ page }) => {
  await devLogin(page);
});

/** The pilot's row in the manage grid, once the admin check has mounted it. */
async function managedRow(page: Page) {
  await page.goto(`${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}`);
  const grid = page.getByRole("grid", { name: /^Manage pilots & tracks/ });
  const row = grid.getByRole("row").filter({ hasText: PILOT });
  await expect(row.getByRole("button", { name: `Status for ${PILOT}` })).toBeVisible({
    timeout: 30_000,
  });
  return row;
}

const pilotId = () => fixture.pilotIds.get(PILOT)!;

test("a row action's refusal shows under that pilot's row, never in a toast", async ({
  page,
}) => {
  const row = await managedRow(page);

  // Refused before anything is sent: the file is not a tracklog. The picker
  // only offers .igc, but a file can still be dropped or renamed past it.
  await row.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a tracklog"),
  });
  const refusal = row.getByRole("alert");
  await expect(refusal).toHaveText("That is not an IGC file.");
  await expect(refusal).toBeFocused();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  // Refused by the server: its words, in the same place, and the select still
  // shows the status that is actually stored.
  const refusedWith = "Only admins or the pilot themselves can set status in this competition";
  await page.route(/\/pilot-status\//, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 403, json: { error: refusedWith } })
      : route.continue()
  );
  const status = row.getByRole("button", { name: `Status for ${PILOT}` });
  await status.click();
  await page.getByRole("option", { name: "Did Not Fly" }).click();
  await expect(refusal).toHaveText(refusedWith);
  // Answered faster than the status menu takes to close, which is the case
  // that used to hand focus back to the menu's trigger (rac/form.tsx).
  await expect(refusal).toBeFocused();
  await expect(refusal).toBeInViewport();
  await expect(status).toContainText("Present");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  const statuses = await admin.get(
    `/api/comp/${fixture.compId}/task/${fixture.taskId}/pilot-status`
  );
  const { statuses: stored } = (await statuses.json()) as {
    statuses: Array<{ comp_pilot_id: string }>;
  };
  expect(stored.some((s) => s.comp_pilot_id === pilotId())).toBe(false);
});

test("manual flight: a missing or refused landing point is said under the field", async ({
  page,
}) => {
  const row = await managedRow(page);
  await row.getByRole("link", { name: "Add manual flight" }).click();
  await expect(page.getByRole("heading", { name: "Record manual flight" })).toBeVisible({
    timeout: 20_000,
  });

  let sent = 0;
  await page.route(/\/manual-flight\//, (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    sent++;
    // The shape the server's validator answers with (validators.ts), naming
    // one half of the pair the page types as one field.
    return route.fulfill({
      status: 400,
      json: {
        error: "landing_lat: Too big: expected number to be <=90",
        field: "landing_lat",
      },
    });
  });

  const landing = page.getByRole("textbox", { name: "Landing point" });
  const record = page.getByRole("button", { name: "Record flight" });

  // Nothing typed: the form's own check, under the field, before any request.
  await record.click();
  await expect(landing).toHaveAttribute("aria-invalid", "true");
  await expect(landing).toBeFocused();
  await expect(page.getByText('Enter the landing point as "latitude, longitude"')).toBeVisible();
  expect(sent).toBe(0);

  // Typing clears it; the server's refusal of landing_lat lands on the same
  // field, without its "landing_lat: " prefix.
  await landing.fill(LANDING);
  await expect(landing).not.toHaveAttribute("aria-invalid", "true");
  await record.click();
  await expect(page.getByText("Too big: expected number to be <=90")).toBeVisible();
  await expect(landing).toHaveAttribute("aria-invalid", "true");
  await expect(landing).toBeFocused();
  await expect(landing).toBeInViewport();
  expect(sent).toBe(1);
  // Still on the page, with what was typed kept.
  await expect(page.getByRole("heading", { name: "Record manual flight" })).toBeVisible();
  await expect(landing).toHaveValue(LANDING);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  const flights = await admin.get(
    `/api/comp/${fixture.compId}/task/${fixture.taskId}/manual-flight`
  );
  const { manual_flights } = (await flights.json()) as { manual_flights: unknown[] };
  expect(manual_flights).toHaveLength(0);
});
