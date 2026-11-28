/**
 * Comp detail page (/comp/:id) — interaction coverage for its RAC surfaces
 * (converted 2026-07-21, see docs/2026-07-18-rac-adoption-guide.md):
 * scores view tabs + sortable scores tables + the scores-by-task Select,
 * the pilots page (a list of pilots that open sheets — its editing is covered
 * on a comp of its own in comp-pilots.spec.ts), the activity filter tabs, and the routed
 * settings pages (Advanced GAP NumberFields, the in-flow timezone list).
 *
 * Drives the seeded "Corryong Cup 2026" sample comp READ-ONLY: every dialog
 * is cancelled and nothing is created or saved — e2e-created cruft comps
 * break the SSR suite's discover() ("first non-test comp"). If the sample
 * comp isn't in local D1 yet (fresh clone, CI), the suite seeds it once via
 * `bun run seed corryong-cup-2026` — idempotent, and running it while the
 * dev workers are up is the established pattern (web/scripts/ssr-e2e-serve.sh
 * does exactly that).
 *
 * RAC testing gotchas honoured here (rac-adoption-guide Verification
 * playbook + gotchas #12/#13/#15):
 * - Never wait on "networkidle": ScoreFreshness deliberately keeps polling,
 *   so it never settles. Wait on role locators instead.
 * - RAC checkboxes/switches can't be *clicked* by role (the real input is
 *   visually hidden) — this spec only reads their state, which works fine.
 *   The settings pages' booleans are `rac/switch` rows, so they answer to
 *   role=switch; dialogs keep role=checkbox.
 * - The settings pages carry no popover at all now (selects became
 *   `rac/choice-list` row lists, the calendar renders in flow), so the
 *   ariaHideOutside caveat that used to govern the timezone combobox no
 *   longer applies — the list is queried in place, scoped to <main>.
 * - RAC Table sorting: first click on a new column follows the app's
 *   per-column defaultDir ("Pilot" asc, "Total" desc), not RAC's
 *   always-ascending.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  test,
  expect,
  PHONE_ONLY,
  type Locator,
  type Page,
} from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";
import { compScoresCsvPath } from "../web/frontend/src/react/lib/slug";

const BASE_URL = FRONTEND_URL;
const COMP_NAME = "Corryong Cup 2026";

interface TaskSummary {
  task_id: string;
  name: string;
  task_date: string;
  has_xctsk: boolean;
  pilot_classes: string[];
}

interface CompDetail {
  name: string;
  pilot_classes: string[];
  timezone: string | null;
  tasks: TaskSummary[];
}

let compId: string;
let comp: CompDetail;

test.beforeAll(async ({ playwright }) => {
  // Seeding + cold score materialization can take a while on a fresh store.
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: BASE_URL });

  const findComp = async (): Promise<string | null> => {
    const res = await api.get("/api/comp");
    if (!res.ok()) return null;
    const { comps } = (await res.json()) as {
      comps: Array<{ comp_id: string; name: string }>;
    };
    return comps.find((c) => c.name === COMP_NAME)?.comp_id ?? null;
  };

  let id = await findComp();
  if (!id) {
    execSync("bun run seed corryong-cup-2026", {
      stdio: "inherit",
      timeout: 240_000,
    });
    id = await findComp();
  }
  if (!id) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  compId = id;

  const detail = await api.get(`/api/comp/${compId}`);
  expect(detail.ok()).toBe(true);
  comp = (await detail.json()) as CompDetail;

  // Warm the materialized scores (rowless tasks compute synchronously on the
  // first read) so the UI tests never eat that cold compute.
  const scores = await api.get(`/api/comp/${compId}/scores`, { timeout: 240_000 });
  expect(scores.ok()).toBe(true);

  await api.dispose();
});

/**
 * Dev-login as the super-admin (admin of every comp, including the seeded
 * sample) and open the comp page. Same cookie plumbing as
 * comp-creation.spec.ts.
 */
