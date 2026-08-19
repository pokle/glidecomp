/**
 * RAC popover positioning on a SCROLLED page (rac-adoption-guide gotcha #22).
 *
 * React Aria positions body-portalled popovers with `position: absolute`
 * against the initial containing block, so the numbers it emits are only
 * correct while `body` is static. Both historical breakages produced the same
 * symptom — the trigger reports `aria-expanded="true"`, every option is in
 * the DOM, and the popover is thousands of pixels outside the viewport, so
 * clicking the control "does nothing":
 *
 * - `body { position: relative }` displaced upward-flipped popovers by
 *   `scrollHeight - innerHeight` (the CIVL ranking picker).
 * - The `fixed!` patch for that displaced every downward popover by
 *   `scrollY` (the manual-flight dialog's turnpoint select, which lives far
 *   down the task page).
 *
 * This spec drives that second, scrolled case end to end. It used to go
 * through the manual-flight DIALOG, which is a routed page since #637 and
 * whose turnpoint select is a list in flow — so the control it drives is now
 * the manage table's per-row pilot-status select, which sits at the same
 * depth on the same page and is still a popover on purpose: it is a row
 * action, not a form field, and a list in flow would blow the row apart.
 *
 * That swap costs the spec nothing. What is under test is where RAC puts a
 * body-portalled popover on a scrolled page, which is a property of the kit
 * and the document, not of the control that opened it — and dropping the
 * dialog makes the precondition (scrollY > 0 at the moment of opening) more
 * direct rather than less.
 *
 * The one assertion that matters is geometric — the open listbox must land
 * inside the viewport. Asserting mere visibility would pass either bug:
 * Playwright's visibility check does not require the element to be on-screen.
 */
import { test, expect, type APIRequestContext } from "./fixtures/test";
import { resolve, dirname } from "path";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { FRONTEND_URL, SUPER_ADMIN, e2eCompName } from "./fixtures/stack";

const BASE_URL = FRONTEND_URL;
const SAMPLE_XCTSK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4/task.xctsk"
);

// Short viewport so even a modest task page scrolls; the bug only shows when
// window.scrollY > 0 at the moment the popover opens.
test.use({ viewport: { width: 1280, height: 500 } });

test.describe("select popover on a scrolled task page", () => {
  let admin: APIRequestContext;
  let compId: string;
  let taskId: string;

  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE_URL });
    const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    expect(signIn.ok(), "super admin dev-login").toBeTruthy();

    const compRes = await admin.post("/api/comp", {
      data: { name: e2eCompName("popover"), category: "hg", pilot_classes: ["open"] },
    });
    expect(compRes.ok()).toBeTruthy();
    compId = ((await compRes.json()) as { comp_id: string }).comp_id;

    // The status select needs a pilot row in the manage table; the task is
    // routed so the table renders its full set of row actions.
    const xctsk = JSON.parse(await readFile(SAMPLE_XCTSK, "utf8")) as unknown;
    const taskRes = await admin.post(`/api/comp/${compId}/task`, {
      data: {
        name: "Routed Task",
        task_date: new Date().toISOString().slice(0, 10),
        pilot_classes: ["open"],
        xctsk,
      },
    });
    expect(taskRes.ok()).toBeTruthy();
    taskId = ((await taskRes.json()) as { task_id: string }).task_id;

    const pilotRes = await admin.post(`/api/comp/${compId}/pilot`, {
      data: { registered_pilot_name: "Popova E2E", pilot_class: "open" },
    });
    expect(pilotRes.ok()).toBeTruthy();
  });

  test.afterAll(async () => {
    if (compId) await admin.delete(`/api/comp/${compId}`);
    await admin.dispose();
  });

  test("a row select opens inside the viewport", async ({ page }) => {
    // Same cookie plumbing as settings-save-ux.spec.ts: dev-login through the
    // page's own request context so the browser holds the session.
    const login = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    expect(login.ok()).toBeTruthy();

    await page.goto(`${BASE_URL}/comp/${compId}/task/${taskId}`);

    const status = page.getByRole("button", { name: "Status for Popova E2E" });
    await status.scrollIntoViewIfNeeded();
    // The precondition that makes this test mean anything: the page is
    // scrolled. At scrollY 0 both historical bugs are invisible.
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await status.click();

    const listbox = page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    const box = await listbox.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box, "open listbox has a bounding box").not.toBeNull();
    // The geometric assertion: fully inside the viewport, not merely rendered.
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);

    // And it works as a control, not just as a rectangle: picking an option
    // updates the field.
    await listbox.getByRole("option", { name: "Absent" }).click();
    await expect(status).toContainText("Absent");
  });
});
