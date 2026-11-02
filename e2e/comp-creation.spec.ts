import { test, expect } from "./fixtures/test";
import { bareCompId, idFromSegment } from "../web/frontend/src/react/lib/slug";
import { e2eCompName } from "./fixtures/stack";

// A STABLE identity, not a per-run one: dev-login signs up-or-in, so this
// account is created on the first run ever and reused after that. Minting
// `e2e-${Date.now()}@test.local` added a user (and their comp) to the
// persistent local database on every single run — issue #477.
const TEST_USER = {
  name: "E2E Test Pilot",
  email: "e2e-comp-creation@test.local",
};
// The comp this spec creates. e2eCompName() stamps the marker the leftover
// sweep looks for, so a run killed before the cleanup below still gets tidied
// up by e2e/global-setup.ts.
const COMP_NAME = e2eCompName("Test Competition");

/** Set by the test as soon as the comp exists, so afterEach can remove it. */
let createdCompId: string | null = null;

test.afterEach(async ({ page }) => {
  if (!createdCompId) return;
  // The creating user is this comp's admin, and the session cookie is still on
  // the page context. DELETE cascades to the task created underneath it.
  const res = await page.request.delete(`/api/comp/${createdCompId}`);
  // Assert, don't hope: a silently-failing cleanup is how the local database
  // filled up in the first place (issue #477). The global-setup sweep would
  // still catch it next run, but the leak would go unnoticed until then.
  expect(res.status(), `cleanup: DELETE /api/comp/${createdCompId}`).toBe(200);
  createdCompId = null;
});

