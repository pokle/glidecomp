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
 * (pages/KitFormFixture.tsx): Name, ten notes, then Email, so whichever field
 * the test is about is off screen when the reader presses Done. Playwright
 * plays the server: every save goes to `/__kit/form-submit`, answered here.
 */
import { test, expect, type Locator, type Page, type Route } from "./fixtures/test";

const sheet = (page: Page) => page.getByRole("dialog", { name: "Test form" });
const field = (page: Page, name: string) => sheet(page).getByRole("textbox", { name });
const done = (page: Page) => sheet(page).getByRole("button", { name: "Done" });

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

async function openSheet(page: Page): Promise<void> {
  await page.goto("/__kit/form");
  await page.getByRole("button", { name: "Open the test sheet" }).click();
  await expect(sheet(page)).toBeVisible();
}

/**
 * On screen, and not under the sheet's header — the header does not scroll,
 * so anything that slid beneath it is as good as hidden.
 */
async function expectInView(page: Page, target: Locator, what: string): Promise<void> {
  await expect(target, `${what} is on screen`).toBeInViewport();
  const header = await done(page).boundingBox();
  const box = await target.boundingBox();
  expect(box!.y, `${what} is not under the header`).toBeGreaterThanOrEqual(
    header!.y + header!.height
  );
}

test("a problem the form finds itself is shown under its field, focused, and nothing is sent", async ({
  page,
}) => {
  const saves = await server(page, refuse(500, {}));
  await openSheet(page);
  // Down at the bottom, far from Name.
  await field(page, "Email").scrollIntoViewIfNeeded();

  await done(page).click();
  const name = field(page, "Name");
  await expect(sheet(page)).toContainText("Enter a name.");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toBeFocused();
  await expectInView(page, name, "the Name field");
  expect(saves()).toBe(0);

  // Typing into it clears the error and keeps what was typed.
  await name.pressSequentially("Ana");
  await expect(name).toHaveValue("Ana");
  await expect(sheet(page)).not.toContainText("Enter a name.");
});

test("a refusal about a field lands under that field, focused, and clears when it is edited", async ({
  page,
}) => {
  await server(
    page,
    refuse(409, { error: "Ana is already registered with this email.", field: "contact_email" })
  );
  await openSheet(page);
  await field(page, "Email").fill("ana@example.com");
  await field(page, "Name").fill("Ana");
  // Back at the top, far from Email.
  await field(page, "Name").scrollIntoViewIfNeeded();

  await done(page).click();
  const email = field(page, "Email");
  await expect(sheet(page)).toContainText("Ana is already registered with this email.");
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toBeFocused();
  await expectInView(page, email, "the Email field");
  // Still open, and nothing typed is lost.
  await expect(field(page, "Name")).toHaveValue("Ana");

  await email.fill("someone@example.com");
  await expect(sheet(page)).not.toContainText("already registered");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  // And the edit itself survived clearing the error. It once did not: the
  // field re-rendered with its old value and swallowed what was typed.
  await expect(email).toHaveValue("someone@example.com");
});

test("a refusal about nothing in particular is pinned under the header, and stays there", async ({
  page,
}) => {
  await server(page, refuse(409, { error: "The competition is closed." }));
  await openSheet(page);
  await field(page, "Name").fill("Ana");
  await field(page, "Email").scrollIntoViewIfNeeded();

  await done(page).click();
  const alert = sheet(page).getByRole("alert").filter({ hasText: "The competition is closed." });
  await expectInView(page, alert, "the error");
  await expect(alert).toBeFocused();

  // Scroll the form every way: the error does not scroll with it.
  await field(page, "Name").scrollIntoViewIfNeeded();
  await expectInView(page, alert, "the error, scrolled to the top");
  await field(page, "Email").scrollIntoViewIfNeeded();
  await expectInView(page, alert, "the error, scrolled to the bottom");
});

test("a refusal naming a field the form does not have goes to the pinned error", async ({
  page,
}) => {
  await server(page, refuse(400, { error: "That is not allowed.", field: "nothing_here" }));
  await openSheet(page);
  await field(page, "Name").fill("Ana");
  await done(page).click();
  await expectInView(page, sheet(page).getByRole("alert").filter({ hasText: "That is not allowed." }), "the error");
});

test("a dropped connection says so, and keeps everything typed", async ({ page }) => {
  await server(page, (route) => route.abort("internetdisconnected"));
  await openSheet(page);
  await field(page, "Name").fill("Ana");
  await field(page, "Email").fill("ana@example.com");

  await done(page).click();
  await expectInView(
    page,
    sheet(page).getByRole("alert").filter({
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
  await openSheet(page);
  await field(page, "Name").fill("Ana");

  await done(page).click();
  await expect(done(page)).toHaveAttribute("data-pending", "true");
  // A second press, and Enter in a field, while the first is in flight.
  await done(page).click({ force: true });
  await field(page, "Name").press("Enter");
  release();

  await expect(sheet(page)).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText("Saved the test form")).toBeVisible();
  expect(saves()).toBe(1);
});
