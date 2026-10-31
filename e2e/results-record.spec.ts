/**
 * The results record (`/comp/:id/scores.pdf`, docs/results-record.md): the
 * whole competition's scores as one PDF to keep, and its data on its own as
 * `scores.zip`.
 *
 * What this pins, against the real Workers:
 *  - anyone, signed in or not, gets a real PDF whose attachments carry every
 *    flying pilot, and a ZIP of the same files;
 *  - the scores page's Download menu offers both to every reader;
 *  - after the close date the comp page prompts the ADMIN to keep it (that
 *    card stays admin-only), the download checks the step off, and the
 *    prompt is gone on the next visit.
 *
 * The fixture is a fresh comp (fixtures/scored-comp.ts) closed in the past,
 * deleted again afterwards.
 */
import { readFileSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";
import { createScoredComp, FLYING_PILOTS, readScore, type ScoredComp } from "./fixtures/scored-comp";
import { readRecord, readZip } from "../web/frontend/src/results-record/read-pdf";

const BASE_URL = FRONTEND_URL;

let admin: APIRequestContext;
let fixture: ScoredComp;

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

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(180_000);
  admin = await playwright.request.newContext({ baseURL: BASE_URL });
  const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(signIn.ok(), "super admin dev-login").toBeTruthy();
  fixture = await createScoredComp(admin, "results record");
  // Closed long ago: the wrap-up card's condition.
  const close = await admin.patch(`/api/comp/${fixture.compId}`, {
    data: { close_date: "2021-01-01" },
  });
  expect(close.ok(), await close.text()).toBeTruthy();
  // Materialise the task's scores so the record never waits on a cold compute.
  await readScore(admin, fixture);
});

test.afterAll(async () => {
  if (fixture?.compId) await admin.delete(`/api/comp/${fixture.compId}`);
  await admin.dispose();
});

test("anyone downloads the record and its data, signed in or not", async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: BASE_URL });
  for (const who of [admin, anon]) {
    const res = await who.get(`/comp/${fixture.compId}/scores.pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect(res.headers()["content-disposition"]).toMatch(/-results-\d{4}-\d{2}-\d{2}\.pdf"$/);
    const { doc, attachments } = await readRecord(new Uint8Array(await res.body()));
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const results = attachments.get("task-results.csv")?.text ?? "";
    for (const p of FLYING_PILOTS) expect(results).toContain(p.name);
    expect([...attachments.keys()]).toContain("competition.json");
  }

  // The same files, for a viewer that cannot open a PDF's attachments.
  const zip = await anon.get(`/comp/${fixture.compId}/scores.zip`);
  expect(zip.status()).toBe(200);
  expect(zip.headers()["content-type"]).toBe("application/zip");
  const files = readZip(new Uint8Array(await zip.body()));
  const results = [...files].find(([path]) => path.endsWith("/task-results.csv"))?.[1] ?? "";
  for (const p of FLYING_PILOTS) expect(results).toContain(p.name);
  await anon.dispose();
});

test("the scores page offers the record and its data to every reader", async ({ page, browser }) => {
  await devLogin(page);
  await page.goto(`/comp/${fixture.compId}/scores`);
  const download = page.getByRole("button", { name: "Download" });
  await expect(download).toBeVisible({ timeout: 15_000 });
  await download.click();
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Results record (PDF)" }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/-results-\d{4}-\d{2}-\d{2}\.pdf$/);
  expect(readFileSync(await file.path()).subarray(0, 5).toString()).toBe("%PDF-");

  // Signed out: the same two items, and the ZIP is a real download.
  const anon = await browser.newPage();
  await anon.goto(`${BASE_URL}/comp/${fixture.compId}/scores`);
  const anonDownload = anon.getByRole("button", { name: "Download" });
  await expect(anonDownload).toBeVisible({ timeout: 15_000 });
  await anonDownload.click();
  await expect(anon.getByRole("menuitem", { name: "Results record (PDF)" })).toBeVisible();
  const [zip] = await Promise.all([
    anon.waitForEvent("download"),
    anon.getByRole("menuitem", { name: "Results data (ZIP)" }).click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/-results-\d{4}-\d{2}-\d{2}\.zip$/);
  // "PK" — a ZIP's local file header.
  expect(readFileSync(await zip.path()).subarray(0, 2).toString()).toBe("PK");
  await anon.close();
});

test("after the close date the comp page prompts the admin to keep the record", async ({ page }) => {
  await devLogin(page);
  await page.goto(`/comp/${fixture.compId}`);
  const card = page.getByRole("region", { name: "Keep a record of the results" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("Submissions closed on Fri, 1 Jan 2021")).toBeVisible();
  await expect(card).toContainText("1 of 2 steps");

  const [file] = await Promise.all([
    page.waitForEvent("download"),
    card.getByRole("link", { name: "Download the results record (PDF)" }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  // Checked off, and still there: the link the admin pressed stays put.
  await expect(card).toContainText("2 of 2 steps");
  await expect(card).toContainText("Completed: Download the results record (PDF)");

  // Gone on the next visit.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Keep a record of the results" })).toHaveCount(0);
});
