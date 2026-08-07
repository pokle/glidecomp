/**
 * CIVL world rankings on the pilot roster (/comp/:id/pilots).
 *
 * The organiser's workflow, end to end: open the roster editor, fill the CIVL
 * IDs the ranking list can identify by name, fill each pilot's ranking from
 * their ID, save, and read the roster down the ranking column to build a
 * launch order.
 *
 * Runs against a SYNTHETIC list (`bun run seed-civl-rankings` — slug
 * `sample-world-ranking`, never one of CIVL's ten). The real rankings arrive
 * from civlcomps.org monthly and change under us, so nothing here could assert
 * against them; the fixture pilots below are the ones that script ranks, and
 * the two files have to agree.
 *
 * Creates its own comp, named through e2eCompName so a killed run is swept
 * (fixtures/stack.ts), and deletes it afterwards.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures/test";
import { e2eCompName } from "./fixtures/stack";

const TEST_USER = {
  name: "E2E Rankings Organiser",
  email: "e2e-civl-rankings@test.local",
};
const COMP_NAME = e2eCompName("CIVL Rankings");

/**
 * The roster. Names come from web/scripts/seed-civl-rankings.ts:
 *
 * - Bruno Ridge already carries his CIVL ID, so his ranking can be filled
 *   without touching the ID column at all;
 * - Ada Thermal and Cleo Vario are ranked but ID-less — the case "Fill CIVL
 *   IDs" exists for;
 * - Twin Ambiguity is ranked TWICE under one name, so nothing may be filled
 *   in for them;
 * - Unranked Nobody is in no list at all.
 */
const MATCHING_ROSTER = [
  { registered_pilot_name: "Bruno Ridge", registered_pilot_civl_id: "9000002" },
  { registered_pilot_name: "Ada Thermal" },
  { registered_pilot_name: "Cleo Vario" },
  { registered_pilot_name: "Twin Ambiguity" },
  { registered_pilot_name: "Unranked Nobody" },
];

/**
 * Padding, and load-bearing: the popover test below needs a roster page TALLER
 * THAN THE WINDOW, which is the only condition under which a body-portalled
 * popover is displaced (gotcha #22). None of these names is in any ranking
 * list, so every match count stays about the five pilots above.
 */
const FILLER_ROSTER = Array.from({ length: 30 }, (_, i) => ({
  registered_pilot_name: `Filler Pilot ${String(i + 1).padStart(2, "0")}`,
}));

const ROSTER = [...MATCHING_ROSTER, ...FILLER_ROSTER];

let compId: string;

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login
    .headers()
    ["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      {
        name: "better-auth.session_token",
        value: token[1],
        domain: "localhost",
        path: "/",
      },
    ]);
  }
}

