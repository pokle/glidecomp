/**
 * The 3D replay's page bar (issue #869): the app's three slots in plain
 * markup (web/frontend/src/replay.html, `setupPageBar` in replay/main.ts),
 * floating over the scene.
 *
 * What this spec pins, at a desktop width and on a phone (it is in
 * MOBILE_SPEC_FILES, e2e/fixtures/mobile.ts):
 * - Back leads to the task the replay belongs to, named, and to Home for the
 *   sample, which belongs to no task;
 * - the title menu lists the trail and this page, closes on Escape, and a
 *   tap on the scene that closes it does not also start playback;
 * - the page has one <h1>, and the trail is in the markup as real links;
 * - every control in the bar and every row of its menu is 44 px, and on a
 *   coarse pointer so is every control in the drawer (#860 §1);
 * - nothing scrolls sideways, the timeline row included.
 *
 * The bar is drawn before the viewer loads, so nothing here waits on WebGL.
 * Mutation-free: it reads the seeded sample comp (seeded here if the store is
 * cold), as trusted-types.spec.ts does.
 */
import { execSync } from "node:child_process";
import { test, expect, type Locator, type Page } from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { FRONTEND_URL } from "./fixtures/stack";
import { SAMPLE_COMP_NAME } from "../web/workers/competition-api/src/sample";

/** The floor: a control a finger can hit. Half a pixel of slack for rounding. */
const TARGET = 43.5;

let compId: string;
let taskId: string;
let taskName: string;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const list = async () => {
    const res = await api.get("/api/comp");
    return res.ok() ? ((await res.json()) as { comps: Array<{ comp_id: string; name: string }> }).comps : [];
  };
  let comp = (await list()).find((c) => c.name === SAMPLE_COMP_NAME);
  if (!comp) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    comp = (await list()).find((c) => c.name === SAMPLE_COMP_NAME);
  }
  expect(comp, "the seeded sample comp").toBeDefined();
  compId = comp!.comp_id;
  const detail = (await (await api.get(`/api/comp/${compId}`)).json()) as {
    tasks: Array<{ task_id: string; name: string }>;
  };
  taskId = detail.tasks[0].task_id;
  taskName = detail.tasks[0].name;
  await api.dispose();
});

async function expectTarget(control: Locator, what: string): Promise<void> {
  await expect(control, `${what} must be on screen`).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${what} must be on screen`).not.toBeNull();
  expect(box!.width, `${what} must be 44 px wide or more`).toBeGreaterThanOrEqual(TARGET);
  expect(box!.height, `${what} must be 44 px tall or more`).toBeGreaterThanOrEqual(TARGET);
}

const back = (page: Page) => page.locator("#barBack");
const title = (page: Page) => page.locator("#barTitle");
const menu = (page: Page) => page.locator("#barMenu nav");

async function openTaskReplay(page: Page): Promise<void> {
  await page.goto(`/replay?comp=${compId}&task=${taskId}`);
  // Named once the comp fetch answers; the link works before that.
  await expect(back(page)).toHaveAttribute("aria-label", `Back to ${taskName}`);
}

test.describe("the 3D replay's page bar", () => {
  test("Back leads to the task, and the title menu holds the trail", async ({ page }) => {
    await openTaskReplay(page);
    await expect(back(page)).toHaveAttribute("href", new RegExp(`/comp/[^/]*${compId}/task/[^/]*${taskId}$`));

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("3D replay");
    // The trail as real links with the menu closed (accessibility standard §4.3).
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link");
    await expect(crumbs).toHaveText(["Competitions", SAMPLE_COMP_NAME, taskName]);

    await title(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole("link", { name: taskName })).toBeVisible();
    await expect(menu(page).locator('[aria-current="page"]')).toHaveText("3D replay");
    // Competitions is in the trail, so "Elsewhere" does not repeat it.
    await expect(menu(page).getByRole("link", { name: "Competitions" })).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
    await expect(title(page)).toBeFocused();
  });

  test("a tap on the scene that closes the menu does not start playback", async ({ page }) => {
    await openTaskReplay(page);
    await expect(page.locator("#playPause")).toHaveText("▶");
    await title(page).click();
    await expect(menu(page)).toBeVisible();
    // The scene at its left edge: clear of the bar, the open menu (centred
    // under the title) and the timeline.
    const size = page.viewportSize()!;
    await page.mouse.click(24, size.height * 0.6);
    await expect(menu(page)).toBeHidden();
    await expect(page.locator("#playPause")).toHaveText("▶");
  });

  test("the sample replay's Back leads Home", async ({ page }) => {
    await page.goto("/replay");
    await expect(back(page)).toHaveAttribute("href", "/");
    await expect(back(page)).toHaveAttribute("aria-label", "Back to Home");
  });

  test("every control in the bar, its menu and the drawer is a target", async ({ page }) => {
    await openTaskReplay(page);
    await expectTarget(back(page), "Back");
    await expectTarget(title(page), "The title");
    await expectTarget(page.locator("#menuToggle"), "⋯");

    await title(page).click();
    const rows = menu(page).locator(".bar-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if (await row.isVisible()) await expectTarget(row, `Title menu row ${i + 1}`);
    }
    await page.keyboard.press("Escape");

    await expectTarget(page.locator("#playPause"), "Play");
    await expectNoSidewaysScroll(page, "the replay");
    const timelineOverflow = await page
      .locator("#timeline")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(timelineOverflow, "the timeline row must fit the screen").toBeLessThanOrEqual(0);

    // On a coarse pointer the drawer's controls are 44 px too (#860 §1). A
    // mouse is precise at 24 px, which the drawer's controls also clear.
    const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    await page.locator("#menuToggle").click();
    await expect(page.locator("#menuClose")).toBeFocused();
    // Wait for the pilot list, which the viewer fills once tracks are in.
    await expect(page.locator("#legend li").first()).toBeVisible({ timeout: 60_000 });
    // A checkbox's target is its label. Measured in one call: the scene keeps
    // the page busy, and one round trip per control is a minute.
    const floor = coarse ? TARGET : 23.5;
    const small = await page.locator("#menuPanel").evaluate((panel, min) => {
      const controls = panel.querySelectorAll<HTMLElement>(
        "button, select, input:not([type=checkbox]), label:has(input[type=checkbox])",
      );
      const out: string[] = [];
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // hidden (a section with no data)
        if (r.width < min || r.height < min) {
          out.push(`${el.tagName.toLowerCase()}#${el.id} "${el.textContent?.trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      return out;
    }, floor);
    expect(small, `drawer controls under ${Math.round(floor)} px`).toEqual([]);
  });
});
