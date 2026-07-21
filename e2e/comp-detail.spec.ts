/**
 * Comp detail page (/comp/:id) — interaction coverage for its RAC surfaces
 * (converted 2026-07-21, see docs/2026-07-18-rac-adoption-guide.md):
 * scores view tabs + sortable standings tables + the results-by-task Select,
 * the pilots section (read-only RAC grid + the kept-by-policy Tabulator edit
 * grid inside a RAC dialog shell), the activity filter tabs, and the settings
 * dialog (Advanced GAP NumberFields, timezone combobox).
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
 * - RAC checkboxes can't be *clicked* by role (the real input is visually
 *   hidden) — this spec only reads checkbox state, which works fine.
 * - While a ComboBox popover is open, ariaHideOutside aria-hides the rest of
 *   the dialog (role locators fail there) — the timezone combobox is driven
 *   last, and only its own options are queried while it's open.
 * - RAC Table sorting: first click on a new column follows the app's
 *   per-column defaultDir ("Pilot" asc, "Total" desc), not RAC's
 *   always-ascending.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";

const BASE_URL = "http://localhost:3000";
const COMP_NAME = "Corryong Cup 2026";
const SUPER_ADMIN = { name: "Tushar Pokle", email: "tushar.pokle@gmail.com" };

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

/**
 * The task the "Results by task" picker defaults to — same pick as the page's
 * pickHeroTasks(): today's task, else the next upcoming, else the latest.
 * (The page computes "today" in the comp's timezone; the seeded comp's tasks
 * are all in the past, so both sides resolve to the latest date regardless.)
 */
function heroDefaultTask(tasks: TaskSummary[]): TaskSummary {
  const today = new Intl.DateTimeFormat("en-CA").format(new Date());
  const dates = [...new Set(tasks.map((t) => t.task_date))].sort();
  const date = dates.includes(today)
    ? today
    : (dates.find((d) => d > today) ?? dates[dates.length - 1]);
  const task = tasks.filter((t) => t.task_date === date).find((t) => t.has_xctsk);
  if (!task) throw new Error("Seeded comp has no scorable task on its hero date");
  return task;
}

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
  // Admin affordances pop in once /api/auth/me resolves — the Settings button
  // is the sync point that the super-admin view is active.
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible();
});

/** Watches for any mutating call to the competition API for the page's life. */
function trackMutations(page: Page): () => boolean {
  let mutated = false;
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/comp")) mutated = true;
  });
  return () => mutated;
}

test("scores: class tabs, top 3, results-by-task select, sorting", async ({
  page,
}) => {
  const scores = page.locator("#scores");
  const tablist = scores.getByRole("tablist", { name: "Score views" });
  await expect(tablist).toBeVisible({ timeout: 15_000 });

  // ── Class tab switching. Only the selected TabPanel renders its content,
  // so the other class's standings grid must leave the tree entirely.
  const [classA, classB] = comp.pilot_classes;
  expect(classB).toBeTruthy();
  await tablist.getByRole("tab", { name: classB, exact: true }).click();
  await expect(
    scores.getByRole("grid", { name: `Standings — ${classB}` })
  ).toBeVisible();
  await expect(
    scores.getByRole("grid", { name: `Standings — ${classA}` })
  ).toHaveCount(0);
  await tablist.getByRole("tab", { name: classA, exact: true }).click();
  const standings = scores.getByRole("grid", { name: `Standings — ${classA}` });
  await expect(standings).toBeVisible();
  await expect(
    scores.getByRole("grid", { name: `Standings — ${classB}` })
  ).toHaveCount(0);

  // ── SortableTable per-column first-click directions (RAC gotcha #15: RAC
  // itself always starts ascending; the app overrides per column).
  // "Pilot" first click sorts ASCENDING…
  const pilotHeader = standings.getByRole("columnheader", { name: /^Pilot/ });
  await pilotHeader.click();
  await expect(pilotHeader).toHaveAttribute("aria-sort", "ascending");
  const names = await standings.getByRole("rowheader").allTextContents();
  expect(names.length).toBeGreaterThan(1);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

  // …while "Total" first click sorts DESCENDING (scores read best-first).
  const totalHeader = standings.getByRole("columnheader", { name: /^Total/ });
  await totalHeader.click();
  await expect(totalHeader).toHaveAttribute("aria-sort", "descending");
  await expect(pilotHeader).not.toHaveAttribute("aria-sort", "ascending");
  // The Pilot column renders as rowheader <th>, so the last <td> is Total.
  const totals = (
    await standings.locator("tbody tr td:last-child").allTextContents()
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

  // ── Results by task: the Select defaults to the hero task; picking a task
  // flown by the other class swaps the embedded grid (aria-label + rows).
  await tablist.getByRole("tab", { name: "Results by task" }).click();
  const panel = scores.getByRole("tabpanel");
  const scorable = comp.tasks.filter((t) => t.has_xctsk);
  const defaultClass = heroDefaultTask(comp.tasks).pilot_classes[0];
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

test("pilots: read-only grid, Tabulator editor, list-editor popup, cancel discards", async ({
  page,
}) => {
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

test("activity: filter tabs switch and re-fetch", async ({ page }) => {
  const activity = page.locator("#activity");
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

test("settings dialog: stored GAP values, timezone combobox filter, cancel", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Competition Settings" })
  ).toBeVisible();

  // Advanced GAP NumberFields show the comp's STORED values, not snapped
  // (RAC gotcha #1) and not the category defaults. The seeded comp's
  // AirScore-captured params differ from the HG defaults exactly where it
  // matters: essNotGoalFactor 0 (HG default 80) and leading points off
  // (HG default on) prove these are the stored values.
  await dialog.getByText("Advanced scoring settings").click();
  await expect(
    dialog.getByRole("textbox", { name: "Nominal time (min)" })
  ).toHaveValue("90");
  await expect(
    dialog.getByRole("textbox", { name: "Nominal goal (%)" })
  ).toHaveValue("30");
  await expect(
    dialog.getByRole("textbox", { name: "Minimum distance (km)" })
  ).toHaveValue("5");
  await expect(
    dialog.getByRole("textbox", { name: "ESS but not goal: points kept (%, HG)" })
  ).toHaveValue("0");
  // No comp-level nominal distance stored → blank means "auto", not a
  // min/step-snapped number.
  await expect(
    dialog.getByRole("textbox", { name: "Nominal distance (km)" })
  ).toHaveValue("");
  // Reading (not clicking — gotcha #13) checkbox state is fine by role.
  await expect(
    dialog.getByRole("checkbox", { name: "Leading (departure) points" })
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Arrival points (HG only)" })
  ).not.toBeChecked();

  // Timezone combobox: typing filters hundreds of zones down; picking fills
  // the field. Driven last — while its popover is open, ariaHideOutside
  // hides the rest of the dialog from role locators (gotcha #12).
  const timezone = dialog.getByRole("combobox");
  await timezone.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await timezone.fill("melbourne");
  const options = page.getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText("Australia/Melbourne");
  await options.first().click();
  await expect(timezone).toHaveValue("Australia/Melbourne");

  // Cancel discards — the dialog unmounts and nothing was PATCHed.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutated()).toBe(false);
});
