/**
 * The hierarchical competition settings pages (/comp/:id/settings[/:group]) —
 * the mobile-first replacement for the old 21-control settings dialog: an
 * index of grouped rows, a focused sub-page per group, explicit Save per
 * page, and the unsaved-changes guard shared with /settings.
 *
 * What this spec pins:
 * - the index rows and their current-value summaries, and that a group save
 *   PATCHes ONLY that group's fields (the server diffs per field, so a page
 *   sending another group's values would silently widen every save);
 * - the Discard/Keep navigation guard on a dirty sub-page, reached by a link
 *   click, and the browser's own question on a reload — while Back is the
 *   browser's Back and leaves without asking (#817);
 * - the whole journey with no horizontal overflow — the point of the
 *   restructure;
 * - non-admin fallback and the unknown-group 404.
 *
 * Runs against its own comp (named through e2eCompName so the pre-run sweep
 * can catch strays) with a dedicated fixture admin, so nothing here touches
 * the seeded sample comp other specs read.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts): these pages were built
 * mobile-first, so a desktop-only pass would exercise them at the one width
 * they were not designed for.
 */
import { test, expect, PHONE_ONLY, type Page } from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { e2eCompName } from "./fixtures/stack";

const ADMIN_USER = {
  name: "Comp Settings Fixture",
  email: "comp-settings@test.local",
};
const VISITOR_USER = {
  name: "Comp Settings Visitor",
  email: "comp-settings-visitor@test.local",
};
const COMP_NAME = e2eCompName("Comp Settings Pages");

let compId: string;

function baseUrl(): string {
  return process.env.DEV_FRONTEND_PORT
    ? `http://localhost:${process.env.DEV_FRONTEND_PORT}`
    : "http://localhost:3000";
}

async function devLogin(page: Page, user: { name: string; email: string }) {
  const login = await page.request.post("/api/auth/dev-login", { data: user });
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
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  const login = await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  expect(login.ok(), await login.text()).toBe(true);
  // Public, so the visitor test reaches the admin-only notice rather than a
  // hidden comp's 404.
  const created = await api.post("/api/comp", {
    data: { name: COMP_NAME, category: "hg", pilot_classes: ["open"], test: false },
  });
  expect(created.ok(), await created.text()).toBe(true);
  compId = ((await created.json()) as { comp_id: string }).comp_id;
  await api.dispose();
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: baseUrl() });
  await api.post("/api/auth/dev-login", { data: ADMIN_USER });
  if (compId) await api.delete(`/api/comp/${compId}`);
  await api.dispose();
});

test("a visitor is sent to the competition, signed in or not, and an unknown group 404s", async ({
  page,
}) => {
  // Before any admin test hides or reshapes the comp: a signed-in non-admin
  // reaching the URL is sent to the competition itself, and told why.
  await devLogin(page, VISITOR_USER);
  await page.goto(`/comp/${compId}/settings`);
  await expect(page.getByText("That page is for the competition’s organisers.")).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/settings/);
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);

  // Signed out, the same — told to sign in if they are an organiser.
  await page.context().clearCookies();
  await page.goto(`/comp/${compId}/settings`);
  await expect(
    page.getByText("That page is for the competition’s organisers. Sign in if you are one.")
  ).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/\/settings/);

  // An unknown group is a dead URL, not an empty page.
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings/nonsense`);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("the index groups the settings; a group save PATCHes only its own fields", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings`);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  // The four group rows, each carrying a current-value summary. Scoped to
  // main: the Shell footer also carries a "Scoring" link, and substring name
  // matching would resolve both (strict-mode violation).
  const main = page.getByRole("main");
  const general = main.getByRole("link", { name: /^General/ });
  await expect(general).toContainText(COMP_NAME);
  await expect(main.getByRole("link", { name: /^Pilot classes/ })).toContainText(
    "open"
  );
  await expect(main.getByRole("link", { name: /^Scoring/ })).toContainText("GAP");
  const access = main.getByRole("link", { name: /^Access/ });
  await expect(access).toContainText("Open registration");
  // The destructive action is a row on the index, not a hidden sub-page.
  await expect(
    page.getByRole("button", { name: "Delete competition" })
  ).toBeVisible();

  // Into a group, change one thing, save.
  await access.click();
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  // Close Date's calendar is ON THE PAGE, not behind a trigger: day cells are
  // present without anything being opened, and there is no "Open calendar"
  // button at all. (The lazy picker chunk has to arrive first, hence the
  // generous timeout.)
  await expect(main.getByRole("gridcell").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Open calendar" })).toHaveCount(0);

  const box = page.getByLabel("Let pilots register themselves by submitting a track");
  await expect(box).toBeChecked();
  // Click the visible label, not the input: the kit hides the real checkbox
  // under a styled span (rac gotcha #13).
  await page
    .getByText("Let pilots register themselves by submitting a track")
    .click();
  await expect(box).not.toBeChecked();

  const [patch] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === "PATCH" && r.url().includes("/api/comp/")
    ),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  // ONLY the Access group's fields travel — the server diffs per field, so a
  // page that also sent name/classes/gap_params would quietly turn every
  // Access save into a whole-comp save.
  const body = patch.postDataJSON() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "admin_emails",
    "close_date",
    "open_igc_upload",
    "open_registration",
    "test",
  ]);
  expect(body.open_registration).toBe(false);

  // A successful save lands back on the index, and the row's summary reads
  // the new state.
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: /^Access/ })).toContainText(
    "Admins add pilots"
  );
});

