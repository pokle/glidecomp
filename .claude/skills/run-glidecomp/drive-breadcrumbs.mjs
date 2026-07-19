/**
 * Drives the breadcrumb trail on every /comp page as a signed-in super-admin,
 * and walks the field-analysis journey the way a user does:
 *   comp detail -> Field analysis -> a task chapter -> up one level
 * asserting the trail's text and that "up" lands on the comp report.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = path.resolve(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const errors = [];
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "✓" : "✗"} ${label}\n    got:      ${actual}\n    expected: ${expected}`);
  if (!ok) failures.push(label);
}

/**
 * The visible trail, normalised to "A › B › C".
 *
 * `expect` is the trail we're waiting to settle on: these pages fetch the
 * comp/task names after mount (and React keeps the previous route's tree up
 * for a beat during a client nav), so reading once races both. Poll until it
 * matches or we run out of patience, then report whatever we last saw.
 */
async function trail(page, expected) {
  const nav = page.getByRole("navigation", { name: "Breadcrumb" });
  await nav.waitFor({ state: "visible", timeout: 15_000 });
  // Generous budget: the pilot score page runs its track analysis in the
  // browser before it can name the pilot, which takes tens of seconds here.
  let seen = "";
  for (let i = 0; i < 90; i++) {
    seen = (await nav.innerText()).replace(/\s+/g, " ").trim();
    if (seen === expected) return seen;
    await page.waitForTimeout(500);
  }
  return seen;
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(`${BASE}/comp`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Super Admin", email: "tushar.pokle@gmail.com" }),
      credentials: "include",
    });
  });

  const comps = await page.evaluate(() =>
    fetch("/api/comp", { credentials: "include" }).then((r) => r.json())
  );
  const comp = (comps.comps ?? comps).find((c) => /Corryong/i.test(c.name));
  if (!comp) throw new Error("Corryong comp not found — run `bun run seed`");
  const detail = await page.evaluate(
    (id) => fetch(`/api/comp/${id}`, { credentials: "include" }).then((r) => r.json()),
    comp.comp_id
  );
  const task = detail.tasks[0];
  console.log(`comp: ${comp.name} (${comp.comp_id}) / task: ${task.name}\n`);

  // --- 1. Comp detail: now names itself as the final crumb -----------------
  await page.goto(`${BASE}/comp/${comp.comp_id}`, { waitUntil: "domcontentloaded" });
  const compDetailTrail = `Competitions › ${comp.name}`;
  check("comp detail trail", await trail(page, compDetailTrail), compDetailTrail);

  // --- 2. Comp detail -> Field analysis ------------------------------------
  const faLink = page.getByRole("navigation", { name: "Sections" }).getByRole("link", {
    name: "Field analysis",
  });
  await faLink.waitFor({ state: "visible", timeout: 15_000 });
  await faLink.click();
  await page.waitForURL(/\/comp\/[^/]+\/analysis$/);
  const compAnalysisTrail = `Competitions › ${comp.name} › Field analysis`;
  check("comp analysis trail", await trail(page, compAnalysisTrail), compAnalysisTrail);
  await page.screenshot({ path: path.join(SHOTS, "bc-comp-analysis.png"), fullPage: false });

  // --- 3. Comp analysis -> a task chapter ----------------------------------
  // The chapters only appear once at least one task has a stored analysis;
  // the first visit schedules them, so poll.
  const perTask = page.getByRole("navigation", { name: "Per-task field analysis" });
  for (let i = 0; i < 40 && (await perTask.count()) === 0; i++) {
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  if ((await perTask.count()) === 0) throw new Error("per-task chapter nav never appeared");

  const chapter = perTask.getByRole("link").first();
  const chapterName = (await chapter.innerText()).trim();
  await chapter.click();
  await page.waitForURL(/\/comp\/[^/]+\/analysis\/task\/[^/]+$/);
  console.log(`\n  chapter URL: ${new URL(page.url()).pathname}`);

  // The chapter's own crumb is the TASK name; "Field analysis" is its parent.
  // Wait for the chapter's own chrome before reading — the previous route's
  // tree is still mounted for a beat after waitForURL resolves.
  await page.getByRole("link", { name: "View task" }).waitFor({ timeout: 15_000 });
  const expectedChapterTrail = `Competitions › ${comp.name} › Field analysis › ${chapterName.replace(/^T\d+\s+/, "")}`;
  check("task chapter trail", await trail(page, expectedChapterTrail), expectedChapterTrail);
  await page.screenshot({ path: path.join(SHOTS, "bc-task-analysis.png"), fullPage: false });

  // --- 4. THE BUG: up one level must land on the comp report ---------------
  const upOne = page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Field analysis" });
  await upOne.click();
  await page.waitForURL(/\/comp\/[^/]+\/analysis$/);
  check(
    "up-one-level from a chapter",
    new URL(page.url()).pathname,
    `/comp/${comp.comp_id}/analysis`
  );

  // --- 5. Old URL still works (redirect) -----------------------------------
  await page.goto(`${BASE}/comp/${comp.comp_id}/task/${task.task_id}/analysis?class=Open`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForURL(/\/analysis\/task\//, { timeout: 15_000 });
  check(
    "legacy URL redirects (and keeps ?class=)",
    new URL(page.url()).pathname + new URL(page.url()).search,
    `/comp/${comp.comp_id}/analysis/task/${task.task_id}?class=Open`
  );

  // --- 6. The sibling "View task" link -------------------------------------
  const viewTask = page.getByRole("link", { name: "View task" });
  await viewTask.waitFor({ state: "visible", timeout: 15_000 });
  await viewTask.click();
  await page.waitForURL(/\/comp\/[^/]+\/task\/[^/]+$/);
  check(
    "View task lands on the task page",
    new URL(page.url()).pathname,
    `/comp/${comp.comp_id}/task/${task.task_id}`
  );
  const taskTrail = `Competitions › ${comp.name} › ${task.name}`;
  check("task detail trail", await trail(page, taskTrail), taskTrail);

  // --- 7. The two converted legacy pages -----------------------------------
  await page.goto(`${BASE}/comp/${comp.comp_id}/waypoints`, { waitUntil: "domcontentloaded" });
  const wpTrail = `Competitions › ${comp.name} › Waypoints`;
  check("waypoints trail", await trail(page, wpTrail), wpTrail);

  // Reach the pilot score page the way a user does — click a standings row —
  // rather than reconstructing the comp_pilot_id from an API shape.
  await page.goto(`${BASE}/comp/${comp.comp_id}/task/${task.task_id}`, {
    waitUntil: "domcontentloaded",
  });
  const pilotLink = page.locator(`a[href*="/pilot/"]`).first();
  await pilotLink.waitFor({ state: "visible", timeout: 30_000 });
  const pilotName = (await pilotLink.innerText()).trim();
  await pilotLink.click();
  await page.waitForURL(/\/pilot\/[^/]+$/);
  const pilotTrail = `Competitions › ${comp.name} › ${task.name} › ${pilotName}`;
  check("pilot score trail", await trail(page, pilotTrail), pilotTrail);

  await browser.close();

  const realErrors = errors.filter((e) => !/favicon|mapbox|Failed to load resource/i.test(e));
  if (realErrors.length) {
    console.log(`\nconsole errors:\n${realErrors.map((e) => "  " + e).join("\n")}`);
  }
  if (failures.length) {
    throw new Error(`${failures.length} breadcrumb check(s) failed: ${failures.join(", ")}`);
  }
  console.log("\n✓ breadcrumb hierarchy verified end-to-end");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
