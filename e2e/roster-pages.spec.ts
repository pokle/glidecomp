/**
 * The roster's CSV import and CIVL fill — pages under the pilots list
 * (/comp/:id/pilots/import, /comp/:id/pilots/civl-fill), where they were
 * full-screen sheets over it until #810. Part of the "No full-screen
 * overlays" rule in CLAUDE.md: a screen of its own is a page, with its own
 * URL, left with the browser's Back.
 *
 * What this spec pins:
 * - each is reached from the ⋯ menu as a page of its own (no dialog), and
 *   Back returns to the list as it was left (its search in the URL);
 * - the CSV chosen for import is a DRAFT (lib/draft-store.ts, docs/drafts.md)
 *   that survives a reload, and Back then Forward;
 * - with no draft to read — a link opened in a fresh tab, a draft from an
 *   older shape — the import page asks for the file again, with no error;
 * - the CIVL fill asks again on a reload, needing nothing from the list.
 *
 * What the import and the fill DO is comp-pilots.spec.ts's and
 * civl-rankings.spec.ts's. This one runs in the `mobile` project too
 * (e2e/fixtures/mobile.ts): a phone is where the sheets went wrong.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { e2eCompName, FRONTEND_URL } from "./fixtures/stack";

const TEST_USER = { name: "E2E Roster Pages", email: "e2e-roster-pages@test.local" };

const ROSTER = [
  { registered_pilot_name: "Tom Smith", registered_pilot_civl_id: "12345", pilot_class: "open" },
  { registered_pilot_name: "Ana Müller", pilot_class: "open" },
  { registered_pilot_name: "Jo Ridge", pilot_class: "open" },
];
const CSV = ["name,class,civl_id", "Tom Smith,open,12345", "Dee New,open,"].join("\n");

let api: APIRequestContext;
let compId: string;

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const login = await api.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);
  const res = await api.post("/api/comp", {
    data: { name: e2eCompName("Roster pages"), category: "hg", pilot_classes: ["open"] },
  });
  expect(res.ok(), await res.text()).toBe(true);
  compId = ((await res.json()) as { comp_id: string }).comp_id;
  const bulk = await api.post(`/api/comp/${compId}/pilot/bulk`, {
    data: { pilots: ROSTER, remove: [] },
  });
  expect(bulk.ok(), await bulk.text()).toBe(true);
});

test.afterAll(async () => {
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  const login = await page.request.post("/api/auth/dev-login", { data: TEST_USER });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
});

/**
 * The address bar, by id: the page may settle on its slugged URL. A new comp
 * starts hidden, so its share key rides after the id (lib/slug.ts compUrlId)
 * — onto these pages and back off them, as on every page of a hidden comp.
 */
const pageUrl = (tail: string) =>
  new RegExp(`/comp/[^/?]*${compId}_[a-z0-9]+/pilots${tail}`);
const h1 = (page: Page, name: string) => page.getByRole("heading", { level: 1, name });
const search = (page: Page) => page.getByRole("searchbox", { name: "Find a pilot" });

/** The list, searched, so Back can be seen to return it as it was left. */
async function openListSearched(page: Page): Promise<void> {
  await page.goto(`/comp/${compId}/pilots`);
  await expect(page.getByRole("grid", { name: "Pilots" }).getByRole("row").first()).toBeVisible({
    timeout: 20_000,
  });
  await search(page).fill("ridge");
  await expect(page).toHaveURL(/[?&]q=ridge/);
}

async function backOnSearchedList(page: Page): Promise<void> {
  await expect(page).toHaveURL(pageUrl("\\?q=ridge$"), { timeout: 20_000 });
  await expect(search(page)).toHaveValue("ridge");
}

async function chooseFile(page: Page): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file" }).click();
  await (await chooser).setFiles({
    name: "roster.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CSV),
  });
}

