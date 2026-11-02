/**
 * The pilots page (/comp/:id/pilots): a list of pilots, each opening a page
 * of its own (/comp/:id/pilots/:pilotId, or /pilots/new), under a sticky
 * search box and + — at every width. It replaced a fourteen-column Tabulator
 * grid in a dialog, which on a phone showed about one and a half columns at a
 * time.
 *
 * Runs in BOTH Playwright projects (fixtures/mobile.ts): the phone is the
 * width the page was designed for, and the desktop must not grow a second
 * shape. What it holds:
 *
 *   - the search finds a pilot by any field, words in any order, accents
 *     ignored; and + carries the searched-for name into a new pilot;
 *   - a pilot is saved the moment Done is pressed (nothing waits for a
 *     page-level Save); Back is the browser's Back, and returns the list
 *     searched, sorted and scrolled as it was left;
 *   - Remove asks before it removes;
 *   - an import shows what it will add, update and remove before it does any
 *     of it, and an exported roster comes back as the same pilots;
 *   - the page never scrolls sideways, its targets are thumb-sized, and the
 *     search bar stays in reach without covering a focused row.
 *
 * Each test builds its own comp through the API (named through e2eCompName so
 * a killed run is swept) and the suite deletes them afterwards.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from "./fixtures/test";
import { e2eCompName } from "./fixtures/stack";

const TEST_USER = {
  name: "E2E Pilots Organiser",
  email: "e2e-comp-pilots@test.local",
};

/** The dev server, honouring the worktree port override (fixtures/stack.ts). */
function baseUrl(): string {
  return process.env.DEV_FRONTEND_PORT
    ? `http://localhost:${process.env.DEV_FRONTEND_PORT}`
    : "http://localhost:3000";
}

/** Enough pilots that the list scrolls on any screen. */
const FILLERS = Array.from({ length: 30 }, (_, i) => ({
  registered_pilot_name: `Filler Pilot ${String(i + 1).padStart(2, "0")}`,
  pilot_class: "open",
}));

const ROSTER = [
  {
    registered_pilot_name: "Tom Smith",
    registered_pilot_civl_id: "12345",
    registered_pilot_glider: "Moyes Litespeed RX",
    pilot_class: "open",
  },
  { registered_pilot_name: "Ana Müller", pilot_class: "sport" },
  {
    registered_pilot_name: "Jo Ridge",
    registered_pilot_email: "jo@example.com",
    pilot_class: "open",
    team_name: "Alpha",
  },
  ...FILLERS,
];

const created: string[] = [];
let api: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: baseUrl() });
  const login = await api.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);
});

test.afterAll(async () => {
  for (const id of created) await api.delete(`/api/comp/${id}`);
  await api.dispose();
});

