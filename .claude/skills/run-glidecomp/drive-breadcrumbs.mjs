/**
 * Drives the breadcrumb trail on every /comp page as a signed-in super-admin,
 * and walks the analysis journey the way a user does:
 *   comp detail -> Comp analysis -> one task's Task analysis -> up one level
 * asserting the trail's text and that "up" lands on the TASK — the task
 * analysis is a child of its task, and the comp analysis is a sibling link.
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
 * Strip the readable slug off every `${slug}-${id}` segment, leaving the ids.
 *
 * Public URLs canonicalise to the slugged form once the names load
 * (useCanonicalPath + lib/slug.ts), so a path assertion written against bare
 * ids fails on a page that behaved perfectly. The identity is the id; the slug
 * is a readable copy of a name that may change. Compare identities.
 */
function pathIds(pathname) {
  return pathname
    .split("/")
    .map((seg) => (seg.includes("-") ? seg.slice(seg.lastIndexOf("-") + 1) : seg))
    .join("/");
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

  // --- 2. Comp detail -> Comp analysis --------------------------------------
  const caLink = page.getByRole("navigation", { name: "Sections" }).getByRole("link", {
    name: "Comp analysis",
  });
  await caLink.waitFor({ state: "visible", timeout: 15_000 });
  await caLink.click();
  await page.waitForURL(/\/comp\/[^/]+\/analysis$/);
  const compAnalysisTrail = `Competitions › ${comp.name} › Comp analysis`;
  check("comp analysis trail", await trail(page, compAnalysisTrail), compAnalysisTrail);
  await page.screenshot({ path: path.join(SHOTS, "bc-comp-analysis.png"), fullPage: false });

  // --- 3. Comp analysis -> one task's own task analysis ----------------------
  // The per-task links only appear once at least one task has a stored
  // analysis; the first visit schedules them, so poll.
  const perTask = page.getByRole("navigation", { name: "Task analyses" });
  for (let i = 0; i < 40 && (await perTask.count()) === 0; i++) {
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  if ((await perTask.count()) === 0) throw new Error("per-task analysis nav never appeared");

  const taskLink = perTask.getByRole("link").first();
  const linkName = (await taskLink.innerText()).trim();
  await taskLink.click();
  await page.waitForURL(/\/comp\/[^/]+\/task\/[^/]+\/analysis$/);
  console.log(`\n  task analysis URL: ${new URL(page.url()).pathname}`);

  // The task analysis hangs off the TASK, so the trail is
  // Competitions › comp › task › Task analysis. The nav link reads
  // "T1 Task 1 (Open)"; the crumb is the task name alone.
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Comp analysis" })
    .waitFor({ state: "attached", timeout: 15_000 })
    .catch(() => {});
  const taskName = linkName.replace(/^T\d+\s+/, "");
  const expectedTaskAnalysisTrail =
    `Competitions › ${comp.name} › ${taskName} › Task analysis`;
  check(
    "task analysis trail",
    await trail(page, expectedTaskAnalysisTrail),
    expectedTaskAnalysisTrail
  );
  await page.screenshot({ path: path.join(SHOTS, "bc-task-analysis.png"), fullPage: false });

  // --- 4. Up one level from a task analysis lands on the TASK ----------------
  // This is the IA: the task analysis is a child of the task, not of the comp
  // analysis. The comp analysis is a SIBLING link in the header row (step 5).
  const upOne = page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: taskName });
  await upOne.click();
  await page.waitForURL(/\/comp\/[^/]+\/task\/[^/]+$/);
  const taskTrail = `Competitions › ${comp.name} › ${taskName}`;
  check("task detail trail", await trail(page, taskTrail), taskTrail);

  // --- 5. The sibling "Comp analysis" link back out -------------------------
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/comp\/[^/]+\/task\/[^/]+\/analysis$/);
  const sibling = page.getByRole("link", { name: "Comp analysis" }).first();
  await sibling.waitFor({ state: "visible", timeout: 15_000 });
  await sibling.click();
  await page.waitForURL(/\/comp\/[^/]+\/analysis$/);
  check(
    "comp analysis is a sibling link from a task analysis",
    pathIds(new URL(page.url()).pathname),
    `/comp/${comp.comp_id}/analysis`
  );

  // --- 6. The superseded URL still works (redirect) -------------------------
  // The task analysis lived under the comp report from July to August 2026.
  await page.goto(`${BASE}/comp/${comp.comp_id}/analysis/task/${task.task_id}?class=Open`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForURL(/\/task\/[^/]+\/analysis/, { timeout: 15_000 });
  check(
    "superseded URL redirects (and keeps ?class=)",
    pathIds(new URL(page.url()).pathname) + new URL(page.url()).search,
    `/comp/${comp.comp_id}/task/${task.task_id}/analysis?class=Open`
  );

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
