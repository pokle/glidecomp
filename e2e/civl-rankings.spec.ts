/**
 * CIVL world rankings on the pilot roster (/comp/:id/pilots).
 *
 * The organiser's workflow, end to end: open the pilots page, ask the
 * rankings what they can fill — CIVL IDs by exact name, then each pilot's WPRS
 * score by ID — see exactly what that will set, fill it, and sort the roster
 * by points to build a launch order.
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
 * Padding: a roster long enough to be a realistic list, and to keep the
 * "3 of N" count honest about a roster most of which the rankings cannot
 * place. None of these names is in any ranking list.
 */
const FILLER_ROSTER = Array.from({ length: 30 }, (_, i) => ({
  registered_pilot_name: `Filler Pilot ${String(i + 1).padStart(2, "0")}`,
}));

const ROSTER = [...MATCHING_ROSTER, ...FILLER_ROSTER];

let compId: string;

/** The dev server, honouring the worktree port override (fixtures/stack.ts). */
function baseUrl(): string {
  return process.env.DEV_FRONTEND_PORT
    ? `http://localhost:${process.env.DEV_FRONTEND_PORT}`
    : "http://localhost:3000";
}

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

  const api = await playwright.request.newContext({ baseURL: baseUrl() });
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
      remove: [],
    },
  });
  expect(roster.ok(), await roster.text()).toBe(true);
  await api.dispose();
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  await api.post("/api/auth/dev-login", { data: TEST_USER });
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

const rows = (page: Page) => page.getByRole("grid", { name: "Pilots" }).getByRole("row");
const rowOf = (page: Page, name: string) => rows(page).filter({ hasText: name }).first();
const fillHeading = (page: Page) =>
  page.getByRole("heading", { name: "Fill from CIVL rankings" });

async function openRoster(page: Page, id: string): Promise<void> {
  await page.goto(`/comp/${id}/pilots`);
  await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
}

/** Open the fill's sheet from the page's ⋯ menu. */
async function openFill(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Roster actions" }).click();
  await page.getByRole("menuitem", { name: "Fill from CIVL…" }).click();
  await expect(fillHeading(page)).toBeVisible({ timeout: 20_000 });
}

/** The visible names, top to bottom. */
async function names(page: Page): Promise<string[]> {
  return (await rows(page).locator("p.font-medium").allInnerTexts()).map((t) => t.trim());
}

/** A pilot's own page (it was a sheet over the roster until 2026-11). */
async function pilotPage(page: Page, name: string) {
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 20_000 });
  return page.getByRole("main");
}

test("one press fills IDs by name and then rankings by ID, and shows what it will set first", async ({
  page,
}) => {
  await openRoster(page, compId);
  await openFill(page);

  // Three are placeable: Bruno by his ID, Ada and Cleo by name. Twin
  // Ambiguity (two DIFFERENT ranked humans, one name), Unranked Nobody and
  // every filler are not. The sheet says so before anything is pressed, and
  // lists what Fill will set — nothing has been written yet.
  await expect(
    page.getByText(new RegExp(`3 of ${ROSTER.length} pilots have one`))
  ).toBeVisible({ timeout: 20_000 });
  const preview = page.getByRole("list", { name: "What Fill will set" });
  for (const name of ["Ada Thermal", "Bruno Ridge", "Cleo Vario"]) {
    await expect(preview).toContainText(name);
  }
  await expect(preview).not.toContainText("Twin Ambiguity");
  await expect(preview).toContainText("Sample World Ranking");

  // ONE press. Ids first, then the ranks that only become fillable once the
  // ids are in — the ordering the organiser used to have to know about.
  await page.getByRole("button", { name: "Fill", exact: true }).click();
  await expect(fillHeading(page)).toBeHidden({ timeout: 20_000 });
  // Ada and Cleo gain ids (Bruno already had one, Twin Ambiguity is refused);
  // all three are then ranked BY ID, including the two just filled.
  await expect(page.getByText(/2 CIVL IDs and 3 WPRS scores filled in/)).toBeVisible({
    timeout: 20_000,
  });

  // The roster now carries the numbers, and each pilot's page says which
  // list and month theirs came from — the difference between a checkable rank
  // and a bare one.
  await expect(rowOf(page, "Bruno Ridge")).toContainText("pts");
  await expect(rowOf(page, "Twin Ambiguity")).not.toContainText("pts");
  await rowOf(page, "Bruno Ridge").click();
  const sheet = await pilotPage(page, "Bruno Ridge");
  await expect(sheet).toContainText("From Sample World Ranking");
  const points = await sheet.getByRole("textbox", { name: "World Pilot Ranking Scheme points" }).inputValue();
  expect(points).toMatch(/^\d+(\.\d+)?$/);
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/\/pilots(\?|$)/);

  // Ask again on the same roster. "Add when missing" means exactly that:
  // there is nothing left to set, and the sheet says why rather than
  // offering a Fill that would do nothing.
  await openFill(page);
  await expect(page.getByText(/3 already had a score and were left alone/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Fill", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(fillHeading(page)).toBeHidden();
  await expect(rowOf(page, "Bruno Ridge")).toContainText(`${points} pts`);
});

test("the roster sorts by WPRS points, highest first, unscored pilots last", async ({
  page,
}) => {
  await openRoster(page, compId);

  await page.getByRole("button", { name: /Sort/ }).click();
  await page.getByRole("option", { name: "WPRS points" }).click();

  // The fixture ranks by name, so Ada scores MOST and Cleo least — the order
  // the rankings are read in. No score is not a bad score: the unranked come
  // after everyone who has one.
  await expect.poll(async () => (await names(page)).slice(0, 3)).toEqual([
    "Ada Thermal",
    "Bruno Ridge",
    "Cleo Vario",
  ]);
  const sorted = await names(page);
  expect(sorted.indexOf("Twin Ambiguity")).toBeGreaterThan(2);
  expect(sorted.indexOf("Unranked Nobody")).toBeGreaterThan(2);
});

test("a score typed over by hand stops claiming a source", async ({ page }) => {
  await openRoster(page, compId);
  await rowOf(page, "Ada Thermal").click();
  let sheet = await pilotPage(page, "Ada Thermal");
  await expect(sheet).toContainText("From Sample World Ranking");

  await sheet.getByRole("textbox", { name: "World Pilot Ranking Scheme points" }).fill("99");
  // The moment it is typed, not at save: the number is the organiser's now.
  await expect(sheet).toContainText("Set by an organiser");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page).toHaveURL(/\/pilots(\?|$)/, { timeout: 20_000 });
  await expect(rowOf(page, "Ada Thermal")).toContainText("99 pts");

  await rowOf(page, "Ada Thermal").click();
  sheet = await pilotPage(page, "Ada Thermal");
  await expect(sheet).toContainText("Set by an organiser");
  await expect(sheet).not.toContainText("Sample World Ranking");
});

