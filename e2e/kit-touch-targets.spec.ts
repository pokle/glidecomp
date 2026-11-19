/**
 * The kit's small controls on a phone (issue #860 §2): each is a target a
 * finger can hit, 44 px on its smallest side (accessibility standard §4.5).
 *
 * Measured here on the public pages that show them: a tag that can be
 * selected, a checkbox's label and a combo-box field on "Who flew like me?",
 * a disclosure's header on Metric details, and the time that switches time
 * zone on the task page. The date field is measured where an organiser meets
 * it, in task-settings-pages.spec.ts.
 *
 * Sizes are measured, never read from classes: tailwind-merge does not
 * resolve `size-*` against `h-*`, so a class can be present over a 28 px box.
 * A control that is widened by the `touch-target` utility paints nothing
 * bigger, so it is measured by what a point 20 px from its centre hits.
 *
 * PHONE ONLY: with a mouse these controls are meant to stay small.
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp.
 */
import { execSync } from "node:child_process";
import { test, expect, PHONE_ONLY, type Locator } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";
import { expectNoSidewaysScroll } from "./fixtures/layout";

const COMP_NAME = "Corryong Cup 2026";
/** The floor, with half a pixel of slack for rounding. */
const TARGET = 43.5;

let compId: string;
let taskId: string;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const findComp = async (): Promise<string | null> => {
    const res = await api.get("/api/comp");
    if (!res.ok()) return null;
    const { comps } = (await res.json()) as {
      comps: Array<{ comp_id: string; name: string }>;
    };
    return comps.find((c) => c.name === COMP_NAME)?.comp_id ?? null;
  };
  let found = await findComp();
  if (!found) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    found = await findComp();
  }
  if (!found) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  compId = found;
  const detail = await api.get(`/api/comp/${compId}`);
  const { tasks } = (await detail.json()) as { tasks: Array<{ task_id: string }> };
  taskId = tasks[0].task_id;
  // Never computed on the read path: poll the report warm.
  for (let i = 0; i < 60; i++) {
    const res = await api.get(`/api/comp/${compId}/task/${taskId}/analysis`);
    if (res.ok() && !((await res.json()) as { pending?: boolean }).pending) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await api.dispose();
});

async function expectTarget(control: Locator, what: string) {
  const box = await control.boundingBox();
  expect(box, `${what} is on screen`).not.toBeNull();
  expect(box!.width, `${what} is 44 px wide or more`).toBeGreaterThanOrEqual(TARGET);
  expect(box!.height, `${what} is 44 px tall or more`).toBeGreaterThanOrEqual(TARGET);
}

test("tags, checkboxes and the combo box on Who flew like me?", { tag: PHONE_ONLY }, async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/similar`, {
    waitUntil: "domcontentloaded",
  });
  const tags = page.locator('[role="row"][data-selection-mode]');
  await expect(tags.first()).toBeVisible({ timeout: 60_000 });
  expect(await tags.count()).toBeGreaterThan(5);
  for (const tag of await tags.all()) await expectTarget(tag, `tag ${await tag.innerText()}`);

  // A checkbox is its label: the whole row of it is what a finger hits.
  const families = page.locator("label").filter({ has: page.getByRole("checkbox") });
  expect(await families.count()).toBeGreaterThan(2);
  for (const family of await families.all()) {
    await expectTarget(family, `checkbox ${await family.innerText()}`);
  }

  await expectTarget(page.getByRole("combobox").first(), "the pilot field");
  await expectNoSidewaysScroll(page);
});

test("a disclosure's header on Metric details", { tag: PHONE_ONLY }, async ({ page }) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/metrics`, {
    waitUntil: "domcontentloaded",
  });
  const headers = page.locator('[id^="family-"] > div > * > button[slot="trigger"]');
  await expect(headers.first()).toBeVisible({ timeout: 60_000 });
  expect(await headers.count()).toBeGreaterThan(2);
  for (const header of await headers.all()) {
    await expectTarget(header, `the ${await header.innerText()} header`);
  }
});

test("the time that switches time zone on the task page", { tag: PHONE_ONLY }, async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/task/${taskId}`, { waitUntil: "domcontentloaded" });
  const toggle = page.getByRole("button", { name: /Activate to change time zone\.$/ }).first();
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await toggle.scrollIntoViewIfNeeded();
  // It sits in a sentence, so it does not grow: its hit area does. A point
  // 20 px above or below its centre, well outside its line of text, is still
  // the toggle.
  const hits = await toggle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return [-20, 20].map((dy) => el.contains(document.elementFromPoint(cx, cy + dy)));
  });
  expect(hits).toEqual([true, true]);
});
