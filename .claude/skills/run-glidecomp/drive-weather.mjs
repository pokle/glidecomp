/**
 * Drives the task weather work end-to-end as a signed-in super-admin:
 *   1. Task page — add weather notes through the admin dialog, confirm they
 *      render for an ANONYMOUS visitor too.
 *   2. Field analysis — wait out the background compute, open the Day family,
 *      and screenshot the day panel with the weather charts stacked on the
 *      shared time axis.
 *
 * Screenshots land in shots/wx-*.png.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
// COMP_MATCH picks the comp. Worth pointing at a pre-2022 comp
// (COMP_MATCH=Unungra) as well as the default: that era falls back to ERA5,
// which carries no pressure-level winds and no CAPE, so it exercises the
// charts' degraded path — surface wind only, no upper-level arrows.
const COMP_MATCH = new RegExp(process.env.COMP_MATCH ?? "Corryong", "i");
const SHOTS = path.resolve(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const NOTES =
  "Slow start — inversion broke about 12:30.\n" +
  "Overdeveloped over the back range by 2pm, a few pilots got shaded out on leg 3.\n" +
  "Glass off around 3, most of the field landed short of goal.";

const errors = [];

async function signIn(page) {
  await page.goto(`${BASE}/comp`, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Super Admin", email: "tushar.pokle@gmail.com" }),
      credentials: "include",
    });
  });
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // Name the failing request: "Failed to load resource" alone can't tell a
  // product bug from local D1's known SQLITE_BUSY contention flake.
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await signIn(page);

  const comps = await page.evaluate(() =>
    fetch("/api/comp", { credentials: "include" }).then((r) => r.json())
  );
  const comp = (comps.comps ?? comps).find((c) => COMP_MATCH.test(c.name));
  if (!comp) throw new Error(`no comp matching ${COMP_MATCH} — run \`bun run seed\``);
  const detail = await page.evaluate(
    (id) => fetch(`/api/comp/${id}`, { credentials: "include" }).then((r) => r.json()),
    comp.comp_id
  );
  const task = detail.tasks.find((t) => t.name.includes("Open")) ?? detail.tasks[0];
  console.log(`comp: ${comp.name} (${comp.comp_id})  task: ${task.name} (${task.task_id})`);

  const taskUrl = `${BASE}/comp/${comp.comp_id}/task/${task.task_id}`;

  // ── 1. Weather notes, written through the admin UI ───────────────────────
  await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Weather notes" }).waitFor();
  const addButton = page.getByRole("button", { name: /(Add|Edit) notes…/ });
  await addButton.waitFor();
  await addButton.click();
  const box = page.getByRole("textbox", { name: /What did the day do/i });
  await box.waitFor();
  await box.fill(NOTES);
  await page.getByRole("button", { name: "Save notes" }).click();
  // Wait for the dialog to go before reading the page: on a re-run the
  // textarea is pre-filled with the same prose and would match too.
  await box.waitFor({ state: "detached" });
  const rendered = page.locator("section p", { hasText: /Glass off around 3/ });
  await rendered.first().waitFor();
  console.log("task page: notes saved and rendered");
  await page.screenshot({ path: path.join(SHOTS, `wx-task-notes${process.env.COMP_MATCH ? "-" + process.env.COMP_MATCH.toLowerCase() : ""}.png`), fullPage: true });

  // The section must be readable WITHOUT the admin session.
  const anon = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const anonPage = await anon.newPage();
  await anonPage.goto(taskUrl, { waitUntil: "domcontentloaded" });
  await anonPage.locator("section p", { hasText: /Glass off around 3/ }).first().waitFor();
  const anonEdit = await anonPage.getByRole("button", { name: /(Add|Edit) notes…/ }).count();
  if (anonEdit !== 0) throw new Error("anonymous visitor was offered the notes editor");
  console.log("anonymous: notes visible, editor absent ✓");
  await anon.close();

  // ── 2. The day panel with the weather charts ─────────────────────────────
  await page.getByRole("link", { name: "Field analysis" }).first().click();
  await page.waitForURL(/\/analysis\/task\/[^/]+$/);

  // Cold analysis => pending; poll (networkidle never settles — freshness poller).
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    if (await page.getByRole("heading", { name: /Which behaviours went with better results/i }).count()) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error("field analysis never finished computing");

  // Open the Day family and find the panel. Anchor the name: /Day/i also
  // matches the ranking table's ⓘ buttons ("How high in the day's band …"),
  // which come first in the DOM, so the loose match clicked a popover.
  const dayFamily = page.getByRole("button", { name: /^Day profile/ }).first();
  if (await dayFamily.count()) await dayFamily.click();
  await page.getByRole("heading", { name: /What the weather did/i }).waitFor({ timeout: 20000 });
  console.log("field analysis: weather group present");

  // Only the wind and cloud charts are guaranteed: a dataset with neither a
  // boundary layer nor a dewpoint would legitimately drop the height chart.
  const charts = ["Modelled wind by hour", "Cloud cover by hour"];
  for (const name of charts) {
    const img = page.getByRole("img", { name: new RegExp(name, "i") });
    if (!(await img.count())) throw new Error(`missing weather chart: ${name}`);
    const label = await img.first().getAttribute("aria-label");
    if (!/Source:/.test(label ?? "")) throw new Error(`chart "${name}" has no source in its label`);
    console.log(`  ✓ ${name}`);
  }

  // The notes must travel to this page too.
  await page.locator("figure p", { hasText: /Glass off around 3/ }).first().waitFor();
  console.log("field analysis: organizer notes shown with the charts ✓");

  const panel = page.locator("figure", { hasText: "The day at a glance" }).first();
  await panel.screenshot({ path: path.join(SHOTS, `wx-day-panel${process.env.COMP_MATCH ? "-" + process.env.COMP_MATCH.toLowerCase() : ""}.png`) });
  await page.screenshot({ path: path.join(SHOTS, `wx-analysis-full${process.env.COMP_MATCH ? "-" + process.env.COMP_MATCH.toLowerCase() : ""}.png`), fullPage: true });

  await browser.close();

  // Reported, not fatal — matching drive-field-analysis.mjs. A cold run
  // triggers the whole-field analysis compute alongside the driver's reload
  // poll, and local Miniflare D1 throws transient
  // "D1_ERROR: Failed to parse body as JSON" (SQLITE_BUSY underneath) under
  // that contention. Verified pre-existing: the untouched field-analysis
  // driver produces the same 500s on endpoints this work never touched.
  // The weather assertions above are the real pass/fail signal.
  const realErrors = errors.filter((e) => !/favicon|mapbox/i.test(e));
  if (realErrors.length) {
    console.log(`\n⚠ transient errors (see note in source):\n${realErrors.join("\n")}`);
  } else {
    console.log("\nno console errors");
  }
  console.log("✓ drove task weather end-to-end");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
