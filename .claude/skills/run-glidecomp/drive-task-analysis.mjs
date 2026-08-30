/**
 * Drives the Task analysis pages as a signed-in super-admin:
 * task page -> Task analysis link -> separation ranking -> family tables,
 * then the comp-level aggregate. Screenshots each stop.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = path.resolve(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const errors = [];

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // Sign in from inside an SPA page so the cookie sticks (see SKILL.md).
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
  console.log(`comp: ${comp.name} (${comp.comp_id})`);

  // Find a task with a route.
  const detail = await page.evaluate(
    (id) => fetch(`/api/comp/${id}`, { credentials: "include" }).then((r) => r.json()),
    comp.comp_id
  );
  const task = detail.tasks[0];
  console.log(`task: ${task.name} (${task.task_id})`);

  // 1. Task page — is the Task analysis link there for an admin?
  // `domcontentloaded`, not `networkidle`: once a task's scores are stale the
  // freshness poller keeps a conditional request in flight for as long as the
  // page is open, so networkidle never settles here and the goto times out.
  // Wait on the thing we actually came for instead. (SKILL.md's gotcha; this
  // driver was still carrying the bug it warns about.)
  await page.goto(`${BASE}/comp/${comp.comp_id}/task/${task.task_id}`, {
    waitUntil: "domcontentloaded",
  });
  const link = page.getByRole("link", { name: "Task analysis" });
  await link.first().waitFor({ timeout: 20_000 }).catch(() => {});
  const linkCount = await link.count();
  console.log(`task page: Task analysis link present = ${linkCount > 0}`);
  if (linkCount === 0) throw new Error("no Task analysis link on the task page");

  // 2. Follow it. Cold => pending; poll until the background compute lands.
  await link.first().click();
  await page.waitForURL(/\/task\/[^/]+\/analysis$/);
  await page.screenshot({ path: path.join(SHOTS, "ta-task-pending.png"), fullPage: true });

  // NB: "networkidle" never settles here — the freshness poller keeps a
  // conditional request in flight by design. Wait on the DOM instead.
  for (let i = 0; i < 40; i++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const ranking = await page.getByRole("heading", { name: /Which behaviours went with better results/i }).count();
    if (ranking > 0) break;
  }

  const heading = await page
    .getByRole("heading", { name: /Which behaviours went with better results/i })
    .count();
  if (heading === 0) throw new Error("separation ranking never rendered");

  const rankingRows = await page
    .getByRole("grid", { name: "Behaviour ranking" })
    .getByRole("row")
    .count();
  console.log(`separation ranking rows (incl. header): ${rankingRows}`);

  await page.screenshot({ path: path.join(SHOTS, "ta-task.png"), fullPage: true });

  // 3. Expand a metric family and confirm a per-pilot table renders.
  const families = page.getByRole("button", { name: /Climbing|Gliding|Race craft/ });
  const famCount = await families.count();
  console.log(`metric family disclosures: ${famCount}`);
  if (famCount > 0) {
    await families.first().click();
    await page.waitForTimeout(400);
  }
  const pilotTables = await page.getByRole("grid", { name: /metrics by pilot/ }).count();
  console.log(`per-pilot metric tables visible: ${pilotTables}`);
  await page.screenshot({ path: path.join(SHOTS, "ta-task-family.png"), fullPage: true });

  // 4. Comp-level aggregate. The first visit schedules the remaining tasks'
  // analyses in the background, so poll until they land.
  let compHeading = 0;
  for (let i = 0; i < 30; i++) {
    await page.goto(`${BASE}/comp/${comp.comp_id}/analysis`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);
    compHeading = await page.getByRole("heading", { name: /across tasks/i }).count();
    if (compHeading > 0) break;
  }
  console.log(`comp analysis page rendered a result section = ${compHeading > 0}`);
  await page.screenshot({ path: path.join(SHOTS, "ta-comp.png"), fullPage: true });

  // 5. Anonymous must not see it.
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/comp/${comp.comp_id}/analysis/task/${task.task_id}`, {
    waitUntil: "domcontentloaded",
  });
  await anonPage.waitForTimeout(1500);
  const notAvailable = await anonPage.getByText(/Not available|Sign in/i).count();
  console.log(`anonymous sees the gate = ${notAvailable > 0}`);
  await anonPage.screenshot({ path: path.join(SHOTS, "ta-anon.png"), fullPage: true });

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
