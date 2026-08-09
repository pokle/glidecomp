/**
 * Comp detail page (/comp/:id) — interaction coverage for its RAC surfaces
 * (converted 2026-07-21, see docs/2026-07-18-rac-adoption-guide.md):
 * scores view tabs + sortable scores tables + the scores-by-task Select,
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

/**
 * RAC gotcha #22, and the reason `popoverClass` carries `fixed!`.
 *
 * RAC portals a popover to <body> and positions it with viewport-relative
 * offsets under `position: absolute`; our body is `position: relative` (iOS
 * Safari backdrops), so the containing block is the body BOX. A popover that
 * flips UPWARDS — which any select low in a tall dialog does — was displaced
 * by exactly `scrollHeight - innerHeight`: open, focusable, every option in
 * the DOM, and far below the fold.
 *
 * This lived on the pilots editor's CIVL list picker until that picker was
 * removed (one number per pilot, no list to choose). The settings dialog's
 * advanced scoring selects are the same geometry — deep inside a tall modal —
 * so the kit fix keeps its coverage here.
 */
test("a select low in a tall dialog opens ON SCREEN, not below the fold", async ({
  page,
}) => {
  const mutated = trackMutations(page);
  // A short window is what makes the page taller than the viewport, which is
  // the only condition under which the displacement happens.
  await page.setViewportSize({ width: 1280, height: 600 });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Advanced scoring settings").click();

  // The trigger has to sit LOW in the window, because that is what makes RAC
  // flip the popover upwards and emit the `bottom:` placement the bug
  // displaces — opened higher up it opens downward and lands correctly even
  // when broken. Verified: at ~70px from the bottom RAC emits `bottom: 78px`,
  // which without the fix put the list 735px below the fold.
  const select = dialog.getByRole("button", { name: "Time points exponent" });
  await select.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>(
      'button[aria-label="Time points exponent"]'
    );
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
      ?.parentElement;
    if (!trigger || !overlay) throw new Error("settings dialog not laid out as expected");
    overlay.scrollTop += trigger.getBoundingClientRect().y - (window.innerHeight - 70);
  });
  await select.click();

  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const box = await listbox.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  // toBeVisible() alone would NOT catch this: an off-screen popover is still
  // "visible" to Playwright. The rect is the assertion.
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(viewport.height);

  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(mutated()).toBe(false);
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
