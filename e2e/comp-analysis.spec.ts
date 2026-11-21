/**
 * The comp analysis page's way into each task analysis, and its class picker.
 *
 * What this pins, at a desktop width and on a phone (it is in
 * MOBILE_SPEC_FILES, e2e/fixtures/mobile.ts):
 * - "Task analyses" lists the class being read and no other. The sample comp
 *   sets one task per class per day, and both classes label theirs "T1", so
 *   the old "Per task:" links offered an Open reader the Floater tasks too;
 * - every entry is a link at least 44 px each way. They were inline text
 *   links 20 px tall on a phone;
 * - on a phone the entries are rows the width of the list; on a desktop they
 *   are tiles side by side. Same markup, so the difference is all CSS and
 *   nothing else would catch it going;
 * - the class picker is a segmented control (a radio group) in the bar's
 *   second layer, 44 px, and choosing a class writes `?class=` and swaps
 *   the list.
 *
 * Read-only against the seeded sample comp (seeded here if the store is
 * cold). Never waits on "networkidle": the page keeps a freshness poll going.
 */
import { execSync } from "node:child_process";
import { test, expect, PHONE_ONLY, DESKTOP_ONLY, type Locator, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { SAMPLE_COMP_NAME } from "../web/workers/competition-api/src/sample";

/** The floor: a control a finger can hit. Half a pixel of slack for rounding. */
const TARGET = 43.5;

type ClassTasks = { pilot_class: string; tasks: Array<{ task_id: string }> };

let compId: string;
let classes: ClassTasks[] = [];

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const list = async () => {
    const res = await api.get("/api/comp");
    return res.ok()
      ? ((await res.json()) as { comps: Array<{ comp_id: string; name: string }> }).comps
      : [];
  };
  let comp = (await list()).find((c) => c.name === SAMPLE_COMP_NAME);
  if (!comp) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    comp = (await list()).find((c) => c.name === SAMPLE_COMP_NAME);
  }
  expect(comp, "the seeded sample comp").toBeDefined();
  compId = comp!.comp_id;

  // Reading the comp aggregate schedules every cold task, so polling it is
  // also what warms it. Wait for everything, so the list is the whole class.
  for (let i = 0; i < 90; i++) {
    const res = await api.get(`/api/comp/${compId}/analysis`);
    if (res.ok()) {
      const body = (await res.json()) as { classes: ClassTasks[]; pending_task_count: number };
      classes = body.classes;
      if (body.pending_task_count === 0) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect(classes.length, "a warm class in the comp aggregate").toBeGreaterThan(0);
  await api.dispose();
});

const taskList = (page: Page) => page.getByRole("navigation", { name: "Task analyses" });
const taskLinks = (page: Page) => taskList(page).getByRole("link");

async function expectTarget(control: Locator, what: string): Promise<void> {
  const box = await control.boundingBox();
  expect(box, `${what} must be on screen`).not.toBeNull();
  expect(box!.width, `${what} must be 44 px wide or more`).toBeGreaterThanOrEqual(TARGET);
  expect(box!.height, `${what} must be 44 px tall or more`).toBeGreaterThanOrEqual(TARGET);
}

/** The links name exactly this class's tasks, in its order. */
async function expectClassTasks(page: Page, cls: ClassTasks): Promise<void> {
  await expect(taskLinks(page)).toHaveCount(cls.tasks.length);
  const hrefs = await taskLinks(page).evaluateAll((as) =>
    as.map((a) => a.getAttribute("href") ?? "")
  );
  hrefs.forEach((href, i) => {
    expect(href, `entry ${i + 1} opens ${cls.pilot_class}'s task`).toMatch(
      new RegExp(`-${cls.tasks[i].task_id}/analysis$`)
    );
  });
}

test("lists only the class being read, as 44 px links, and the picker switches class", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/analysis`);
  await expect(taskList(page)).toBeVisible();
  await expectClassTasks(page, classes[0]);
  for (const [i, link] of (await taskLinks(page).all()).entries()) {
    await expectTarget(link, `task analysis ${i + 1}`);
  }

  test.skip(classes.length < 2, "one warm class — nothing to switch to");

  const picker = page.getByRole("radiogroup", { name: "Pilot class" });
  await expect(picker).toBeVisible();
  const first = picker.getByRole("radio", { name: classes[0].pilot_class, exact: true });
  const second = picker.getByRole("radio", { name: classes[1].pilot_class, exact: true });
  await expect(first).toBeChecked();
  await expectTarget(second, `the ${classes[1].pilot_class} segment`);

  await second.click();
  await expect(second).toBeChecked();
  await expect(page).toHaveURL(
    new RegExp(`[?&]class=${encodeURIComponent(classes[1].pilot_class)}(&|$)`)
  );
  await expectClassTasks(page, classes[1]);
});

test("on a phone, each task analysis is a row the width of the list", { tag: PHONE_ONLY }, async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/analysis`);
  await expect(taskList(page)).toBeVisible();
  const list = await taskList(page).getByRole("list").boundingBox();
  expect(list).not.toBeNull();
  for (const link of await taskLinks(page).all()) {
    const box = (await link.boundingBox())!;
    // A row, not a tile: its whole width is the target. Borders aside.
    expect(box.width).toBeGreaterThanOrEqual(list!.width - 4);
  }
  await expectNoSidewaysScroll(page);
});

test("on a desktop, the task analyses are tiles side by side", { tag: DESKTOP_ONLY }, async ({
  page,
}) => {
  test.skip(classes[0].tasks.length < 2, "one task — nothing to sit beside");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/comp/${compId}/analysis`);
  await expect(taskList(page)).toBeVisible();
  const [a, b] = await taskLinks(page).all();
  const boxA = (await a.boundingBox())!;
  const boxB = (await b.boundingBox())!;
  expect(Math.abs(boxA.y - boxB.y), "the first two tiles share a row").toBeLessThan(1);
  expect(boxB.x).toBeGreaterThan(boxA.x + boxA.width);
});

test("the bar's back goes where the browser's Back goes: to the comp analysis, not up to the task", async ({
  page,
}) => {
  // Found on a phone on 21 November 2026. From the comp analysis into a
  // task's analysis, the browser's Back returned to the comp analysis and
  // the bar's back went UP, to the task page. The bar's back was a real Back
  // only where the link that opened the page had been marked for it in code,
  // and this one had not. It asks the history now (lib/leave.ts).
  await page.goto(`/comp/${compId}/analysis`);
  await expect(taskList(page)).toBeVisible();
  const from = new URL(page.url()).pathname;
  await taskLinks(page).first().click();
  await expect(page).toHaveURL(/\/task\/[^/]+\/analysis$/);

  // Named for where it goes, and it goes there.
  const back = page.locator("[data-bar-back]");
  await expect(back).toHaveAccessibleName("Back to Comp analysis");
  await back.click();
  await expect(taskList(page)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(from);
  // A real Back, so Forward returns to the task's analysis.
  await page.goForward();
  await expect(page).toHaveURL(/\/task\/[^/]+\/analysis$/);

  // Arrived at directly, with nothing of ours behind it: the bar's back goes
  // to the page above, the task, where the browser's Back would leave the
  // site (and the installed app has no Back at all).
  const direct = await page.context().newPage();
  await direct.goto(page.url());
  const up = direct.locator("[data-bar-back]");
  await expect(up).toHaveAccessibleName(/^Back to (?!Comp analysis)/);
  await up.click();
  await expect(direct).toHaveURL(/\/task\/[^/]+$/);
  await direct.close();
});