test.beforeEach(async ({ page }) => {
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: SUPER_ADMIN,
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(
      `Dev login failed: ${loginRes.status()} ${loginRes.statusText()} — ${body}`
    );
  }
  const setCookieHeader = loginRes.headers()["set-cookie"];
  if (setCookieHeader) {
    const tokenMatch = setCookieHeader.match(/better-auth\.session_token=([^;]+)/);
    if (tokenMatch) {
      await page.context().addCookies([
        {
          name: "better-auth.session_token",
          value: tokenMatch[1],
          domain: "localhost",
          path: "/",
        },
      ]);
    }
  }

  await page.goto(`/comp/${compId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(COMP_NAME);
  // Admin affordances pop in once /api/auth/me resolves — the organisers'
  // Pilots row is the sync point that the super-admin view is active.
  await expect(
    page.getByRole("navigation", { name: "This competition" }).getByRole("link", { name: /^Pilots/ })
  ).toBeVisible();
});

/** Watches for any mutating call to the competition API for the page's life. */
function trackMutations(page: Page): () => boolean {
  let mutated = false;
  page.on("request", (r) => {
    if (r.method() === "GET" || !r.url().includes("/api/comp")) return;
    // One exception, and it has to be an exception: the CIVL ranking lookup
    // is a READ that takes a body, because what it reads about is the rows
    // the fill sheet sends, IDs it has only just found included
    // (routes/pilot.ts). Method alone
    // cannot tell it apart from a write, so it is named here rather than the
    // rule being loosened to "POST is fine".
    if (r.url().includes("/pilot/civl-rankings")) return;
    mutated = true;
  });
  return () => mutated;
}

/**
 * Every score link is a whole row: at least 44 px tall and as wide as its list
 * (Apple's HIG; WCAG 2.5.8). The scores views were tables whose cells were the
 * links — 18 px strips of text, six to a row, in a table that scrolled
 * sideways with the total off the edge of a phone.
 */
async function expectFullRows(list: Locator, count = 3): Promise<void> {
  const box = (await list.boundingBox())!;
  const links = list.getByRole("link");
  const n = Math.min(count, await links.count());
  expect(n, "the list has rows").toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const row = (await links.nth(i).boundingBox())!;
    expect(row.height, "a row is at least 44 px tall").toBeGreaterThanOrEqual(44);
    // The whole row is the target (2 px of border).
    expect(row.width, "a row is as wide as its list").toBeGreaterThanOrEqual(box.width - 2);
  }
}

test("scores page: the views and the class are lists, and the URL keeps them", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/scores`);
  await expect(page.getByRole("heading", { level: 1, name: "Scores" })).toBeVisible();
  const tablist = page.getByRole("tablist", { name: "Score views" });
  await expect(tablist).toBeVisible({ timeout: 15_000 });
  const classPicker = page.getByRole("radiogroup", { name: "Pilot class" });

  // ── Overall: one class's standings, picked under the views.
  const [classA, classB] = comp.pilot_classes;
  expect(classB).toBeTruthy();
  const standingsA = page.getByRole("list", { name: `Scores — ${classA}` });
  await expect(standingsA).toBeVisible();
  await expectFullRows(standingsA);
  await classPicker.getByRole("radio", { name: classB, exact: true }).click();
  const standingsB = page.getByRole("list", { name: `Scores — ${classB}` });
  await expect(standingsB).toBeVisible();
  await expect(standingsA).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`[?&]class=${encodeURIComponent(classB)}`));

  // ── Top 3: the class picker offers the roll-up too ("Overall" across both
  // classes), and each task's three are a list, the Total last.
  await tablist.getByRole("tab", { name: "Top 3" }).click();
  await expect(page).toHaveURL(/[?&]view=top3/);
  await classPicker.getByRole("radio", { name: "Overall", exact: true }).click();
  const overallTotal = page.getByRole("list", { name: "Top 3 — Overall, Total" });
  await expect(overallTotal).toBeVisible();
  await expectFullRows(overallTotal);

  // ── By task: the Select defaults to the first scorable task; picking a
  // task flown by the other class swaps the list.
  await tablist.getByRole("tab", { name: "By task" }).click();
  const panel = page.getByRole("tabpanel");
  const scorable = comp.tasks.filter((t) => t.has_xctsk);
  const defaultClass = scorable[0].pilot_classes[0];
  const byTask = panel.getByRole("list", { name: `Scores — ${defaultClass}` });
  await expect(byTask).toBeVisible({ timeout: 15_000 });
  await expectFullRows(byTask);
  // No class picker here: the task decides the class.
  await expect(classPicker).toHaveCount(0);

  // Options follow the scorable-tasks order, so the index into that array
  // addresses the option unambiguously (task *names* repeat across classes).
  const targetIndex = scorable.findIndex((t) => t.pilot_classes[0] !== defaultClass);
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  const targetClass = scorable[targetIndex].pilot_classes[0];
  await panel.getByRole("button", { name: /^Task/ }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(scorable.length);
  await options.nth(targetIndex).click();
  const swapped = panel.getByRole("list", { name: `Scores — ${targetClass}` });
  await expect(swapped).toBeVisible({ timeout: 15_000 });
  await expect(
    panel.getByRole("list", { name: `Scores — ${defaultClass}` })
  ).toHaveCount(0);

  // ── A reload is the same page: the view and the task are in the URL.
  await page.reload();
  await expect(tablist.getByRole("tab", { name: "By task" })).toHaveAttribute(
    "aria-selected",
    "true",
    { timeout: 15_000 }
  );
  await expect(panel.getByRole("list", { name: `Scores — ${targetClass}` })).toBeVisible({
    timeout: 15_000,
  });
});

