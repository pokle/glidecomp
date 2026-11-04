/**
 * Starting a new competition (/comp/new, pages/NewCompPage.tsx): a page of
 * its own rather than a dialog over the list, by the overlays rule in
 * CLAUDE.md (issue #818).
 *
 * Runs in BOTH Playwright projects (fixtures/mobile.ts): a dialog with a text
 * field is what the rule retires because of the phone, so the phone is where
 * the page has to work. What it holds:
 *
 *   - the list's "Start a new competition" — the + beside its search, on one
 *     row that stays at the top of the screen — goes to /comp/new, and the
 *     browser's Back returns to the list;
 *   - a reload stays on the page — "new" is not taken for a competition's id;
 *   - the form is the kit's: its own check and the server's refusal each land
 *     under the field they are about;
 *   - Create goes to the competition it made, on its keyed URL, and Back from
 *     there returns to the list rather than to the used form;
 *   - a signed-out reader gets the same +, and /comp/new offers them sign-in.
 *
 * The comp a test creates is named through e2eCompName (so a killed run is
 * swept) and deleted afterwards.
 */
import { test, expect, type Page } from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { e2eCompName } from "./fixtures/stack";
import { bareCompId, idFromSegment } from "../web/frontend/src/react/lib/slug";

const TEST_USER = {
  name: "E2E New Comp Organiser",
  email: "e2e-comp-new@test.local",
};

const COMP_NAME = e2eCompName("New comp page");

/** Set as soon as a comp exists, so afterEach can remove it. */
let createdCompId: string | null = null;

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

test.afterEach(async ({ page }) => {
  if (!createdCompId) return;
  const res = await page.request.delete(`/api/comp/${createdCompId}`);
  expect(res.status(), `cleanup: DELETE /api/comp/${createdCompId}`).toBe(200);
  createdCompId = null;
});

const heading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Start a new competition" });
const startLink = (page: Page) => page.getByRole("link", { name: "Start a new competition" });
const nameField = (page: Page) => page.getByRole("textbox", { name: "Name" });
const classesField = (page: Page) => page.getByRole("textbox", { name: "Pilot classes" });
const create = (page: Page) => page.getByRole("button", { name: "Create" });

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("the list opens it at /comp/new, a reload keeps it, and Back returns to the list", async ({
    page,
  }) => {
    await page.goto("/comp");
    await startLink(page).click();
    await expect(heading(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/comp/new");
    // A page, not an overlay.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // "new" is not a competition's id: a reload is the same page, not a 404.
    await page.reload();
    await expect(heading(page)).toBeVisible();
    await expect(nameField(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/comp/new");

    await page.goBack();
    await expect(startLink(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/comp");
  });

  test("its own check and the server's refusal land under their fields; Create goes to the comp", async ({
    page,
  }) => {
    await page.goto("/comp");
    await startLink(page).click();
    await expect(heading(page)).toBeVisible();

    // Nothing typed: the form's own check, under Name, which takes focus.
    await create(page).click();
    await expect(nameField(page)).toHaveAccessibleDescription(/Enter a name\./);
    await expect(nameField(page)).toBeFocused();
    expect(new URL(page.url()).pathname).toBe("/comp/new");

    // The server refuses one pilot class (`field: "pilot_classes.1"`): under
    // Pilot classes, which takes focus, and everything typed is kept.
    await nameField(page).fill(COMP_NAME);
    await expect(nameField(page)).not.toHaveAccessibleDescription(/Enter a name\./);
    await classesField(page).fill("open, <b>");
    await create(page).click();
    await expect(classesField(page)).toHaveAccessibleDescription(/must not contain < or >/);
    await expect(classesField(page)).toBeFocused();
    await expect(nameField(page)).toHaveValue(COMP_NAME);
    expect(new URL(page.url()).pathname).toBe("/comp/new");

    await classesField(page).fill("open, sport");
    await create(page).click();

    // The new comp, on the URL that carries its share key (it starts hidden).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(COMP_NAME);
    const urlCompId = idFromSegment(new URL(page.url()).pathname.split("/")[2]);
    expect(urlCompId).toMatch(/^[a-z]+_[a-z0-9]{12}$/);
    createdCompId = bareCompId(urlCompId);

    // The form was replaced in the history: Back returns to the list.
    await page.goBack();
    await expect(startLink(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/comp");
  });
});

test("signed out, the list's + leads to sign-in", async ({ page }) => {
  await page.goto("/comp");
  await startLink(page).click();
  await expect(heading(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/comp/new");
  await expect(page.getByRole("button", { name: "Sign in to start a competition" })).toBeVisible();
  await expect(nameField(page)).toHaveCount(0);
});

/** A target a thumb can hit, measured on the rendered box (44px). */
function expectThumbSized(name: string, box: { width: number; height: number } | null) {
  expect(box, `${name} must be on screen`).not.toBeNull();
  expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
}

test("the list's search and + share one row, thumb-sized, that stays at the top", async ({
  page,
}) => {
  // A list long enough to scroll on any screen: the seeded comps, repeated.
  // (The dev server serves the SPA shell, so the list is fetched, not SSR'd.)
  await page.route(
    (url) => url.pathname === "/api/comp",
    async (route) => {
      const res = await route.fetch();
      const { comps } = (await res.json()) as { comps: { comp_id: string; name: string }[] };
      const many = Array.from({ length: 40 }, (_, i) => ({
        ...comps[i % comps.length],
        comp_id: `${comps[i % comps.length].comp_id}${i}`,
        name: `${comps[i % comps.length].name} (${i + 1})`,
      }));
      await route.fulfill({ response: res, json: { comps: many } });
    }
  );
  await page.goto("/comp");
  const search = page.getByRole("searchbox", {
    name: "Search competitions, tasks, pilots and turnpoints",
  });
  const searchGroup = page.getByRole("group").filter({ has: search }).first();
  await expect(page.getByRole("main").getByRole("listitem")).toHaveCount(40);

  await expectNoSidewaysScroll(page);

  const plus = await startLink(page).boundingBox();
  const box = await searchGroup.boundingBox();
  expectThumbSized("the + button", plus);
  expect(box!.height, "the search box height").toBeGreaterThanOrEqual(44);
  // One row: the + sits beside the search, not under it.
  expect(Math.abs(plus!.y + plus!.height / 2 - (box!.y + box!.height / 2))).toBeLessThan(4);
  expect(plus!.x).toBeGreaterThanOrEqual(box!.x + box!.width);

  // Scrolled to the end of the list, both are still on screen, at the top:
  // sticky in the page's flow, never fixed to the screen.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY), "the list scrolled").toBeGreaterThan(500);
  const scrolled = await startLink(page).boundingBox();
  expect(scrolled!.y, "the + stays on screen").toBeGreaterThanOrEqual(0);
  expect(scrolled!.y, "the + stays near the top").toBeLessThan(200);
  expect(
    await startLink(page).evaluate((el) => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return true;
      }
      return false;
    }),
    "nothing on this page is fixed to the screen"
  ).toBe(false);
});