/** A comp of our own, holding `roster`. */
async function makeComp(roster: object[] = ROSTER): Promise<string> {
  const res = await api.post("/api/comp", {
    data: { name: e2eCompName("Pilots page"), category: "hg", pilot_classes: ["open", "sport"] },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const compId = ((await res.json()) as { comp_id: string }).comp_id;
  created.push(compId);
  const bulk = await api.post(`/api/comp/${compId}/pilot/bulk`, {
    data: { pilots: roster, remove: [] },
  });
  expect(bulk.ok(), await bulk.text()).toBe(true);
  return compId;
}

interface Pilot {
  comp_pilot_id: string;
  name: string;
  team_name: string | null;
  driver_contact: string | null;
  pilot_class: string;
}

async function rosterOf(compId: string): Promise<Pilot[]> {
  const res = await api.get(`/api/comp/${compId}/pilot`);
  return ((await res.json()) as { pilots: Pilot[] }).pilots;
}

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

const list = (page: Page) => page.getByRole("grid", { name: "Pilots" });
const rows = (page: Page) => list(page).getByRole("row");
const search = (page: Page) => page.getByRole("searchbox", { name: "Find a pilot" });

/** A pilot's own page, once its heading says whose it is. */
async function editorFor(page: Page, heading: string): Promise<Locator> {
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible({
    timeout: 20_000,
  });
  return page.getByRole("main");
}

/**
 * A field in the middle of the screen, as a person taps one. React Aria
 * closes a combo box's list whenever the page scrolls, and a Playwright click
 * on an option below the fold scrolls the page to reach it.
 */
async function centre(field: Locator): Promise<void> {
  await field.evaluate((el) => el.scrollIntoView({ block: "center" }));
}

/**
 * Tap a combo box and wait for its list to SHOW. On a touch device React Aria
 * holds the list invisible until the on-screen keyboard has opened (600 ms at
 * most); headless Chromium never opens one, so a click in that window lands
 * on an invisible option.
 */
async function openList(page: Page, field: Locator): Promise<void> {
  await centre(field);
  await field.click();
  await expect(page.locator('[data-trigger="ComboBox"]')).toHaveCSS("opacity", "1");
}

/** Back on the list, after a Done, a Remove or a Back. */
async function backOnList(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/pilots(\?|$)/, { timeout: 20_000 });
  await expect(list(page)).toBeVisible();
}

async function openPage(page: Page, compId: string): Promise<void> {
  await page.goto(`/comp/${compId}/pilots`);
  await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
}

/** The visible names, top to bottom. */
async function names(page: Page): Promise<string[]> {
  const texts = await rows(page).locator("p.font-medium").allInnerTexts();
  return texts.map((t) => t.trim());
}

/** See comp-waypoints.spec.ts: asserted, because it is what the grid failed. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(scrolls, "the page must not scroll sideways").toBe(false);
}

/** A target a thumb can hit, measured on the rendered box (44px). */
async function expectThumbSized(page: Page, name: string, box: { width: number; height: number } | null) {
  expect(box, `${name} must be on screen`).not.toBeNull();
  expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
}

test("search finds a pilot by any field, in any order, accents ignored", async ({ page }) => {
  const compId = await makeComp();
  await openPage(page, compId);

  await search(page).fill("smi tom");
  await expect.poll(() => names(page)).toEqual(["Tom Smith"]);
  await expect(page.getByRole("status").filter({ hasText: "of" })).toHaveText(
    `1 of ${ROSTER.length} pilots`
  );

  await search(page).fill("muller");
  await expect.poll(() => names(page)).toEqual(["Ana Müller"]);

  // A CIVL number off a licence, a glider, a class.
  await search(page).fill("12345");
  await expect.poll(() => names(page)).toEqual(["Tom Smith"]);
  await search(page).fill("litespeed");
  await expect.poll(() => names(page)).toEqual(["Tom Smith"]);
  await search(page).fill("sport");
  await expect.poll(() => names(page)).toEqual(["Ana Müller"]);

  await search(page).fill("");
  await expect.poll(async () => (await names(page)).length).toBe(ROSTER.length);
});

test("+ after a search that finds nobody adds a pilot with that name", async ({ page }) => {
  const compId = await makeComp();
  await openPage(page, compId);

  await search(page).fill("Zara New");
  await expect(list(page)).toContainText('No pilot matches "Zara New".');

  await page.getByRole("button", { name: "Add a pilot named Zara New" }).click();
  await expect(page).toHaveURL(/\/pilots\/new\?name=Zara/);
  const sheet = await editorFor(page, "Zara New");
  await expect(sheet.getByRole("textbox", { name: "Name" })).toHaveValue("Zara New");
  // The option's TEXT, not the radio: the kit hides the input under its
  // label (rac gotcha #13, as task-settings-pages.spec.ts does).
  await sheet.getByText("sport", { exact: true }).click();
  await expect(sheet.getByRole("radio", { name: "sport" })).toBeChecked();
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);

  // Saved on Done: there is no page-level Save to press. The list is back
  // where it was left, searching for the name it was given.
  await expect(search(page)).toHaveValue("Zara New");
  await expect.poll(() => names(page)).toEqual(["Zara New"]);
  // And the section nav's count follows the list, rather than keeping the
  // number the page loaded with. At a phone's width the nav folds "Pilots"
  // into its More menu, so look there when it is not on the bar.
  const counted = `Pilots (${ROSTER.length + 1})`;
  if ((await page.getByRole("link", { name: counted }).count()) === 0) {
    await page.getByRole("button", { name: "More sections" }).click();
    await expect(page.getByRole("menuitem", { name: counted })).toBeVisible();
    await page.keyboard.press("Escape");
  } else {
    await expect(page.getByRole("link", { name: counted }).first()).toBeAttached();
  }
  const saved = (await rosterOf(compId)).find((p) => p.name === "Zara New");
  expect(saved?.pilot_class).toBe("sport");
});