test("Import CSV is a page: its own URL, Back leaves it, and the chosen file survives a reload", async ({
  page,
}) => {
  await openListSearched(page);
  await page.getByRole("button", { name: "Roster actions" }).click();
  await page.getByRole("menuitem", { name: "Import CSV…" }).click();

  await expect(page).toHaveURL(pageUrl("/import$"));
  await expect(h1(page, "Import CSV")).toBeVisible({ timeout: 20_000 });
  // A page, not an overlay over the list.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await chooseFile(page);
  const review = h1(page, "Import roster.csv");
  await expect(review).toBeVisible();
  await expect(page.getByRole("main")).toContainText("0 updated · 1 new · 2 removed");
  // Choosing the file is a step on the same page, not a place to go Back to.
  await expect(page).toHaveURL(pageUrl("/import$"));

  // A reload has nothing in memory: the file comes back from the draft, and
  // the review is worked out again against the roster the page fetches.
  await page.reload();
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("main")).toContainText("0 updated · 1 new · 2 removed");

  // Back is the browser's, and returns the list as it was left.
  await page.goBack();
  await backOnSearchedList(page);
  // Back is "not now", not "discard": Forward finds the same review.
  await page.goForward();
  await expect(review).toBeVisible({ timeout: 20_000 });

  // Cancel discards it: nothing written, and the page starts again at the file.
  await page.getByRole("button", { name: "Cancel" }).click();
  await backOnSearchedList(page);
  const roster = await (await api.get(`/api/comp/${compId}/pilot`)).json();
  expect((roster as { pilots: unknown[] }).pilots).toHaveLength(ROSTER.length);
  await page.goForward();
  await expect(h1(page, "Import CSV")).toBeVisible({ timeout: 20_000 });
});

test("with no draft to read, the import page asks for the file again", async ({ page }) => {
  // A link opened in a fresh tab: no draft in its storage, and nothing wrong.
  await page.goto(`/comp/${compId}/pilots/import`);
  await expect(h1(page, "Import CSV")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Choose file" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);

  // A draft left by an older build, in a shape this one does not know, is
  // thrown away rather than read.
  await chooseFile(page);
  await expect(h1(page, "Import roster.csv")).toBeVisible();
  await page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      if (key.startsWith("glidecomp:draft:roster-import:")) {
        const stored = JSON.parse(sessionStorage.getItem(key)!) as { v: number };
        sessionStorage.setItem(key, JSON.stringify({ ...stored, v: stored.v - 1 }));
      }
    }
  });
  await page.reload();
  await expect(h1(page, "Import CSV")).toBeVisible({ timeout: 20_000 });

  // Opened directly, Cancel has no list behind it to go Back to: it goes to
  // the list instead.
  await chooseFile(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(pageUrl("$"), { timeout: 20_000 });
  await expect(page.getByRole("grid", { name: "Pilots" })).toBeVisible();
});

test("Fill from CIVL is a page: its own URL, Back leaves it, and a reload asks again", async ({
  page,
}) => {
  await openListSearched(page);
  await page.getByRole("button", { name: "Roster actions" }).click();
  await page.getByRole("menuitem", { name: "Fill from CIVL…" }).click();

  await expect(page).toHaveURL(pageUrl("/civl-fill$"));
  const heading = h1(page, "Fill from CIVL rankings");
  await expect(heading).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const reading = page.getByText("Reading the CIVL world rankings…");
  await expect(reading).toHaveCount(0, { timeout: 20_000 });

  // A reload has no list underneath: the page fetches the roster and asks
  // the rankings itself.
  await page.reload();
  await expect(heading).toBeVisible({ timeout: 20_000 });
  await expect(reading).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText("Could not read the CIVL rankings")).toHaveCount(0);

  await page.goBack();
  await backOnSearchedList(page);
});

/**
 * A file the comp cannot take as it stands — the commonest being a roster
 * exported from another competition, whose classes this one does not have.
 * The review says so once per class rather than once per row, and offers the
 * two ways out: add the class to the comp, or put those pilots in its default
 * class. Each test has a comp of its own, since both change it.
 */
