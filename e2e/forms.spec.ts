/**
 * The kit form's rules (src/react/rac/form.tsx), on a phone and on a desktop.
 *
 * Every form used to handle a failed save by hand, two ways, and both lost
 * the reader: a toast that faded, or an error at the top of a sheet scrolled
 * past it. On an iPhone, Done spun, stopped, and nothing near the field said
 * why. The kit owns that now, and this spec is what holds it — so a form
 * built on the kit only has to test its own fields.
 *
 * It drives the development-only bench at /__kit/form
 * (pages/KitFormFixture.tsx), a form PAGE laid out as the pilot page is (the
 * sheet it once opened went with the rest in #817): Done on the header row,
 * then Name, ten notes and Email, so the field the server refuses is off
 * screen when the reader presses Done. Playwright
 * plays the server: every save goes to `/__kit/form-submit`, answered here.
 */
import { test, expect, type Locator, type Page, type Route } from "./fixtures/test";

/** The bench page's form. */
const form = (page: Page) =>
  page.locator("form").filter({ has: page.getByRole("heading", { name: "Test form", level: 1 }) });
const field = (page: Page, name: string) => form(page).getByRole("textbox", { name });
const done = (page: Page) => form(page).getByRole("button", { name: "Done" });

/** Count the saves, and answer each one with `answer`. */
async function server(page: Page, answer: (route: Route) => Promise<void>): Promise<() => number> {
  let saves = 0;
  await page.route("**/__kit/form-submit", async (route) => {
    saves++;
    await answer(route);
  });
  return () => saves;
}

const refuse = (status: number, body: object) => (route: Route) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function openForm(page: Page): Promise<void> {
  await page.goto("/__kit/form");
  await expect(page.getByRole("heading", { name: "Test form", level: 1 })).toBeVisible();
}

/**
 * On screen, and not under anything — the site's sticky header included, so
 * anything that slid beneath it is as good as hidden. The topmost element at
 * the target's centre must be the target or inside it.
 */
async function expectInView(page: Page, target: Locator, what: string): Promise<void> {
  await expect(target, `${what} is on screen`).toBeInViewport();
  const uncovered = await target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!top && (el === top || el.contains(top));
  });
  expect(uncovered, `${what} is not under anything`).toBe(true);
}

test("a problem the form finds itself is shown under its field, focused, and nothing is sent", async ({
  page,
}) => {
  const saves = await server(page, refuse(500, {}));
  await openForm(page);
  // Down at the bottom, far from Name (the click scrolls back up to Done).
  await field(page, "Email").scrollIntoViewIfNeeded();

  await done(page).click();
  const name = field(page, "Name");
  await expect(form(page)).toContainText("Enter a name.");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expectInView(page, name, "the Name field");
  expect(saves()).toBe(0);

  // Typing into it clears the error and keeps what was typed.
  await name.pressSequentially("Ana");
  await expect(name).toHaveValue("Ana");
  await expect(form(page)).not.toContainText("Enter a name.");
});

test("a refusal about a field lands under that field, focused, and clears when it is edited", async ({
  page,
}) => {
  await server(
    page,
    refuse(409, { error: "Ana is already registered with this email.", field: "contact_email" })
  );
  await openForm(page);
  await field(page, "Email").fill("ana@example.com");
  await field(page, "Name").fill("Ana");
  // Back at the top, far from Email.
  await field(page, "Name").scrollIntoViewIfNeeded();

  await done(page).click();
  const email = field(page, "Email");
  await expect(form(page)).toContainText("Ana is already registered with this email.");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toBeFocused();
  await expectInView(page, email, "the Email field");
  // Still open, and nothing typed is lost.
  await expect(field(page, "Name")).toHaveValue("Ana");

  await email.fill("someone@example.com");
  await expect(form(page)).not.toContainText("already registered");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  // And the edit itself survived clearing the error. It once did not: the
  // field re-rendered with its old value and swallowed what was typed.
  await expect(email).toHaveValue("someone@example.com");
});