test("scores page: a pilot's row opens their tasks, a task opens its report card, and the bar's Back returns", async ({
  page,
}) => {
  const [, classB] = comp.pilot_classes;
  await page.goto(`/comp/${compId}/scores?class=${encodeURIComponent(classB)}`);
  const standings = page.getByRole("list", { name: `Scores — ${classB}` });
  await expect(standings).toBeVisible({ timeout: 15_000 });

  // The pilot's own page: their tasks, each a row.
  const first = standings.getByRole("link").first();
  const pilotName = (await first.locator("p").first().textContent())!.trim();
  await first.click();
  await expect(page).toHaveURL(/\/scores\/[a-z0-9-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: pilotName })).toBeVisible();
  const tasks = page.getByRole("list", { name: `${pilotName}'s tasks` });
  await expect(tasks).toBeVisible({ timeout: 15_000 });
  await expectFullRows(tasks, 1);

  // A task row opens that task's report card.
  await tasks.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/task\/[a-z0-9-]+\/pilot\/[a-z0-9-]+$/);

  // The bar's back control is a real Back to where the reader came from,
  // and says so: the report card belongs under its task, but it was opened
  // from the pilot's page, and "Back to Task 1" there went to the task.
  await page.getByRole("link", { name: `Back to ${pilotName}` }).click();
  await expect(tasks).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: "Back to Scores" }).click();
  await expect(standings).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("radiogroup", { name: "Pilot class" }).getByRole("radio", { name: classB, exact: true })
  ).toBeChecked();
});

test("scores page: no view scrolls sideways on a narrow phone", { tag: PHONE_ONLY }, async ({ page }) => {
  // 320px is the narrowest viewport the accessibility standard supports
  // (docs/interaction-guide.md 3.3). The tables these views were
  // scrolled sideways inside the page; the lists fit it.
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(`/comp/${compId}/scores`);
  const tablist = page.getByRole("tablist", { name: "Score views" });
  await expect(tablist).toBeVisible({ timeout: 15_000 });

  const [classA] = comp.pilot_classes;
  await expect(page.getByRole("list", { name: `Scores — ${classA}` })).toBeVisible();
  await expectNoSidewaysScroll(page, "Overall");

  for (const name of ["By task", "Top 3"]) {
    // A tab the strip has scrolled out of reach is still reached: clicking
    // brings it on screen, and the panel swaps.
    const tab = tablist.getByRole("tab", { name });
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").getByRole("list").first()).toBeVisible({
      timeout: 15_000,
    });
    await expectNoSidewaysScroll(page, name);
  }
});

