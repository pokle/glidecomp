/**
 * Comp detail page (/comp/:id) — interaction coverage for its RAC surfaces
 * (converted 2026-07-21, see docs/2026-07-18-rac-adoption-guide.md):
 * scores view tabs + sortable scores tables + the scores-by-task Select,
 * the pilots section (read-only RAC grid + the kept-by-policy Tabulator edit
 * grid inside a RAC dialog shell), the activity filter tabs, and the routed
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
import { test, expect, type Page } from "./fixtures/test";
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
  // Admin affordances pop in once /api/auth/me resolves — the Settings link
  // is the sync point that the super-admin view is active.
  await expect(
    page.getByRole("link", { name: "Settings", exact: true })
  ).toBeVisible();
});

/** Watches for any mutating call to the competition API for the page's life. */
function trackMutations(page: Page): () => boolean {
  let mutated = false;
  page.on("request", (r) => {
    if (r.method() === "GET" || !r.url().includes("/api/comp")) return;
    // One exception, and it has to be an exception: the CIVL ranking lookup
    // is a READ that takes a body, because what it reads about is the roster
    // sitting unsaved in the editor's grid (routes/pilot.ts). Method alone
    // cannot tell it apart from a write, so it is named here rather than the
    // rule being loosened to "POST is fine".
    if (r.url().includes("/pilot/civl-rankings")) return;
    mutated = true;
  });
  return () => mutated;
}

test("scores page: class tabs, top 3, scores-by-task select, sorting", async ({
  page,
}) => {
  // The full score views live on the dedicated scores page now; the comp page
  // keeps a compact scores summary linking there.
  await page.goto(`/comp/${compId}/scores`);
  await expect(page.getByRole("heading", { level: 1, name: "Scores" })).toBeVisible();
  const scores = page.locator("main");
  const tablist = scores.getByRole("tablist", { name: "Score views" });
  await expect(tablist).toBeVisible({ timeout: 15_000 });

  // ── Class tab switching. Only the selected TabPanel renders its content,
  // so the other class's scores grid must leave the tree entirely.
  const [classA, classB] = comp.pilot_classes;
  expect(classB).toBeTruthy();
  await tablist.getByRole("tab", { name: classB, exact: true }).click();
  await expect(
    scores.getByRole("grid", { name: `Scores — ${classB}` })
  ).toBeVisible();
  await expect(
    scores.getByRole("grid", { name: `Scores — ${classA}` })
  ).toHaveCount(0);
  await tablist.getByRole("tab", { name: classA, exact: true }).click();
  const classScores = scores.getByRole("grid", { name: `Scores — ${classA}` });
  await expect(scores).toBeVisible();
  await expect(
    scores.getByRole("grid", { name: `Scores — ${classB}` })
  ).toHaveCount(0);

  // ── SortableTable per-column first-click directions (RAC gotcha #15: RAC
  // itself always starts ascending; the app overrides per column).
  // "Pilot" first click sorts ASCENDING…
  const pilotHeader = scores.getByRole("columnheader", { name: /^Pilot/ });
  await pilotHeader.click();
  await expect(pilotHeader).toHaveAttribute("aria-sort", "ascending");
  const names = await scores.getByRole("rowheader").allTextContents();
  expect(names.length).toBeGreaterThan(1);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

  // …while "Total" first click sorts DESCENDING (scores read best-first).
  const totalHeader = scores.getByRole("columnheader", { name: /^Total/ });
  await totalHeader.click();
  await expect(totalHeader).toHaveAttribute("aria-sort", "descending");
  await expect(pilotHeader).not.toHaveAttribute("aria-sort", "ascending");
  // The Pilot column renders as rowheader <th>, so the last <td> is Total.
  const totals = (
    await scores.locator("tbody tr td:last-child").allTextContents()
  ).map((t) => Number(t.replace(/,/g, "")));
  expect(totals.length).toBeGreaterThan(1);
  for (let i = 1; i < totals.length; i++) {
    expect(totals[i]).toBeLessThanOrEqual(totals[i - 1]);
  }

  // ── Top 3 panel: per-class groups plus the synthetic "Overall" rollup
  // (the comp has two classes), each ending in a "Total" row.
  await tablist.getByRole("tab", { name: "Top 3 per task & class" }).click();
  const overall = scores.getByRole("grid", { name: "Top 3 — Overall" });
  await expect(overall).toBeVisible();
  await expect(overall.getByRole("rowheader", { name: "Total", exact: true })).toBeVisible();
  await expect(scores.getByRole("grid", { name: `Top 3 — ${classA}` })).toBeVisible();

  // ── Scores by task: the Select defaults to the first scorable task;
  // picking a task flown by the other class swaps the embedded grid
  // (aria-label + rows).
  await tablist.getByRole("tab", { name: "Scores by task" }).click();
  const panel = scores.getByRole("tabpanel");
  const scorable = comp.tasks.filter((t) => t.has_xctsk);
  const defaultClass = scorable[0].pilot_classes[0];
  await expect(
    panel.getByRole("grid", { name: `Scores — ${defaultClass}` })
  ).toBeVisible({ timeout: 15_000 });

  // Options follow the scorable-tasks order, so the index into that array
  // addresses the option unambiguously (task *names* repeat across classes).
  const targetIndex = scorable.findIndex((t) => t.pilot_classes[0] !== defaultClass);
  expect(targetIndex).toBeGreaterThanOrEqual(0);
  const targetClass = scorable[targetIndex].pilot_classes[0];
  await panel.getByRole("button", { name: /^Task/ }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(scorable.length);
  await options.nth(targetIndex).click();

  const swapped = panel.getByRole("grid", { name: `Scores — ${targetClass}` });
  await expect(swapped).toBeVisible({ timeout: 15_000 });
  await expect(
    panel.getByRole("grid", { name: `Scores — ${defaultClass}` })
  ).toHaveCount(0);
  await expect(swapped.locator("tbody tr").first()).toBeVisible();
});

test("scores page: the view tabs stay reachable on a narrow phone", async ({
  page,
}) => {
  // 320px is the narrowest viewport the accessibility standard supports
  // (docs/accessibility-standard.md §3.2). The sample comp's four views —
  // two classes, "Top 3 per task & class", "Scores by task" — are wider than
  // that, which is the case issue #640 reported: the far tabs were simply
  // unreachable, because the strip neither wrapped nor scrolled.
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto(`/comp/${compId}/scores`);
  const tablist = page.getByRole("tablist", { name: "Score views" });
  await expect(tablist).toBeVisible({ timeout: 15_000 });

  const metrics = async () =>
    tablist.evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      hidden: el.scrollWidth - el.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    }));

  // The strip scrolls INSIDE its own box; the page body never does (WCAG
  // 1.4.10 reflow).
  const initial = await metrics();
  expect(initial.hidden).toBeGreaterThan(0);
  expect(initial.pageOverflow).toBeLessThanOrEqual(0);

  // Scrolled to the origin, only the far end is faded — the fades are the
  // affordance that says there are tabs behind them.
  await expect(page.locator("main [data-tab-fade='end']")).toHaveCount(1);
  await expect(page.locator("main [data-tab-fade='start']")).toHaveCount(0);

  // Keyboard: arrow keys walk to the last tab and the strip follows, which is
  // why the scroll container takes no tab stop of its own. Automatic
  // activation means arriving selects it, so the panel swaps too.
  const tabs = tablist.getByRole("tab");
  const count = await tabs.count();
  await tabs.first().click();
  for (let i = 1; i < count; i++) await page.keyboard.press("ArrowRight");
  const last = tabs.nth(count - 1);
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-selected", "true");

  // "Reachable" means fully on screen, not merely scrolled towards.
  const stripBox = (await tablist.boundingBox())!;
  const lastBox = (await last.boundingBox())!;
  expect(lastBox.x).toBeGreaterThanOrEqual(stripBox.x - 0.5);
  expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(
    stripBox.x + stripBox.width + 0.5
  );

  const scrolled = await metrics();
  expect(scrolled.scrollLeft).toBeGreaterThan(0);
  expect(scrolled.pageOverflow).toBeLessThanOrEqual(0);
  // …and now it is the START of the strip that has tabs behind it.
  await expect(page.locator("main [data-tab-fade='start']")).toHaveCount(1);
  await expect(page.locator("main [data-tab-fade='end']")).toHaveCount(0);
});