test.describe("a file with a class the comp does not have", () => {
  const STRAY_CSV = ["name,class", "Ada Floater,floater", "Bo Floater,floater", "Cy Open,open"].join(
    "\n"
  );

  async function newComp(name: string, classes: string[], defaultClass: string): Promise<string> {
    const res = await api.post("/api/comp", {
      data: { name, category: "hg", pilot_classes: classes, default_pilot_class: defaultClass },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { comp_id: string }).comp_id;
  }

  async function openBlockedReview(page: Page, id: string): Promise<void> {
    await page.goto(`/comp/${id}/pilots/import`);
    await expect(h1(page, "Import CSV")).toBeVisible({ timeout: 20_000 });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose file" }).click();
    await (await chooser).setFiles({
      name: "other-comp.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(STRAY_CSV),
    });
    await expect(h1(page, "Import other-comp.csv")).toBeVisible();
    await expect(page.getByText("This file can’t be imported yet.")).toBeVisible();
    // Nothing to apply while anything blocks.
    await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0);
  }

  async function classesOf(id: string): Promise<Record<string, string>> {
    const body = (await (await api.get(`/api/comp/${id}/pilot`)).json()) as {
      pilots: Array<{ name: string; pilot_class: string }>;
    };
    return Object.fromEntries(body.pilots.map((p) => [p.name, p.pilot_class]));
  }

  test("says what is wrong once, and Put them in … uses the default class, through a reload", async ({
    page,
  }) => {
    const name = e2eCompName("Roster stray class");
    const id = await newComp(name, ["open", "sport"], "sport");
    try {
      await openBlockedReview(page, id);
      await expect(
        page.getByText(
          `2 pilots are in the class "floater", which ${name} doesn’t have. Its classes are open and sport.`
        )
      ).toBeVisible();
      await expect(
        page.getByText('Either add the class to the competition, or put those pilots in "sport".')
      ).toBeVisible();
      await expect(page.getByRole("button", { name: 'Add class "floater"' })).toBeVisible();

      // The rows are there, folded behind the sentence that sums them up.
      const rows = page.getByRole("button", { name: "Show the 2 rows" });
      await rows.click();
      await expect(page.getByText(/Row 1 \(Ada Floater\): class "floater" is not valid/)).toBeVisible();

      await page.getByRole("button", { name: 'Put them in "sport"' }).click();
      const moved = page.getByText('2 pilots from "floater" will be in "sport".');
      await expect(moved).toBeVisible();
      await expect(page.getByText("This file can’t be imported yet.")).toHaveCount(0);

      // Undo takes the choice back; the choice is in the draft, so a reload keeps it.
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByText("This file can’t be imported yet.")).toBeVisible();
      await page.getByRole("button", { name: 'Put them in "sport"' }).click();
      await page.reload();
      await expect(moved).toBeVisible({ timeout: 20_000 });

      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByRole("grid", { name: "Pilots" })).toBeVisible({ timeout: 20_000 });
      expect(await classesOf(id)).toEqual({
        "Ada Floater": "sport",
        "Bo Floater": "sport",
        "Cy Open": "open",
      });
    } finally {
      await api.delete(`/api/comp/${id}`);
    }
  });

  test("Add class … gives the comp the class, and the pilots keep it", async ({ page }) => {
    const id = await newComp(e2eCompName("Roster add class"), ["open"], "open");
    try {
      await openBlockedReview(page, id);
      await page.getByRole("button", { name: 'Add class "floater"' }).click();
      await expect(page.getByRole("button", { name: "Apply" })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("This file can’t be imported yet.")).toHaveCount(0);
      const comp = (await (await api.get(`/api/comp/${id}`)).json()) as { pilot_classes: string[] };
      expect(comp.pilot_classes).toEqual(["open", "floater"]);

      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByRole("grid", { name: "Pilots" })).toBeVisible({ timeout: 20_000 });
      expect(await classesOf(id)).toEqual({
        "Ada Floater": "floater",
        "Bo Floater": "floater",
        "Cy Open": "open",
      });
    } finally {
      await api.delete(`/api/comp/${id}`);
    }
  });
});