/**
 * Issue #863, decision 4: the strip of section links that stuck under the old
 * header is gone. Its links are rows on the competition page — full-width, a
 * finger tall, each a real link — and the same pages are in the menu under the
 * bar's title on every page of the competition. Tasks and Activity are
 * sections of the competition page itself.
 */
test("the competition's pages are rows on its page, a finger tall", async ({ page }) => {
  await page.goto(`/comp/${compId}`);
  const rows = page.getByRole("navigation", { name: "This competition" });
  await expect(rows).toBeVisible({ timeout: 15_000 });
  // No strip of section links any more.
  await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);

  const list = (await rows.getByRole("list").boundingBox())!;
  for (const name of [/^Scores/, /^Waypoints/, /^Pilots/, /^Comp analysis/]) {
    const row = rows.getByRole("link", { name });
    await expect(row).toBeVisible();
    const box = (await row.boundingBox())!;
    expect(box.height, `${name} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
    // The whole row is the target, not a label inside it (2 px of border).
    expect(box.width, `${name} is as wide as the list`).toBeGreaterThanOrEqual(list.width - 2);
  }
  await expectNoSidewaysScroll(page);

  // Tasks and Activity are this page's own sections.
  await expect(page.locator("#tasks")).toBeVisible();
  await expect(page.locator("#activity")).toBeVisible();

  // A task's row is a link a finger tall too.
  // A name can hold brackets ("Task 1 (stopped)"): escaped, so they are text.
  const taskName = comp.tasks[0].name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const task = page.locator("#tasks").getByRole("link", { name: new RegExp(taskName) }).first();
  expect((await task.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  await rows.getByRole("link", { name: /^Scores/ }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${compId}/scores`));
});

/**
 * The Tasks list is a grouped list per flying day, and each task is ONE row
 * that is the link. The rows used to be text links with the route glyph as a
 * second link beside them and a fold button on each day — three targets
 * where a phone wants one big one.
 */