test("the fill asks about the roster as it is NOW", async ({ page, playwright }) => {
  // The bug this guards: the rankings were asked about the roster once and
  // the answer reused. The matches are keyed by ROW INDEX, so after a pilot
  // is removed every index below shifts, and a stale answer applies one
  // pilot's ID to a DIFFERENT pilot's row. Silent, and wrong in the roster.
  //
  // Its own comp, with its own ID-less roster: the shared one has ids saved
  // into it by the first test, and an already-identified roster has no name
  // matches left for a shifted index to misplace.
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  await api.post("/api/auth/dev-login", { data: TEST_USER });
  const created = await api.post("/api/comp", {
    data: { name: e2eCompName("CIVL Stale"), category: "hg", pilot_classes: ["open"] },
  });
  const staleCompId = ((await created.json()) as { comp_id: string }).comp_id;
  try {
    await api.post(`/api/comp/${staleCompId}/pilot/bulk`, {
      data: {
        pilots: ["Ada Thermal", "Bruno Ridge", "Cleo Vario", "Zulu Nobody"].map(
          (registered_pilot_name) => ({ registered_pilot_name, pilot_class: "open" })
        ),
        remove: [],
      },
    });

    await openRoster(page, staleCompId);
    // Look first, so any answer cached from here on is about four pilots.
    await openFill(page);
    await expect(page.getByText(/3 of 4 pilots have one/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Cancel" }).click();

    // Ada sorts first, so her name match sat at index 0. Removing her shifts
    // Bruno into that index.
    await rowOf(page, "Ada Thermal").click();
    await page.getByRole("button", { name: "Remove this pilot" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(rowOf(page, "Ada Thermal")).toHaveCount(0, { timeout: 20_000 });

    await openFill(page);
    await page.getByRole("button", { name: "Fill", exact: true }).click();
    await expect(fillHeading(page)).toBeHidden({ timeout: 20_000 });

    // Bruno gets Bruno's id. Against a stale answer he was handed Ada's
    // (9000001) — a real pilot, a plausible-looking roster, the wrong human.
    const roster = await api.get(`/api/comp/${staleCompId}/pilot`);
    const byName = Object.fromEntries(
      ((await roster.json()) as { pilots: Array<{ name: string; civl_id: string | null }> }).pilots.map(
        (p) => [p.name, p.civl_id]
      )
    );
    expect(byName["Bruno Ridge"]).toBe("9000002");
    expect(byName["Cleo Vario"]).toBe("9000003");
    // Nobody in any list: still empty, not handed the leftovers.
    expect(byName["Zulu Nobody"]).toBeNull();
  } finally {
    await api.delete(`/api/comp/${staleCompId}`);
    await api.dispose();
  }
});