test("a pilot is saved on Done, and Back is the browser's Back", async ({ page }) => {
  const compId = await makeComp();
  await openPage(page, compId);
  await search(page).fill("jo ridge");
  await rows(page).first().click();

  // The pilot has a page and an address of its own.
  await expect(page).toHaveURL(/\/pilots\/jo-ridge-[a-z]+$/);
  let sheet = await editorFor(page, "Jo Ridge");
  await sheet.getByRole("textbox", { name: "Driver" }).fill("Sam 0400 111 222");
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);
  const saved = () => rosterOf(compId).then((r) => r.find((p) => p.name === "Jo Ridge"));
  expect((await saved())?.driver_contact).toBe("Sam 0400 111 222");
  // Done went BACK to the list, so the list is as it was left.
  await expect(search(page)).toHaveValue("jo ridge");

  // Back leaves without saving and without asking, as on any page — and
  // Forward comes back to the pilot.
  await rows(page).first().click();
  sheet = await editorFor(page, "Jo Ridge");
  await sheet.getByRole("textbox", { name: "Driver" }).fill("Kim 0400 999 999");
  await page.goBack();
  await backOnList(page);
  expect((await saved())?.driver_contact).toBe("Sam 0400 111 222");
  await page.goForward();
  await editorFor(page, "Jo Ridge");

  // A link away with unsaved edits does ask: "Pilots" in the trail.
  await page.getByRole("main").getByRole("textbox", { name: "Driver" }).fill("Lee");
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Pilots", exact: true }).click();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("Discard changes?");
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByRole("main").getByRole("textbox", { name: "Driver" })).toHaveValue("Lee");

  // And the page stands on its own: reloaded, it is still Jo Ridge's.
  await page.reload();
  await editorFor(page, "Jo Ridge");
});