test.beforeAll(async ({ playwright }) => {
  // Local D1 starts with no rankings at all, and this suite must not depend on
  // anyone having run the real importer. Cheap and idempotent.
  execSync("bun run seed-civl-rankings", { stdio: "inherit", timeout: 120_000 });

  const api = await playwright.request.newContext({
    baseURL: process.env.DEV_FRONTEND_PORT
      ? `http://localhost:${process.env.DEV_FRONTEND_PORT}`
      : "http://localhost:3000",
  });
  const login = await api.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);

  const created = await api.post("/api/comp", {
    data: {
      name: COMP_NAME,
      category: "hg",
      pilot_classes: ["open"],
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  compId = ((await created.json()) as { comp_id: string }).comp_id;

  const roster = await api.post(`/api/comp/${compId}/pilot/bulk`, {
    data: {
      pilots: ROSTER.map((p) => ({ ...p, pilot_class: "open" })),
    },
  });
  expect(roster.ok(), await roster.text()).toBe(true);
  await api.dispose();
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({
    baseURL: process.env.DEV_FRONTEND_PORT
      ? `http://localhost:${process.env.DEV_FRONTEND_PORT}`
      : "http://localhost:3000",
  });
  await api.post("/api/auth/dev-login", { data: TEST_USER });
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/**
 * Wait for the editor's grid to be built and its ranking lookup answered.
 *
 * The lookup is what the typeahead and the fill both read, and it is fired
 * when the grid reports ready — so "the Fill button is enabled" is the one
 * signal that covers both. It used to be "the picker shows a list name", which
 * stopped existing when the picker moved into its own dialog.
 */
async function expectGridReady(page: Page): Promise<void> {
  await expect(page.locator("#pilots-grid .tabulator-row").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Fill from CIVL…" })).toBeEnabled({
    timeout: 20_000,
  });
}

/**
 * Open the fill's own dialog from the roster editor.
 *
 * The picker and its button used to sit under the grid, where on a phone they
 * cost about a fifth of the editor whether or not anyone was filling anything.
 */
async function openCivlDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Fill from CIVL…" }).click();
  await expect(
    page.getByRole("heading", { name: "Fill from CIVL rankings" })
  ).toBeVisible({ timeout: 20_000 });
}

test("one press fills IDs by name and then rankings by ID, and shows where they came from", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/pilots`);
  await page.getByRole("button", { name: "Edit" }).click();
  await openCivlDialog(page);

  // The picker only appears once the lookup has answered — and it answers
  // about the grid, so it doubles as "the grid is loaded".
  const picker = page.getByRole("button", { name: /Sample World Ranking/ });
  await expect(picker).toBeVisible({ timeout: 20_000 });
  // Three are placeable: Bruno by his ID, Ada and Cleo by name. Twin
  // Ambiguity (two ranked pilots, one name), Unranked Nobody and every filler
  // are not.
  await expect(picker).toHaveText(new RegExp(`3 of ${ROSTER.length} pilots`));

  // ONE press. Ids first, then the ranks that only become fillable once the
  // ids are in — the ordering the organiser used to have to know about.
  await page.getByRole("button", { name: "Fill roster" }).click();
  // Ada and Cleo gain ids (Bruno already had one, Twin Ambiguity is refused);
  // all three are then ranked BY ID, including the two just filled.
  // The fill dialog closes on its way out, so the outcome lands under the
  // grid rather than behind the dialog that started it.
  await expect(
    page.getByRole("heading", { name: "Fill from CIVL rankings" })
  ).toBeHidden({ timeout: 20_000 });
  await expect(
    page.getByText(/From Sample World Ranking .*2 CIVL IDs and 3 rankings filled in/)
  ).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20_000 });

  // The roster now carries the numbers, each saying which list and month it
  // came from — the difference between a checkable rank and a bare one.
  const brunoRow = page.getByRole("row", { name: /Bruno Ridge/ });
  await expect(brunoRow).toContainText("Sample World Ranking");
  await expect(page.getByRole("row", { name: /Twin Ambiguity/ })).not.toContainText(
    "Sample World Ranking"
  );
});

test("typing a name suggests ranked pilots, and picking one brings its id and rank", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/pilots`);
  await page.getByRole("button", { name: "Edit" }).click();
  await expectGridReady(page);

  // The grid sorts by name, so row one is Ada Thermal — in the list, and with
  // no id yet. Retyping her name is the path this feature exists for: the
  // organiser knows who they mean, and the id should arrive WITH the name
  // rather than be reconciled afterwards.
  const nameCell = page
    .locator('#pilots-grid .tabulator-row .tabulator-cell[tabulator-field="name"]')
    .first();
  // Tabulator opens its editor on a SINGLE click; a double click reopens it
  // and loses the first keystrokes.
  await nameCell.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Ada", { delay: 60 });

  // The suggestion says who they are, not just what they are called — nation
  // and world rank are what tell two pilots of one name apart.
  const suggestion = page.locator(".tabulator-edit-list-item", { hasText: "Ada Thermal" });
  await expect(suggestion.first()).toBeVisible({ timeout: 20_000 });
  await suggestion.first().click();

  // The row now carries what the list knows: CIVL's spelling, the id, the rank.
  const row = page
    .locator("#pilots-grid .tabulator-row", { hasText: "Ada Thermal" })
    .first();
  await expect(row.locator('[tabulator-field="civl_id"]')).not.toHaveText("");
  await expect(row.locator('[tabulator-field="civl_ranking"]')).not.toHaveText("");
});