test("tasks list: each task is one row-wide link under its day's heading", async ({ page }) => {
  await page.goto(`/comp/${compId}`);
  const tasks = page.locator("#tasks");
  await expect(tasks.getByRole("heading", { level: 2, name: "Tasks" })).toBeVisible({
    timeout: 15_000,
  });

  // One heading per flying day, and nothing to fold.
  const days = new Set(comp.tasks.map((t) => t.task_date));
  await expect(tasks.getByRole("heading", { level: 3 })).toHaveCount(days.size);
  await expect(tasks.locator("[aria-expanded]")).toHaveCount(0);

  // The glyph is the row's picture, not a second link beside the task's.
  await expect(tasks.getByRole("link", { name: /^Show the route for/ })).toHaveCount(0);

  const task = comp.tasks.find((t) => t.has_xctsk)!;
  const row = tasks.locator(`a[href$="-${task.task_id}"]`).first();
  await expect(row).toContainText(task.name);
  await expect(row).toContainText(task.pilot_classes[0]);
  await expect(row.locator("svg").first()).toBeVisible();

  // Measured, not asserted from classes: the link is the whole row, so it is
  // as wide as the list it sits in and at least the 44px a finger needs.
  const list = row.locator("xpath=ancestor::ul[1]");
  const rowBox = (await row.boundingBox())!;
  const listBox = (await list.boundingBox())!;
  expect(rowBox.height).toBeGreaterThanOrEqual(44);
  expect(rowBox.width).toBeGreaterThanOrEqual(listBox.width - 4);
  await expectNoSidewaysScroll(page);

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/task/[^/]*${task.task_id}$`));
  await expect(page.getByRole("heading", { level: 1, name: task.name })).toBeVisible();
});

test("the title's menu lists the competition's pages, with the open one ticked", async ({ page }) => {
  const pages = ["Scores", "Waypoints", "Pilots", "Comp analysis", "Settings"];

  // On the competition page they are the pages UNDER it.
  await page.goto(`/comp/${compId}`);
  await page.getByRole("button", { name: `${COMP_NAME}: go to another page` }).click();
  for (const name of pages) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("menuitem", { name: "Scores", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${compId}/scores`));
  await expect(page.getByRole("heading", { level: 1, name: "Scores" })).toBeVisible();

  // On one of them they are the pages BESIDE it, and it is the one marked.
  await page.getByRole("button", { name: "Scores: go to another page" }).click();
  await expect(page.getByRole("menuitem", { name: COMP_NAME, exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Scores", exact: true })).toBeDisabled();
  for (const name of pages.filter((n) => n !== "Scores")) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeEnabled();
  }
  await page.getByRole("menuitem", { name: "Waypoints", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${compId}/waypoints`));
});

test("the competition page's actions are in the bar's menu, and Submit your track is the bar's button", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}`);
  // None of them is a button on the page any more.
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Submit track", exact: true })).toHaveCount(0);
  await expect(page.locator("#tasks").getByRole("link", { name: "New task", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
  const labels = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
  // Submit your track is not a row: it is the bar's own button, after ⋯,
  // until the competition's close date (this competition's has passed or
  // not, as the fixture has it; task-submit-link.spec.ts presses it).
  expect(labels).toEqual([
    "Download the results record (PDF)",
    "New task",
    "Copy to a new competition…",
    "Settings",
  ]);
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${compId}/settings`));
});

test("scores page: the bar's menu saves a long-form CSV and offers the Sheets formula", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/scores`);
  // The downloads are rows of the bar's ⋯ menu (issue #863).
  await expect(page.getByRole("tablist", { name: "Score views" })).toBeVisible({ timeout: 15_000 });
  const download = page.getByRole("button", { name: "More actions" });
  await expect(download).toBeVisible();

  // ── The CSV item is a real link, so this is a browser download, not a blob.
  await download.click();
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "CSV spreadsheet" }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const saved = await file.path();
  const [header, ...rows] = readFileSync(saved, "utf-8").trim().split("\n");
  // Long form: ONE score column and a task column — not a column per task.
  expect(header.split(",")).toContain("task");
  expect(header.split(",")).toContain("score");
  expect(header).not.toContain(comp.tasks[0].name);
  const columns = header.split(",");
  expect(rows.length).toBeGreaterThan(1);
  // Quoted cells may hold commas; split only on separators outside quotes.
  const split = (row: string) => row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  for (const row of rows.slice(0, 20)) {
    expect(split(row)).toHaveLength(columns.length);
  }

  // ── Ids ship as absolute URLs back into the site, and they resolve.
  const first = split(rows[0]);
  const cell = (name: string) => first[columns.indexOf(name)];
  for (const name of ["comp_url", "task_url", "score_url"]) {
    expect(cell(name), name).toMatch(new RegExp(`^${BASE_URL}/comp/`));
  }
  expect((await page.request.get(cell("score_url"))).status()).toBe(200);

  // ── The Sheets route hands over an IMPORTDATA formula for the same URL.
  await download.click();
  await page.getByRole("menuitem", { name: /Google Sheets/ }).click();
  const dialog = page.getByRole("dialog", { name: "Open in Google Sheets" });
  await expect(dialog).toBeVisible();
  // The address bar has settled on the canonical `${slug}-${id}` by now, so
  // the formula quotes that URL rather than the bare-id one we navigated to.
  await expect(dialog.locator("code")).toHaveText(
    `=IMPORTDATA("${BASE_URL}${compScoresCsvPath(compId, comp.name)}")`
  );
  // Both routes out to Google are EXTERNAL urls. RAC hands hrefs to
  // react-router's useHref, which resolved them against the current path and
  // rendered /comp/<comp>/scores/https:/sheets.new — a 404 that only a click
  // revealed. See rac/router.tsx and the RAC guide's gotcha #20.
  for (const name of ["sheets.new", "New Google Sheet"]) {
    await expect(dialog.getByRole("link", { name })).toHaveAttribute(
      "href",
      "https://sheets.new"
    );
  }

  // The main action is last: Done · New Google Sheet · Copy formula.
  await expect(
    dialog.locator("button, a").filter({ hasText: /^(Done|New Google Sheet|Copy formula)$/ })
  ).toHaveText([
    "Done",
    "New Google Sheet",
    "Copy formula",
  ]);

  // Escape closes it and focus returns to the button that opened the menu.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(download).toBeFocused();
});

test("pilots page: a list that opens each pilot's page, and leaving one untouched sends nothing", async ({
  page,
}) => {
  // The roster editor is its own admin-only page now.
  await page.goto(`/comp/${compId}/pilots`);
  await expect(
    page.getByRole("heading", { level: 1, name: /Pilots/ })
  ).toBeVisible({ timeout: 15_000 });

  const mutated = trackMutations(page);

  // A list, at every width — the grid it replaced is gone.
  const roster = page.getByRole("grid", { name: "Pilots" });
  await expect(roster.getByRole("row").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".tabulator")).toHaveCount(0);

  // A row opens that pilot's own page. An untouched pilot has nothing to
  // save, so Save (in the bar) is not live, and Cancel goes back without a
  // request or a question.
  const name = (await roster.getByRole("row").first().locator("p.font-medium").innerText()).trim();
  await roster.getByRole("row").first().click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("main").getByRole("textbox", { name: "Name" })).toHaveValue(name);
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(roster).toBeVisible();

  // Back from an untouched pilot is the browser's Back, back to the list.
  await roster.getByRole("row").first().click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await page.goBack();
  await expect(roster).toBeVisible();

  expect(mutated()).toBe(false);
});