test("the Team field offers the roster's teams, and a new team is a deliberate choice", async ({
  page,
}) => {
  // Teams are scored by their exact name, so a typo published a second team.
  const compId = await makeComp([
    { registered_pilot_name: "Ada", pilot_class: "open", team_name: "Alpha Gliders" },
    { registered_pilot_name: "Bo", pilot_class: "open", team_name: "Alpha Gliders" },
    { registered_pilot_name: "Cy", pilot_class: "open", team_name: "Bravo" },
    { registered_pilot_name: "Di", pilot_class: "open" },
    { registered_pilot_name: "Ed", pilot_class: "open" },
    { registered_pilot_name: "Fay", pilot_class: "open" },
  ]);
  await openPage(page, compId);
  const teamOf = async (name: string) =>
    (await rosterOf(compId)).find((p) => p.name === name)?.team_name;
  const open = async (name: string) => {
    await search(page).fill(name);
    await rows(page).first().click();
    return editorFor(page, name);
  };
  // A tap on a field already in view, as a person makes one. React Aria
  // closes an open list whenever its field's container scrolls, and a
  // Playwright click that scrolls the field into view does so a frame AFTER
  // the focus that opened it.
  const tapTeam = async (sheet: Locator) => {
    const team = sheet.getByRole("combobox", { name: "Team" });
    await openList(page, team);
    return team;
  };

  // The teams there are, with their pilots: pick one.
  let sheet = await open("Di");
  let team = await tapTeam(sheet);
  await expect(page.getByRole("option", { name: "Alpha Gliders (2)" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Bravo (1)" })).toBeVisible();
  await page.getByRole("option", { name: "Alpha Gliders (2)" }).click();
  await expect(team).toHaveValue("Alpha Gliders");
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);
  expect(await teamOf("Di")).toBe("Alpha Gliders");

  // A slip is caught: Done will not make a new team of it unasked, and
  // "Did you mean" puts it right.
  sheet = await open("Ed");
  team = await tapTeam(sheet);
  await team.fill("Alpha Gilders");
  await expect(page.getByRole("option", { name: "Did you mean Alpha Gliders?" })).toBeVisible();
  await expect(page.getByRole("option", { name: "New team: Alpha Gilders" })).toBeVisible();
  await page.keyboard.press("Escape");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toContainText("Choose a team from the list, or New team: Alpha Gilders.");
  await expect(team).toBeFocused();
  // Centring the field closed the list its focus opened; a tap brings it
  // back without retyping.
  await openList(page, team);
  await page.getByRole("option", { name: "Did you mean Alpha Gliders?" }).click();
  await expect(team).toHaveValue("Alpha Gliders");
  await expect(sheet).not.toContainText("Choose a team from the list");
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);
  expect(await teamOf("Ed")).toBe("Alpha Gliders");

  // A new team takes one deliberate tap; the same name in other capitals
  // needs none, and lands under the roster's spelling.
  sheet = await open("Fay");
  team = await tapTeam(sheet);
  await team.fill("Thermal Hunters");
  await page.getByRole("option", { name: "New team: Thermal Hunters" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);
  expect(await teamOf("Fay")).toBe("Thermal Hunters");

  sheet = await open("Cy");
  team = await tapTeam(sheet);
  await team.fill("alpha  GLIDERS");
  await page.keyboard.press("Escape");
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);
  expect(await teamOf("Cy")).toBe("Alpha Gliders");
});

test("Sort: Team files the pilots under their teams, the teamless last", async ({ page }) => {
  const sortTo = async (option: string) => {
    await page.getByRole("button", { name: /Sort/ }).click();
    await page.getByRole("option", { name: option }).click();
  };
  const headings = () => list(page).getByRole("rowheader").allInnerTexts();

  // A roster with no teams is not offered a sort that would file everyone
  // under "No team".
  const teamless = await makeComp([
    { registered_pilot_name: "Ann", pilot_class: "open" },
    { registered_pilot_name: "Ben", pilot_class: "open" },
  ]);
  await openPage(page, teamless);
  await page.getByRole("button", { name: /Sort/ }).click();
  await expect(page.getByRole("option", { name: "Name" })).toBeVisible();
  await expect(page.getByRole("option", { name: "Team" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const compId = await makeComp([
    { registered_pilot_name: "Zoe", pilot_class: "open", team_name: "Bravo" },
    { registered_pilot_name: "Ada", pilot_class: "open" },
    { registered_pilot_name: "Cy", pilot_class: "open", team_name: "Alpha Gliders" },
    { registered_pilot_name: "Bo", pilot_class: "open", team_name: "Alpha Gliders" },
  ]);
  await openPage(page, compId);
  await sortTo("Team");

  // Teams in name order, pilots by name inside each, and every heading names
  // the group a screen reader announces.
  await expect.poll(headings).toEqual(["Alpha Gliders · 2 pilots", "Bravo · 1 pilot", "No team · 1 pilot"]);
  await expect.poll(() => names(page)).toEqual(["Bo", "Cy", "Zoe", "Ada"]);
  await expect(
    list(page).getByRole("rowgroup", { name: "Alpha Gliders · 2 pilots" }).getByRole("row")
  ).toHaveText([/Alpha Gliders/, /^Bo/, /^Cy/]);

  // A search narrows the rows and drops an empty team; a heading still says
  // how big its team is.
  await search(page).fill("cy");
  await expect.poll(headings).toEqual(["Alpha Gliders · 2 pilots"]);
  await expect.poll(() => names(page)).toEqual(["Cy"]);
  await search(page).fill("");

  // The rows are the same rows: one opens its page, and a pilot who joins a
  // team moves under it — with the list still sorted by team on the way back.
  await rows(page).filter({ hasText: "Ada" }).click();
  const sheet = await editorFor(page, "Ada");
  const team = sheet.getByRole("combobox", { name: "Team" });
  await openList(page, team);
  await page.getByRole("option", { name: "Bravo (1)" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);
  await expect.poll(headings).toEqual(["Alpha Gliders · 2 pilots", "Bravo · 2 pilots"]);
  await expect.poll(() => names(page)).toEqual(["Bo", "Cy", "Ada", "Zoe"]);
});

test("Back from a pilot returns the list scrolled, searched and sorted as it was left", async ({
  page,
}) => {
  // The list's state is the URL's (and the scroll is the router's), so the
  // browser's own Back restores it — nothing hands it across in memory.
  const compId = await makeComp();
  await openPage(page, compId);
  await page.getByRole("button", { name: /Sort/ }).click();
  await page.getByRole("option", { name: "WPRS points" }).click();
  await search(page).fill("filler");
  await expect(page).toHaveURL(/q=filler/);
  await expect(page).toHaveURL(/sort=wprs_points/);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(100);

  await rows(page).last().click();
  await editorFor(page, "Filler Pilot 30");
  await page.goBack();
  await backOnList(page);
  await expect(search(page)).toHaveValue("filler");
  await expect(page.getByRole("button", { name: /Sort/ })).toContainText("WPRS points");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolled - 5);
});

test("a refusal lands under the field it is about, focused and in view", async ({ page }) => {
  // The bug, found on an iPhone: an email that already belonged to someone on
  // the roster was refused, the refusal went to the top of a body scrolled
  // past it, and Done looked broken. The test organiser is a pilot too, on
  // this roster by their email.
  const profile = await api.patch("/api/comp/pilot", { data: { name: TEST_USER.name } });
  expect(profile.ok(), await profile.text()).toBe(true);
  const compId = await makeComp([
    { registered_pilot_name: "Org Self", registered_pilot_email: TEST_USER.email, pilot_class: "open" },
    ...FILLERS.slice(0, 3),
  ]);
  await openPage(page, compId);

  await page.getByRole("button", { name: "Add pilot" }).click();
  const sheet = await editorFor(page, "New pilot");
  await sheet.getByRole("textbox", { name: "Name" }).fill("Moosh");
  await sheet.getByText("open", { exact: true }).click();
  const email = sheet.getByRole("textbox", { name: "Email" });
  await email.fill(TEST_USER.email);
  // Scrolled down past the email, the way the organiser was.
  await sheet.getByRole("textbox", { name: "FAI ID" }).scrollIntoViewIfNeeded();
  await sheet.getByRole("button", { name: "Done" }).click();

  await expect(sheet).toContainText("Org Self is already registered with this email.");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toBeFocused();
  await expect(email).toBeInViewport();

  // Editing the field clears its error, and the corrected pilot saves.
  await email.fill("moosh@example.com");
  await expect(email).toHaveValue("moosh@example.com");
  await expect(sheet).not.toContainText("already registered");
  await sheet.getByRole("button", { name: "Done" }).click();
  await backOnList(page);
  expect((await rosterOf(compId)).some((p) => p.name === "Moosh")).toBe(true);
});

test("Remove asks before it removes", async ({ page }) => {
  const compId = await makeComp();
  await openPage(page, compId);
  await search(page).fill("ana");
  await rows(page).first().click();

  const sheet = await editorFor(page, "Ana Müller");
  await sheet.getByRole("button", { name: "Remove this pilot" }).click();
  const ask = page.getByRole("alertdialog");
  await expect(ask).toContainText("Remove Ana Müller?");
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect((await rosterOf(compId)).some((p) => p.name === "Ana Müller")).toBe(true);

  await sheet.getByRole("button", { name: "Remove this pilot" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await backOnList(page);
  await expect(list(page)).toContainText('No pilot matches "ana".');
  expect((await rosterOf(compId)).some((p) => p.name === "Ana Müller")).toBe(false);
});

test("an import says what it will add, update and remove before it does any of it", async ({
  page,
}) => {
  const compId = await makeComp(ROSTER.slice(0, 3));
  await openPage(page, compId);

  const importFile = async (csv: string) => {
    await page.getByRole("button", { name: "Roster actions" }).click();
    await page.getByRole("menuitem", { name: "Import CSV…" }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("dialog").getByRole("button", { name: "Choose file" }).click();
    await (await chooser).setFiles({
      name: "roster.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
  };

  // Tom matched by his CIVL ID and moved to Sport; a new pilot; Ana and Jo
  // are not in the file, so the file would remove them.
  await importFile(["name,class,civl_id", "Tom Smith,sport,12345", "Dee New,open,"].join("\n"));
  const review = page.getByRole("dialog", { name: "Import roster.csv" });
  await expect(review).toContainText("1 updated · 1 new · 2 removed");
  await expect(review).toContainText("Ana Müller");
  await expect(review).toContainText("Jo Ridge");

  // Cancel writes nothing.
  await review.getByRole("button", { name: "Cancel" }).click();
  await expect(review).toBeHidden();
  expect((await rosterOf(compId)).map((p) => p.name).sort()).toEqual(
    ["Ana Müller", "Jo Ridge", "Tom Smith"]
  );

  // Apply writes exactly what the review said.
  await importFile(["name,class,civl_id", "Tom Smith,sport,12345", "Dee New,open,"].join("\n"));
  await review.getByRole("button", { name: "Apply" }).click();
  await expect(review).toBeHidden({ timeout: 20_000 });
  const after = await rosterOf(compId);
  expect(after.map((p) => p.name).sort()).toEqual(["Dee New", "Tom Smith"]);
  expect(after.find((p) => p.name === "Tom Smith")?.pilot_class).toBe("sport");
});

test("an exported roster re-imports as the same pilots", async ({ page }) => {
  // Ana has no ID and no email — the kind of pilot open registration makes —
  // so only the export's glidecomp_id column can bring her back as herself.
  const compId = await makeComp(ROSTER.slice(0, 3));
  await openPage(page, compId);

  await page.getByRole("button", { name: "Roster actions" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export CSV" }).click();
  const csv = await (await (await download).createReadStream()).toArray();

  await page.getByRole("button", { name: "Roster actions" }).click();
  await page.getByRole("menuitem", { name: "Import CSV…" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("dialog").getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles({
    name: "exported.csv",
    mimeType: "text/csv",
    buffer: Buffer.concat(csv),
  });

  const review = page.getByRole("dialog", { name: "Import exported.csv" });
  await expect(review).toContainText("0 updated · 0 new · 0 removed");
  await expect(review.getByRole("button", { name: "Apply" })).toHaveCount(0);
});

test("the page never scrolls sideways, its targets are thumb-sized, and the search bar stays in reach", async ({
  page,
}) => {
  const compId = await makeComp();
  await openPage(page, compId);
  await expectNoSidewaysScroll(page);

  await expectThumbSized(page, "the + button", await page.getByRole("button", { name: "Add pilot" }).boundingBox());
  const searchBox = await page.getByRole("group").filter({ has: search(page) }).first().boundingBox();
  expect(searchBox!.height, "the search box height").toBeGreaterThanOrEqual(44);
  await expectThumbSized(page, "a pilot row", await rows(page).first().boundingBox());

  // Scrolled to the end of the list, search and + are still on screen, at the
  // top: sticky in the page's flow, never fixed to the screen.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const plus = await page.getByRole("button", { name: "Add pilot" }).boundingBox();
  expect(plus!.y, "the + stays on screen").toBeGreaterThanOrEqual(0);
  expect(plus!.y, "the + stays near the top").toBeLessThan(200);
  // ... and wholly below the comp's section tabs, which stick too.
  const tabs = await page.getByRole("navigation", { name: "Sections" }).boundingBox();
  const scrolledSearch = await page.getByRole("group").filter({ has: search(page) }).first().boundingBox();
  expect(scrolledSearch!.y, "the search box clears the section tabs").toBeGreaterThanOrEqual(tabs!.y + tabs!.height);
  expect(
    await page.getByRole("button", { name: "Add pilot" }).evaluate((el) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return true;
      }
      return false;
    }),
    "nothing on this page is fixed to the screen"
  ).toBe(false);

  // A row reached from the keyboard is never left under the sticky bar (WCAG
  // 2.4.11): walk focus back up the list from the bottom.
  await rows(page).last().focus();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("PageUp");
    const top = await page.evaluate(() => document.activeElement!.getBoundingClientRect().top);
    const bar = await page.getByRole("button", { name: "Add pilot" }).boundingBox();
    expect(top, "the focused row starts below the search bar").toBeGreaterThanOrEqual(bar!.y + bar!.height);
    const tabsNow = await page.getByRole("navigation", { name: "Sections" }).boundingBox();
    expect(top, "the focused row starts below the section tabs").toBeGreaterThanOrEqual(tabsNow!.y + tabsNow!.height);
  }

  // A pilot's page does not scroll sideways either.
  await rows(page).first().click();
  const editor = await editorFor(page, (await rosterOf(compId)).map((p) => p.name).sort((a, b) => a.localeCompare(b))[0]);
  await expectNoSidewaysScroll(page);

  // Its fields come in named groups, and none of them folds away.
  for (const group of ["Required", "In the air", "Contact", "CIVL", "Team", "Other IDs"]) {
    await expect(editor.getByRole("group", { name: group })).toBeAttached();
  }
  await expect(
    editor.getByRole("group", { name: "Other IDs" }).getByRole("textbox", { name: "FAI ID" })
  ).toBeAttached();
  await expect(editor.getByRole("button", { name: "Other IDs" })).toHaveCount(0);

  // Its fields stand out from the page behind them. They were transparent,
  // which on the grey page background made an input the same grey as the
  // page — hard to find on a phone in daylight.
  const [fieldBg, pageBg] = await editor
    .getByRole("textbox", { name: "Name" })
    .evaluate((el) => [
      getComputedStyle(el).backgroundColor,
      getComputedStyle(document.body).backgroundColor,
    ]);
  expect(fieldBg, "an input must not be the page's own colour").not.toBe(pageBg);
});