test("dev login, create competition and task", async ({ page, request }) => {
  const testUser = TEST_USER;

  // Step 1: Dev login — POST sets session cookie
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: testUser,
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(
      `Dev login failed: ${loginRes.status()} ${loginRes.statusText()} — ${body}`
    );
  }

  // Extract session cookie from response and set in browser context
  const setCookieHeader = loginRes.headers()["set-cookie"];
  if (setCookieHeader) {
    const tokenMatch = setCookieHeader.match(
      /better-auth\.session_token=([^;]+)/
    );
    if (tokenMatch) {
      await page.context().addCookies([
        {
          name: "better-auth.session_token",
          value: tokenMatch[1],
          domain: "localhost",
          path: "/",
        },
      ]);
    }
  }

  // Step 2: the user gets a username auto-derived at sign-up, so there is no
  // onboarding gate to clear — landing on /comp stays on /comp instead of
  // bouncing to /onboarding. The user-menu button rendering is the sync point
  // that the signed-in user has resolved.
  await page.goto("/comp");
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/comp");

  // Step 3: Create a competition. "Start a new competition" (the + beside the
  // search) opens a page of its own, /comp/new (e2e/comp-new.spec.ts holds
  // that page's URL, Back and reload).
  await page.getByRole("link", { name: "Start a new competition" }).click();
  await expect(page).toHaveURL(/\/comp\/new$/);
  const createForm = page.getByRole("main");
  await createForm.getByLabel("Name").fill(COMP_NAME);
  // Category defaults to HG — no change needed. There is no visibility
  // choice here: every new comp starts hidden, and going public is the setup
  // guide's last step.
  await expect(createForm.getByText("Hidden?")).toHaveCount(0);
  await createForm.getByRole("button", { name: "Create" }).click();

  // Client-side navigation to the competition detail page; the heading
  // assertion polls until the comp fetch resolves.
  await page.waitForURL(
    (url) => /^\/comp\/[^/]+$/.test(url.pathname) && url.pathname !== "/comp/new"
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(COMP_NAME);
  // Born hidden, and opened on the URL that carries its share key: the
  // organiser's address bar is the link to share. The path segment is the
  // canonical `${name-slug}-${id}_${key}` form.
  const urlCompId = idFromSegment(new URL(page.url()).pathname.split("/")[2]);
  expect(urlCompId).toMatch(/^[a-z]+_[a-z0-9]{12}$/);
  // Capture the bare id for afterEach's cleanup.
  createdCompId = bareCompId(urlCompId);
  await expect(
    page.getByText("Hidden. Anyone you send this page’s link to can see it.")
  ).toBeVisible();
  // An anonymous reader (the `request` fixture holds no session) gets a 404
  // for the id alone — and the comp itself through the link.
  expect((await request.get(`/api/comp/${createdCompId}`)).status()).toBe(404);
  expect((await request.get(`/api/comp/${urlCompId}`)).status()).toBe(200);

  // Step 3b: The admin-only setup guide shows on a fresh comp with step 1
  // ("Create the competition") pre-checked. The progress count is over the
  // five *required* steps — "Review settings" is optional (issue #343: new
  // comps already start from the official defaults), so it doesn't count.
  const guide = page.getByRole("region", { name: "Set up your competition" });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("1 of 5 steps");

  // Saving settings (defaults untouched) counts as reviewing them, ticking the
  // optional "Review settings" step over. Being optional, it doesn't move the
  // required-step counter — the count stays "1 of 4". Settings is a hierarchy
  // of pages now: index → a group page → Save → back to the index → back to
  // the comp.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("main").getByRole("link", { name: /^General/ }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // The save lands back on the settings index; return to the comp page.
  await expect(page.getByRole("main").getByRole("link", { name: /^General/ })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: COMP_NAME })
    .click();
  await expect(guide).toContainText("Completed: Review settings");
  await expect(guide).toContainText("1 of 5 steps");

  // The last step, "Make public", leads to the Access settings, where the
  // "Hidden?" switch turns off. Saving ticks the step and moves the count.
  await guide.getByRole("link", { name: "Make public" }).click();
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeVisible();
  const hidden = page.getByRole("switch", { name: /Hidden\?/ });
  await expect(hidden).toBeChecked();
  // Click the visible label, not the input (rac gotcha #13).
  await page.getByText("Hidden?").click();
  await expect(hidden).not.toBeChecked();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("main").getByRole("link", { name: /^Access/ })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: COMP_NAME })
    .click();
  await expect(guide).toContainText("Completed: Make public");
  await expect(guide).toContainText("2 of 5 steps");
  await expect(page.getByText(/Anyone you send this page’s link to/)).toHaveCount(0);
  // Public now: the address bar settles on the clean URL, without the key.
  await expect
    .poll(() => idFromSegment(new URL(page.url()).pathname.split("/")[2]))
    .toBe(createdCompId);

  // Step 4: Create a task. Two "New task" links exist on an empty comp
  // (section header + the empty-state CTA in the section body); both go to
  // the page that creates one (#819).
  await page.getByRole("link", { name: "New task" }).first().click();
  await expect(page).toHaveURL(/\/task\/new$/);
  const taskForm = page.getByRole("main");
  await taskForm.getByRole("textbox", { name: "Name" }).fill("Day 1 - Ridge Run");
  // The Date field is a segmented picker (react-aria), not a native input, so
  // it can't be filled — type into its day segment; en-GB order is D/M/Y and
  // each segment auto-advances (15 → 04 → 2026 = 2026-04-15).
  const dateField = taskForm.getByRole("group", { name: "Date" });
  await dateField.getByRole("spinbutton", { name: /day/ }).click();
  await page.keyboard.type("15042026");
  // Pilot class checkboxes default to all checked (just "open")
  await taskForm.getByRole("button", { name: "Create" }).click();

  // Create goes to the task it made; the comp's trail leads back to the
  // guide. The task link is scoped to the Tasks section — the setup guide's
  // "Set the route for…" link also carries the task name.
  await expect(page.getByRole("heading", { level: 1, name: "Day 1 - Ridge Run" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: COMP_NAME })
    .click();
  await expect(
    page.locator("#tasks").getByRole("link", { name: /Day 1 - Ridge Run/ })
  ).toBeVisible();

  // A task without a route keeps step 5 active but adapts it to point at
  // the new task's route editor.
  await expect(guide).toContainText("Set the route for Day 1 - Ridge Run");

  // "Hide guide" dismisses the card (persisted per-comp in localStorage).
  await guide.getByRole("button", { name: "Hide guide" }).click();
  await expect(guide).toBeHidden();
});