test("activity: collapsed digest expands, filter tabs switch and re-fetch", async ({ page }) => {
  const activity = page.locator("#activity");
  // The comp hub renders a 3-entry digest; "Show all activity" expands into
  // the full filterable log.
  await activity.getByRole("button", { name: "Show all activity" }).click();
  const tablist = activity.getByRole("tablist", { name: "Activity filter" });
  await expect(tablist).toBeVisible();
  const panel = activity.getByRole("tabpanel");

  const auditResponse = (subjectType: string | null) =>
    page.waitForResponse((r) => {
      const u = new URL(r.url());
      return (
        u.pathname.endsWith("/audit") &&
        u.searchParams.get("subject_type") === subjectType
      );
    });

  // Switching to "Tasks" re-fetches with subject_type=task…
  const taskFetch = auditResponse("task");
  const tasksTab = tablist.getByRole("tab", { name: "Tasks", exact: true });
  await tasksTab.click();
  expect((await taskFetch).ok()).toBe(true);
  await expect(tasksTab).toHaveAttribute("aria-selected", "true");
  // …and the panel shows entries or the empty state (seeded data has no
  // audit rows — the seed writes D1 directly), never the error state.
  await expect(
    panel.getByText("No activity yet").or(panel.locator("li").first())
  ).toBeVisible();
  await expect(panel.getByText("Could not load activity")).toHaveCount(0);

  // Back to "All" (sentinel key → unfiltered fetch).
  const allFetch = auditResponse(null);
  const allTab = tablist.getByRole("tab", { name: "All", exact: true });
  await allTab.click();
  expect((await allFetch).ok()).toBe(true);
  await expect(allTab).toHaveAttribute("aria-selected", "true");
  await expect(
    panel.getByText("No activity yet").or(panel.locator("li").first())
  ).toBeVisible();
  await expect(panel.getByText("Could not load activity")).toHaveCount(0);
});