test("a refusal about nothing in particular is shown beside Done, focused and on screen", async ({
  page,
}) => {
  await server(page, refuse(409, { error: "The competition is closed." }));
  await openForm(page);
  await field(page, "Name").fill("Ana");
  await field(page, "Email").scrollIntoViewIfNeeded();

  await done(page).click();
  const alert = form(page).getByRole("alert").filter({ hasText: "The competition is closed." });
  await expectInView(page, alert, "the error");
  await expect(alert).toBeFocused();

  // Scrolled away and back, it is still there: an error, not a toast.
  await field(page, "Email").scrollIntoViewIfNeeded();
  await alert.scrollIntoViewIfNeeded();
  await expectInView(page, alert, "the error, scrolled back to");
});

test("a refusal naming a field the form does not have goes to the form's own error", async ({
  page,
}) => {
  await server(page, refuse(400, { error: "That is not allowed.", field: "nothing_here" }));
  await openForm(page);
  await field(page, "Name").fill("Ana");
  await done(page).click();
  await expectInView(page, form(page).getByRole("alert").filter({ hasText: "That is not allowed." }), "the error");
});

test("a dropped connection says so, and keeps everything typed", async ({ page }) => {
  await server(page, (route) => route.abort("internetdisconnected"));
  await openForm(page);
  await field(page, "Name").fill("Ana");
  await field(page, "Email").fill("ana@example.com");

  await done(page).click();
  await expectInView(
    page,
    form(page).getByRole("alert").filter({
      hasText: "Could not reach GlideComp. Check your connection, then try again.",
    }),
    "the error"
  );
  await expect(field(page, "Name")).toHaveValue("Ana");
  await expect(field(page, "Email")).toHaveValue("ana@example.com");
});

test("one submit at a time, and the button says it is busy", async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const saves = await server(page, async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await openForm(page);
  await field(page, "Name").fill("Ana");

  await done(page).click();
  await expect(done(page)).toHaveAttribute("data-pending", "true");
  // A second press, and Enter in a field, while the first is in flight.
  await done(page).click({ force: true });
  await field(page, "Name").press("Enter");
  release();

  await expect(page.getByText("Saved the test form")).toBeVisible({ timeout: 20_000 });
  await expect(done(page)).not.toHaveAttribute("data-pending", "true");
  expect(saves()).toBe(1);
});

test("busy until the save has been acted on, not only answered", async ({ page }) => {
  // Create API key reads the answer and then reloads the list: a second press
  // in that gap made a second key, because the button was live again the
  // moment the first response arrived.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/__kit/form-after", async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const saves = await server(page, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
  await openForm(page);
  await field(page, "Name").fill("Ana");

  await done(page).click();
  await expect.poll(saves).toBe(1);
  await expect(done(page)).toHaveAttribute("data-pending", "true");
  await done(page).click({ force: true });
  await field(page, "Name").press("Enter");
  release();

  await expect(page.getByText("Saved the test form")).toBeVisible({ timeout: 20_000 });
  await expect(done(page)).not.toHaveAttribute("data-pending", "true");
  expect(saves()).toBe(1);
});

test("an action inside the form is refused in the form's banner, focused and on screen", async ({
  page,
}) => {
  // The pilot page's Remove sits at the foot and its refusal in the banner at
  // the top: on a phone, a refusal that only appeared there was never seen.
  await page.route("**/__kit/form-action", (route) =>
    refuse(409, { error: "That one cannot be removed." })(route)
  );
  await openForm(page);
  const remove = form(page).getByRole("button", { name: "Remove" });
  await remove.scrollIntoViewIfNeeded();
  await remove.click();
  // Asked first: the dialog gives focus back to Remove as it closes, which
  // must not take it off the refusal.
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();

  const banner = form(page).getByRole("alert").filter({ hasText: "That one cannot be removed." });
  await expect(banner).toBeFocused();
  await expectInView(page, banner, "the refusal");
  await expect(page.getByText("Removed the test")).toHaveCount(0);
});
