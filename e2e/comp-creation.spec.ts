import { test, expect } from "./fixtures/test";
import { idFromSegment } from "../web/frontend/src/react/lib/slug";
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

test("dev login, create competition and task", async ({ page }) => {
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

  // Step 3: Create a competition. The "Start a new competition" button renders
  // once the signed-in user resolves; click auto-waits.
  await page.getByRole("button", { name: "Start a new competition" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Name").fill(COMP_NAME);
  // Category defaults to HG — no change needed. Mark it hidden (admins only).
  // RAC checkboxes visually hide the real <input>, so clicking the checkbox
  // role times out on actionability — click the visible label like a user.
  await createDialog.getByText("Hidden?").click();
  await expect(createDialog.getByRole("checkbox", { name: /Hidden/ })).toBeChecked();
  await createDialog.getByRole("button", { name: "Create" }).click();

  // Client-side navigation to the competition detail page; the heading
  // assertion polls until the comp fetch resolves.
  await page.waitForURL("**/comp/*");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(COMP_NAME);
  // Capture the id for afterEach's cleanup. The path segment is the canonical
  // `${name-slug}-${id}` form, so take the id off the end rather than the whole
  // segment — the API only accepts the bare sqid.
  createdCompId = idFromSegment(new URL(page.url()).pathname.split("/")[2]);

  // Step 3b: The admin-only setup guide shows on a fresh comp with step 1
  // ("Create the competition") pre-checked. The progress count is over the
  // four *required* steps — "Review settings" is optional (issue #343: new
  // comps already start from the official defaults), so it doesn't count.
  const guide = page.getByRole("region", { name: "Set up your competition" });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("1 of 4 steps");

  // Saving settings (defaults untouched) counts as reviewing them, ticking the
  // optional "Review settings" step over. Being optional, it doesn't move the
  // required-step counter — the count stays "1 of 4". Settings is a hierarchy
  // of pages now: index → a group page → Save → back to the index → back to
  // the comp.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "General" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  // The save lands back on the settings index; return to the comp page.
  await expect(page.getByRole("link", { name: "General" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: COMP_NAME })
    .click();
  await expect(guide).toContainText("Completed: Review settings");
  await expect(guide).toContainText("1 of 4 steps");

  // Step 4: Create a task. Two "New Task" buttons exist on an empty comp
  // (section header + the empty-state CTA in the section body).
  await page.getByRole("button", { name: "New Task" }).first().click();
  const taskDialog = page.getByRole("dialog");
  await taskDialog.getByLabel("Name").fill("Day 1 - Ridge Run");
  // The Date field is a segmented picker (react-aria), not a native input, so
  // it can't be filled — type into its day segment; en-GB order is D/M/Y and
  // each segment auto-advances (15 → 04 → 2026 = 2026-04-15).
  const dateField = taskDialog.getByRole("group", { name: "Date" });
  await dateField.getByRole("spinbutton", { name: /day/ }).click();
  await page.keyboard.type("15042026");
  // Pilot class checkboxes default to all checked (just "open")
  await taskDialog.getByRole("button", { name: "Create" }).click();

  // A successful create closes the dialog and re-fetches the comp; the task
  // link assertion polls until the refreshed task list renders. Scoped to
  // the Tasks section — the setup guide's "Set the route for…" link also
  // carries the task name.
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
