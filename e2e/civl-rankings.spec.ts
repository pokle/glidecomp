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
const ROSTER = [
  { registered_pilot_name: "Bruno Ridge", registered_pilot_civl_id: "9000002" },
  { registered_pilot_name: "Ada Thermal" },
  { registered_pilot_name: "Cleo Vario" },
  { registered_pilot_name: "Twin Ambiguity" },
  { registered_pilot_name: "Unranked Nobody" },
];

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

test("fills IDs by name, then rankings by ID, and shows where they came from", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/pilots`);
  await page.getByRole("button", { name: "Edit" }).click();

  // The picker only appears once the lookup has answered — and it answers
  // about the grid, so it doubles as "the grid is loaded".
  const picker = page.getByRole("button", { name: /Sample World Ranking/ });
  await expect(picker).toBeVisible({ timeout: 20_000 });
  // Four of the five are placeable: Bruno by his ID, Ada and Cleo by name.
  // Twin Ambiguity and Unranked Nobody are not.
  await expect(picker).toHaveText(/3 of 5 pilots/);

  await page.getByRole("button", { name: "Fill CIVL IDs" }).click();
  await expect(page.getByText(/CIVL IDs? filled in from Sample World Ranking/)).toBeVisible();
  // Ada and Cleo only — Bruno already had one, and Twin Ambiguity is refused.
  await expect(page.getByText(/^2 CIVL IDs filled in/)).toBeVisible();

  await page.getByRole("button", { name: "Fill rankings" }).click();
  await expect(page.getByText(/^3 rankings filled in/)).toBeVisible();

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
  // outranks Bruno outranks Cleo); the two unrankable ones bring up the rear.
  expect(ascending.slice(0, 3)).toEqual(["Ada Thermal", "Bruno Ridge", "Cleo Vario"]);
  expect(ascending.slice(3).sort()).toEqual(["Twin Ambiguity", "Unranked Nobody"]);

  await rankHeader.click();
  await expect(rankHeader).toHaveAttribute("aria-sort", "descending");
  const descending = await names();
  expect(descending.slice(0, 3)).toEqual(["Cleo Vario", "Bruno Ridge", "Ada Thermal"]);
  // Pinned last in BOTH directions: no ranking is not a bad ranking.
  expect(descending.slice(3).sort()).toEqual(["Twin Ambiguity", "Unranked Nobody"]);
});

test("a rank typed over by hand stops claiming a source", async ({ page }) => {
  await page.goto(`/comp/${compId}/pilots`);
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: /Sample World Ranking/ })).toBeVisible({
    timeout: 20_000,
  });

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
