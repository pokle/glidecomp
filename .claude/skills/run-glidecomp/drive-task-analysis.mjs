/**
 * Drives the task and comp analysis pages the way a visitor reaches them:
 * task page -> "Task analysis" link -> the contents list of section boxes ->
 * the Winning strategies and Metric details pages -> the comp analysis.
 * Screenshots each stop.
 *
 * Anonymous throughout, on purpose. Both analyses are public for a normal comp
 * (`canViewAnalysis()` in competition-api routes/analysis.ts), and a driver
 * that signs in first can't tell "public" from "visible to an admin".
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { TASK_ANALYSIS_SECTIONS } from "../../../web/frontend/src/react/analysis/sections.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = path.resolve(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const errors = [];

/** Reload until `locator` shows up. A cold report is computed in the
 * background (the cold path returns `pending` and never computes inline), so
 * the first visit usually shows a pending notice rather than the report. */
async function pollFor(page, url, locator, { tries = 40, waitMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    // `domcontentloaded`, never `networkidle`: the freshness poller keeps a
    // conditional request in flight by design, so networkidle never settles.
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (await locator.first().waitFor({ timeout: waitMs }).then(() => true, () => false)) {
      return true;
    }
  }
  return false;
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const comps = await fetch(`${BASE}/api/comp`).then((r) => r.json());
  const comp = (comps.comps ?? comps).find((c) => /Corryong/i.test(c.name));
  if (!comp) throw new Error("Corryong comp not found — run `bun run seed`");
  console.log(`comp: ${comp.name} (${comp.comp_id})`);

  const detail = await fetch(`${BASE}/api/comp/${comp.comp_id}`).then((r) => r.json());
  const task = detail.tasks[0];
  console.log(`task: ${task.name} (${task.task_id})`);

  // 1. The task page links to its analysis, for an anonymous visitor too.
  await page.goto(`${BASE}/comp/${comp.comp_id}/task/${task.task_id}`, {
    waitUntil: "domcontentloaded",
  });
  const link = page.getByRole("link", { name: "Task analysis" });
  await link.first().waitFor({ timeout: 20_000 }).catch(() => {});
  if ((await link.count()) === 0) throw new Error("no Task analysis link on the task page");
  await link.first().click();
  await page.waitForURL(/\/task\/[^/]+\/analysis$/);
  const analysisUrl = page.url().split("?")[0];
  await page.screenshot({ path: path.join(SHOTS, "ta-task-pending.png"), fullPage: true });

  // 2. The contents list: one box per section, each linking to its own page.
  const firstBox = page.locator(`a[href$="/analysis/${TASK_ANALYSIS_SECTIONS[0].slug}"]`);
  if (!(await pollFor(page, analysisUrl, firstBox))) {
    throw new Error("the task analysis never finished computing (no section boxes)");
  }
  const missing = [];
  for (const s of TASK_ANALYSIS_SECTIONS) {
    const box = page.locator(`a[href$="/analysis/${s.slug}"]`);
    if ((await box.count()) === 0) missing.push(s.slug);
  }
  if (missing.length) throw new Error(`contents list is missing boxes for: ${missing.join(", ")}`);
  console.log(`contents list: all ${TASK_ANALYSIS_SECTIONS.length} section boxes present`);
  await page.screenshot({ path: path.join(SHOTS, "ta-task.png"), fullPage: true });

  // 3. Winning strategies carries the separation ranking.
  await page.goto(`${analysisUrl}/strategies`, { waitUntil: "domcontentloaded" });
  const ranking = page.getByRole("grid", { name: "Behaviour ranking" });
  await ranking.waitFor({ timeout: 20_000 }).catch(() => {});
  if ((await ranking.count()) === 0) throw new Error("no Behaviour ranking on Winning strategies");
  console.log(`separation ranking rows (incl. header): ${await ranking.getByRole("row").count()}`);
  await page.screenshot({ path: path.join(SHOTS, "ta-strategies.png"), fullPage: true });

  // 4. Metric details carries a per-pilot table for each metric family.
  await page.goto(`${analysisUrl}/metrics`, { waitUntil: "domcontentloaded" });
  const pilotTables = page.getByRole("grid", { name: /metrics by pilot$/ });
  await pilotTables.first().waitFor({ timeout: 20_000 }).catch(() => {});
  const tableCount = await pilotTables.count();
  if (tableCount === 0) throw new Error("no per-pilot metric tables on Metric details");
  console.log(`per-pilot metric tables: ${tableCount}`);
  await page.screenshot({ path: path.join(SHOTS, "ta-metrics.png"), fullPage: true });

  // 5. The comp analysis aggregates the task analyses. The first visit
  // schedules the tasks not yet analysed, so poll until they land.
  const compHeading = page.getByRole("heading", { name: /across tasks/i });
  if (!(await pollFor(page, `${BASE}/comp/${comp.comp_id}/analysis`, compHeading, { tries: 30 }))) {
    throw new Error("the comp analysis never rendered its across-tasks section");
  }
  console.log("comp analysis: across-tasks section rendered");
  await page.screenshot({ path: path.join(SHOTS, "ta-comp.png"), fullPage: true });

  await browser.close();

  const realErrors = errors.filter((e) => !/favicon|mapbox/i.test(e));
  if (realErrors.length) {
    console.log(`\n⚠ console errors:\n${realErrors.join("\n")}`);
  } else {
    console.log("\nno console errors");
  }
  console.log("✓ drove task analysis end-to-end");
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