test("General edits the organiser's notes, and the comp page shows them with safe links", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings/general`);
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();

  const notes = page.getByLabel("Notes for every pilot");
  await expect(notes).toHaveValue("");
  await notes.fill(
    "Briefing 9:30 at the launch shelter.\n" +
      "Tracking: https://puretrack.io/g/e2e.\n" +
      "Not a link: javascript:alert(1)"
  );

  const [patch] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === "PATCH" && r.url().includes("/api/comp/")
    ),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  expect((patch.postDataJSON() as Record<string, unknown>).organiser_notes).toBe(
    "Briefing 9:30 at the launch shelter.\nTracking: https://puretrack.io/g/e2e.\nNot a link: javascript:alert(1)"
  );
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();

  await page.goto(`/comp/${compId}`);
  const shown = page.getByTestId("organiser-notes");
  await expect(shown).toContainText("Briefing 9:30 at the launch shelter.");
  // The web address is a link, minus the full stop that ends its sentence,
  // opening in a new tab that cannot reach back; the script stays text.
  const links = shown.getByRole("link");
  await expect(links).toHaveCount(1);
  await expect(links).toHaveText("https://puretrack.io/g/e2e");
  await expect(links).toHaveAttribute("href", "https://puretrack.io/g/e2e");
  await expect(links).toHaveAttribute("target", "_blank");
  await expect(links).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
  await expect(shown).toContainText("Not a link: javascript:alert(1)");
});

/**
 * Save is in the bar, and live only while there is something to commit
 * (issue #863). One exception, held by comp-creation.spec.ts: on a competition
 * whose settings nobody has saved yet, an untouched Save is the review the
 * setup guide asks for, so it stays live until the first save.
 */
test("Save is live only while something has changed; Scoring's reset is under More actions", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  // Any save marks the settings reviewed. Said here, not left to an earlier
  // test: a retry starts from a new competition.
  const reviewed = await page.request.patch(`/api/comp/${compId}`, {
    data: { name: COMP_NAME },
  });
  expect(reviewed.ok(), await reviewed.text()).toBe(true);

  await page.goto(`/comp/${compId}/settings/scoring`);
  await expect(page.getByRole("heading", { name: "Scoring", exact: true })).toBeVisible();
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  // A form: Cancel is the way out, where a read page has Back.
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();

  const advanced = page.getByText("Advanced scoring settings");
  await advanced.click();
  const nominalTime = page.getByRole("textbox", { name: "Nominal time (min)" });
  const original = await nominalTime.inputValue();
  await nominalTime.fill("77");
  await nominalTime.blur();
  await expect(save).toBeEnabled();

  // Folded away again: the reset opens Advanced, so the reader sees what it
  // changed. It is the page's one other action, so it is under ⋯.
  await advanced.click();
  await expect(nominalTime).toBeHidden();
  await expect(page.getByRole("button", { name: "Reset to defaults" })).toHaveCount(0);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Reset to defaults" }).click();
  await expect(nominalTime).toBeVisible();
  await expect(nominalTime).toHaveValue(original);
});

test("leaving a dirty sub-page is guarded: Keep stays, Discard leaves", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings/general`);
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();

  const name = page.getByLabel("Name");
  await name.fill(`${COMP_NAME} (edited)`);
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

  // Cancel asks before it throws a change away. Keep editing: still here,
  // edit retained.
  await page.getByRole("button", { name: "Cancel" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Discard changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(name).toHaveValue(`${COMP_NAME} (edited)`);

  // A link out asks the same question: the title's menu is the trail now
  // (the "Breadcrumb" landmark is still in the markup, visually hidden).
  await page.getByRole("button", { name: "General settings: go to another page" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(dialog.getByText("Discard changes?")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeHidden();
  await expect(name).toHaveValue(`${COMP_NAME} (edited)`);

  // Discard: Cancel leaves for the index, and nothing was saved.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: /^General/ })
  ).toContainText(COMP_NAME);
});

/**
 * Back is the browser's Back, on a dirty sub-page too (#817; docs/interaction-guide.md, "No
 * full-screen overlays"). The guard asks before a link (above), a reload or a
 * tab close — never on Back. It used to: it held a history entry of its own
 * while the form was dirty so that Back could be answered with a question,
 * and that imitation of navigation is what was deleted. These pages keep no
 * draft, so Back leaves the edits behind, as any web form does.
 */
test("Back on a dirty sub-page leaves without asking; a reload still asks", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  // Arrive through the index rather than by `goto`, so the press has a real
  // route to return to instead of unloading the document.
  await page.goto(`/comp/${compId}/settings`);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: /^General/ }).click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();

  const name = page.getByLabel("Name");
  await name.fill(`${COMP_NAME} (reload)`);
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

  // A reload with unsaved edits asks first: the browser's own "Leave site?"
  // (beforeunload). Answered "stay", the edits are still there.
  const asked = page.waitForEvent("dialog");
  void page.reload().catch(() => {});
  const leave = await asked;
  expect(leave.type()).toBe("beforeunload");
  await leave.dismiss();
  await expect(name).toHaveValue(`${COMP_NAME} (reload)`);

  // Back does not ask. One press is one page: the index, with nothing saved.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(
    page.getByRole("main").getByRole("link", { name: /^General/ })
  ).toContainText(COMP_NAME);
  await expect(
    page.getByRole("main").getByRole("link", { name: /^General/ })
  ).not.toContainText("(reload)");
});