test("scores page: Download menu saves a long-form CSV and offers the Sheets formula", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/scores`);
  const download = page.getByRole("button", { name: "Download" });
  await expect(download).toBeVisible({ timeout: 15_000 });

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

  // Escape closes it and focus returns to the button that opened the menu.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(download).toBeFocused();
});

test("pilots page: read-only grid, Tabulator editor, list-editor popup, cancel discards", async ({
  page,
}) => {
  // The roster editor is its own admin-only page now.
  await page.goto(`/comp/${compId}/pilots`);
  await expect(
    page.getByRole("heading", { level: 1, name: /Pilots/ })
  ).toBeVisible({ timeout: 15_000 });

  const mutated = trackMutations(page);

  // Read-only RAC grid renders the roster.
  const roster = page.getByRole("grid", { name: "Pilots" });
  await expect(roster).toBeVisible({ timeout: 15_000 });
  await expect(roster.locator("tbody tr").first()).toBeVisible();

  // "Edit" opens the dialog and the (lazy-loaded) Tabulator grid builds.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit pilots" })).toBeVisible();
  const firstRow = page.locator("#pilots-grid .tabulator-row").first();
  await expect(firstRow).toBeVisible({ timeout: 15_000 });

  // Edit a class cell: the list editor's popup must render *inside* the
  // dialog (Tabulator popupContainer: "#pilots-edit-dialog"), else the modal
  // would paint over it.
  const classCell = firstRow.locator('[tabulator-field="pilot_class"]');
  const original = (await classCell.innerText()).trim();
  const replacement = comp.pilot_classes.find((c) => c !== original);
  expect(replacement).toBeTruthy();
  await classCell.click();
  const editList = page.locator("#pilots-edit-dialog .tabulator-edit-list");
  await expect(editList).toBeVisible();
  await editList
    .locator(".tabulator-edit-list-item")
    .getByText(replacement!, { exact: true })
    .click();
  await expect(classCell).toHaveText(replacement!);

  // Cancel discards: dialog closes without saving…
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // …so reopening rebuilds the grid with the original value.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const reopenedRow = page.locator("#pilots-grid .tabulator-row").first();
  await expect(reopenedRow).toBeVisible({ timeout: 15_000 });
  await expect(reopenedRow.locator('[tabulator-field="pilot_class"]')).toHaveText(
    original
  );
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

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

  // Leave without saving via the breadcrumb — untouched fields arm no guard,
  // the index renders, and nothing was PATCHed. The Scoring row is scoped to
  // main because the Shell footer also carries a "Scoring" link.
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
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

  // The pick dirtied the form, so leaving prompts; Discard drops the edit
  // and navigates — and nothing was PATCHed.
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  const guard = page.getByRole("alertdialog");
  await expect(guard.getByText("Discard changes?")).toBeVisible();
  await guard.getByRole("button", { name: "Discard changes" }).click();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^General/ })
  ).toBeVisible();
  expect(mutated()).toBe(false);
});