test("the roster sorts by ranking, unranked pilots last either way", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/pilots`);
  const rankHeader = page.getByRole("columnheader", { name: "CIVL rank" });
  await expect(rankHeader).toBeVisible({ timeout: 20_000 });

  const names = async (): Promise<string[]> => {
    const cells = await page.getByRole("rowheader").allInnerTexts();
    return cells.map((t) => t.trim());
  };

  // aria-sort is the sync point. Reading the rows straight after the click
  // races the re-render — and the roster's default order is by name, which
  // here happens to equal ranking order, so the race passes silently.
  await rankHeader.click();
  await expect(rankHeader).toHaveAttribute("aria-sort", "ascending");
  const ascending = await names();
  // Ranked pilots first, in ranking order (the seed ranks by name, so Ada
  // outranks Bruno outranks Cleo); everyone unranked is behind them.
  expect(ascending.slice(0, 3)).toEqual(["Ada Thermal", "Bruno Ridge", "Cleo Vario"]);
  expect(ascending.indexOf("Twin Ambiguity")).toBeGreaterThan(2);
  expect(ascending.indexOf("Unranked Nobody")).toBeGreaterThan(2);

  await rankHeader.click();
  await expect(rankHeader).toHaveAttribute("aria-sort", "descending");
  const descending = await names();
  expect(descending.slice(0, 3)).toEqual(["Cleo Vario", "Bruno Ridge", "Ada Thermal"]);
  // Pinned last in BOTH directions: no ranking is not a bad ranking.
  expect(descending.indexOf("Twin Ambiguity")).toBeGreaterThan(2);
  expect(descending.indexOf("Unranked Nobody")).toBeGreaterThan(2);
});

test("the list picker opens ON SCREEN when the page is taller than the window", async ({
  page,
}) => {
  // RAC portals the popover to <body> and positions it with viewport-relative
  // offsets under `position: absolute`; our body is `position: relative` (iOS
  // Safari backdrops), so the containing block is the body BOX. A popover that
  // flips upwards — which this one does, sitting low in a tall dialog — was
  // displaced by exactly `scrollHeight - innerHeight`: open, focusable, every
  // option in the DOM, and thousands of pixels below the fold. See gotcha #22
  // in docs/2026-07-18-rac-adoption-guide.md.
  //
  // A short window is what makes the page taller than the viewport here; on
  // the 64-pilot roster it needed no help at all.
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto(`/comp/${compId}/pilots`);
  await page.getByRole("button", { name: "Edit" }).click();
  await openCivlDialog(page);

  const picker = page.getByRole("button", { name: /Sample World Ranking/ });
  await expect(picker).toBeVisible({ timeout: 20_000 });
  await picker.click();

  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const box = await listbox.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(viewport.height);
  // toBeVisible() alone would NOT have caught this: an off-screen popover is
  // still "visible" to Playwright. The rect is the assertion.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
});

test("a rank typed over by hand stops claiming a source", async ({ page }) => {
  await page.goto(`/comp/${compId}/pilots`);
  await page.getByRole("button", { name: "Edit" }).click();
  await expectGridReady(page);

  // Tabulator edits on a cell click; the ranking column is a plain input.
  const cell = page.locator('.tabulator-row', { hasText: "Ada Thermal" }).first()
    .locator('[tabulator-field="civl_ranking"]');
  await cell.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("99");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20_000 });

  const adaRow = page.getByRole("row", { name: /Ada Thermal/ });
  await expect(adaRow).toContainText("99");
  await expect(adaRow).toContainText("set by organiser");
  await expect(adaRow).not.toContainText("Sample World Ranking");
});