/**
 * The settings pages are the kit form (rac/form.tsx through
 * components/SettingsForm.tsx), and `e2e/forms.spec.ts` holds the kit's rules.
 * What is pinned here is these pages' own half: their fields carry the names
 * the server's refusals are about, so a refusal lands under its field rather
 * than in a toast that fades.
 */
test("a refused save lands under the field it is about, focused, and never as a toast", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings/access`);
  const heading = page.getByRole("heading", { name: "Access", exact: true });
  await expect(heading).toBeVisible();

  // The server refuses one ADDRESS ("admin_emails.1"); it belongs under the
  // field the whole list is typed in.
  const admins = page.getByRole("textbox", { name: "Admin emails" });
  const typed = `${ADMIN_USER.email}, not-an-email`;
  await admins.fill(typed);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes("/api/comp/")
    ),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  expect(res.status()).toBe(400);

  await expect(admins).toHaveAttribute("aria-invalid", "true");
  await expect(admins).toHaveAccessibleDescription(/Invalid email address/);
  await expect(admins).toBeFocused();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  // Nothing typed is lost, and the page stays put.
  await expect(heading).toBeVisible();
  await expect(admins).toHaveValue(typed);

  // Editing the field clears its error.
  await admins.fill(ADMIN_USER.email);
  await expect(admins).not.toHaveAttribute("aria-invalid", "true");
});

test("Scoring: a refused GAP parameter unfolds Advanced and lands under its own field", async ({
  page,
}) => {
  await devLogin(page, ADMIN_USER);
  await page.goto(`/comp/${compId}/settings/scoring`);
  await expect(page.getByRole("heading", { name: "Scoring", exact: true })).toBeVisible();

  // A nominal time of 0 passes the field's own bounds and is refused by the
  // server as `gap_params.nominalTime` — the page's `fieldNames` is what puts
  // that under "Nominal time (min)".
  const advanced = page.getByText("Advanced scoring settings");
  await advanced.click();
  // The textbox, not the steppers beside it, which the label names too.
  const nominalTime = page.getByRole("textbox", { name: "Nominal time (min)" });
  await nominalTime.fill("0");
  // Folded away again before Save: the field with the problem must not stay
  // hidden behind the disclosure.
  await advanced.click();
  await expect(nominalTime).toBeHidden();

  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes("/api/comp/")
    ),
    page.getByRole("button", { name: "Save" }).click(),
  ]);
  expect(res.status()).toBe(400);
  expect(((await res.json()) as { field?: string }).field).toBe("gap_params.nominalTime");

  await expect(nominalTime).toBeVisible();
  await expect(nominalTime).toHaveAttribute("aria-invalid", "true");
  await expect(nominalTime).not.toHaveAccessibleDescription("");
  await expect(nominalTime).toBeFocused();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("the whole journey fits a phone: no horizontal overflow", { tag: PHONE_ONLY }, async ({
  page,
}) => {
  // The viewport used to be set here, by hand, at 390×844. It comes from the
  // `mobile` project now (issue #643) — which also brings touch, a mobile user
  // agent and `(pointer: coarse)`, none of which a resize gives you. The other
  // three tests in this file run in BOTH projects, so the pages themselves are
  // driven at a phone width regardless; what is left here is the assertion
  // that only means something there.
  await devLogin(page, ADMIN_USER);

  // Reviewed already, whatever ran before this (see the Save test above).
  const reviewed = await page.request.patch(`/api/comp/${compId}`, {
    data: { name: COMP_NAME },
  });
  expect(reviewed.ok(), await reviewed.text()).toBe(true);

  // Comp page → its title's menu → Settings → index.
  await page.goto(`/comp/${compId}`);
  await page.getByRole("button", { name: `${COMP_NAME}: go to another page` }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page, "the settings index");

  // Rows are comfortably tappable (44px minimum target).
  const general = page.getByRole("main").getByRole("link", { name: /^General/ });
  const rowBox = await general.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(44);

  // Index → sub-page, whose bar holds Cancel, the title and Save on one row
  // → an edit → Save → back on the index.
  await general.click();
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page, "the General sub-page");
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled();
  for (const control of [save, page.getByRole("button", { name: "Cancel" })]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByLabel("Notes for every pilot").fill("Briefing 9:30 at the launch shelter.");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(page, "the settings index after saving");
});