/*
 * RAC gotcha #22 (the popover displaced off-screen on a scrolled page) used
 * to be covered here, on the settings dialog's Series scoring select and then
 * on the settings PAGE's copy of it. The settings pages no longer contain a
 * popover of any kind — every select became a `rac/choice-list` row list and
 * the calendar is rendered in flow — so there is no geometry left to assert.
 * The gotcha keeps its coverage in popover-position.spec.ts, which drives the
 * manual-flight turnpoint select on a scrolled task page and asserts the open
 * listbox lands fully inside the viewport.
 */

test("scoring settings page shows stored GAP values; leaving saves nothing", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  await page.goto(`/comp/${compId}/settings/scoring`);
  await expect(page.getByRole("heading", { name: "Scoring", exact: true })).toBeVisible();

  // Advanced GAP NumberFields show the comp's STORED values, not snapped
  // (RAC gotcha #1) and not the category defaults. The seeded comp's
  // AirScore-captured params differ from the HG defaults exactly where it
  // matters: essNotGoalFactor 0 (HG default 80) and leading points off
  // (HG default on) prove these are the stored values.
  await page.getByText("Advanced scoring settings").click();
  await expect(
    page.getByRole("textbox", { name: "Nominal time (min)" })
  ).toHaveValue("90");
  await expect(
    page.getByRole("textbox", { name: "Minimum distance (km)" })
  ).toHaveValue("5");
  // The §11 Leading Time Ratio resolves to the HG discipline default when
  // the stored params never pinned one.
  await expect(
    page.getByRole("textbox", { name: "Leading-time ratio (%)" })
  ).toHaveValue("17.5");
  await expect(
    page.getByRole("textbox", { name: "ESS but not goal: points kept (%, HG)" })
  ).toHaveValue("0");
  // No comp-level nominal distance stored → blank means "auto", not a
  // min/step-snapped number.
  await expect(
    page.getByRole("textbox", { name: "Nominal distance (km)" })
  ).toHaveValue("");
  // Reading (not clicking — gotcha #13) checkbox state is fine by role.
  await expect(
    page.getByRole("switch", { name: "Leading (departure) points" })
  ).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Arrival points (HG only)" })
  ).not.toBeChecked();

  // Leave without saving with the bar's Cancel — untouched fields arm no
  // guard, so it asks nothing; the index renders, and nothing was PATCHed.
  // The Scoring row is scoped to main because the Shell footer also carries
  // a "Scoring" link.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^Scoring/ })
  ).toBeVisible();
  expect(mutated()).toBe(false);
});

test("general settings page: the timezone list filters in flow; leaving saves nothing", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  await page.goto(`/comp/${compId}/settings/general`);
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();

  const main = page.getByRole("main");

  // Timezone: a collapsed row showing the current zone, expanding to a search
  // box over the ~400 zones. Adelaide rather than the comp's own Melbourne,
  // so the pick is guaranteed to dirty the form for the guard assertion below.
  await main.getByRole("button", { name: "Timezone" }).click();

  // The list is IN FLOW, not a popover — scoping to main is the assertion
  // (a portalled popover renders as a sibling of #root, outside main).
  const listbox = main.getByRole("listbox");
  await expect(listbox).toBeVisible();

  await page.getByRole("searchbox", { name: "Search timezones" }).fill("adelaide");
  const options = listbox.getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText("Australia/Adelaide");
  await options.first().click();

  // Picking collapses the list back to the row, which now reads the new zone.
  await expect(listbox).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Timezone" })).toContainText(
    "Australia/Adelaide"
  );

  // The pick dirtied the form, so Cancel asks first; Discard drops the edit
  // and leaves — and nothing was PATCHed.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const guard = page.getByRole("alertdialog");
  await expect(guard.getByText("Discard changes?")).toBeVisible();
  await guard.getByRole("button", { name: "Discard changes" }).click();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^General/ })
  ).toBeVisible();
  expect(mutated()).toBe(false);
});
