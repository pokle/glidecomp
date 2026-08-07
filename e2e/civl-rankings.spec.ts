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
 * the two files have to agree. The fixture pilots are in no other list, so
 * their best rank is that list's rank whatever else has been imported.
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
 * Padding: a roster long enough to be a realistic grid, and to keep the
 * "3 of N" count honest about a roster most of which the rankings cannot
 * place. None of these names is in any ranking list.
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

  // Three are placeable: Bruno by his ID, Ada and Cleo by name. Twin
  // Ambiguity (two DIFFERENT ranked humans, one name), Unranked Nobody and
  // every filler are not. The dialog says so before anything is pressed.
  await expect(
    page.getByText(new RegExp(`3 of ${ROSTER.length} pilots are in`))
  ).toBeVisible({ timeout: 20_000 });

  // ONE press. Ids first, then the ranks that only become fillable once the
  // ids are in — the ordering the organiser used to have to know about.
  await page.getByRole("button", { name: "Fill", exact: true }).click();
  // Ada and Cleo gain ids (Bruno already had one, Twin Ambiguity is refused);
  // all three are then ranked BY ID, including the two just filled.
  // The fill dialog closes on its way out, so the outcome lands under the
  // grid rather than behind the dialog that started it.
  await expect(
    page.getByRole("heading", { name: "Fill from CIVL rankings" })
  ).toBeHidden({ timeout: 20_000 });
  await expect(
    page.getByText(/2 CIVL IDs and 3 rankings filled in from Sample World Ranking/)
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
  const brunoRank = (await brunoRow.innerText()).match(/\b(\d+)\b/)?.[1];
  expect(brunoRank).toBeTruthy();

  // Press it again on the same roster. "Add when missing" means exactly that:
  // nothing is rewritten, and the outcome says why rather than leaving
  // "0 rankings filled in" to be read as a failure.
  await page.getByRole("button", { name: "Edit" }).click();
  await openCivlDialog(page);
  await page.getByRole("button", { name: "Fill", exact: true }).click();
  await expect(
    page.getByText(/3 pilots already had a ranking and were left alone/)
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0 CIVL IDs and 0 rankings filled in/)).toBeVisible();

  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("row", { name: /Bruno Ridge/ })).toContainText(
    brunoRank!
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
