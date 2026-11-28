/**
 * The kit's small controls on a phone (issue #860 §2): each is a target a
 * finger can hit, 44 px on its smallest side (accessibility standard §4.5).
 *
 * Measured here on the public pages that show them: a row of a check list,
 * a checkbox's label and a combo-box field on "Who flew like me?",
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

test("the behaviour lists and the combo box on Who flew like me?", { tag: PHONE_ONLY }, async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/similar`, {
    waitUntil: "domcontentloaded",
  });

  // Each family is folded: its header, and a checkbox for the whole family
  // that says how many of its behaviours are chosen. A checkbox is its label:
  // the whole of it is what a finger hits.
  const families = page.locator("label").filter({ has: page.getByRole("checkbox", { name: /^All .* behaviours$/ }) });
  await expect(families.first()).toBeVisible({ timeout: 60_000 });
  expect(await families.count()).toBeGreaterThan(2);
  for (const family of await families.all()) {
    await expectTarget(family, `checkbox ${await family.innerText()}`);
  }

  // Open, a family is a row for each behaviour, with its full name and never
  // the engine's table code. A name wraps; it is not cut and does not run off.
  await page.getByRole("button", { name: "Gliding", exact: true }).click();
  const rows = page.getByRole("group", { name: "Gliding behaviours" }).locator("label");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(2);
  for (const row of await rows.all()) await expectTarget(row, `row ${await row.innerText()}`);
  await expect(rows.first()).toContainText("Glide speed between climbs");
  await expect(page.getByRole("group", { name: "Gliding behaviours" })).not.toContainText("GlideSpd");

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

test("the report card's map button, time slider and flight steps", { tag: PHONE_ONLY }, async ({
  page,
  request,
}) => {
  // Any pilot of the task will do: the first id the scores name.
  const scores = await (await request.get(`/api/comp/${compId}/task/${taskId}/score`)).json();
  const findPilot = (o: unknown): string | null => {
    if (Array.isArray(o)) {
      for (const v of o) {
        const found = findPilot(v);
        if (found) return found;
      }
    } else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if ((k === "comp_pilot_id" || k === "pilot_id") && typeof v === "string") return v;
        const found = findPilot(v);
        if (found) return found;
      }
    }
    return null;
  };
  const pilotId = findPilot(scores);
  expect(pilotId, "the scores name a pilot").toBeTruthy();

  await page.goto(`/comp/${compId}/task/${taskId}/pilot/${pilotId}`, {
    waitUntil: "domcontentloaded",
  });
  // On a phone the map is a floating window. Its button and its grabber
  // are a finger wide at both sizes; the slider and the way to the
  // full-size page are on the large one.
  const enlarge = page.getByRole("button", { name: "Enlarge map" });
  await enlarge.waitFor({ timeout: 60_000 });
  await expectTarget(enlarge, "the small window's button");
  await expectTarget(page.getByRole("button", { name: "Move or hide map" }), "the small window's grabber");
  await enlarge.click();
  // The window grows by an animation; a box read during it is scaled.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-floating="large"]');
    return el != null && el.getAnimations().length === 0;
  });
  await expectTarget(page.getByRole("button", { name: "Move or hide map" }), "the window's grabber");
  await expectTarget(page.getByRole("button", { name: "Make map smaller" }), "the window's smaller button");

  // A link: the map at full size is a page of its own (#870).
  const expand = page.getByRole("link", { name: "Expand map" });
  await expand.waitFor({ timeout: 60_000 });
  await expectTarget(expand, "the map's expand button");

  // The slider arrives with the tracklog.
  const slider = page.getByRole("slider", { name: "Flight time" });
  await slider.waitFor({ timeout: 60_000 });
  expect((await slider.boundingBox())!.height, "the time slider is 44 px tall").toBeGreaterThanOrEqual(
    TARGET
  );

  // A step of the flight that shows on the map is a row a finger can hit.
  const step = page.getByRole("button").and(page.locator('[title="Show on map"]')).first();
  await step.scrollIntoViewIfNeeded();
  await expectTarget(step, "a flight step");
});

test("the footer's links, and the single links of the content pages", { tag: PHONE_ONLY }, async ({
  page,
}) => {
  // The app's footer.
  await page.goto(`/comp/${compId}`, { waitUntil: "domcontentloaded" });
  const about = page.getByRole("contentinfo").getByRole("link", { name: "About", exact: true });
  await about.scrollIntoViewIfNeeded();
  await expectTarget(about, "About in the app's footer");

  // The content pages' footer, and the hero's link.
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expectTarget(
    page.getByRole("link", { name: /See a real comp's scores/ }),
    "the home page's link to a real competition"
  );
  const siteAbout = page.getByRole("contentinfo").getByRole("link", { name: "About", exact: true });
  await siteAbout.scrollIntoViewIfNeeded();
  await expectTarget(siteAbout, "About in the content pages' footer");

  // Copy is shown by script, so it is there once the page has run.
  await page.goto("/assistant", { waitUntil: "domcontentloaded" });
  const copy = page.getByRole("button", { name: "Copy" }).first();
  await copy.waitFor();
  await expectTarget(copy, "Copy on the assistant page");

  // A section's link to the specification paints 16 px tall and is widened
  // by `touch-target`: a point 18 px above its centre still hits it.
  await page.goto("/scoring/gap", { waitUntil: "domcontentloaded" });
  const spec = page.getByRole("link", { name: "FAI S7F §2", exact: true });
  await spec.scrollIntoViewIfNeeded();
  const hit = await spec.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 - 18));
  });
  expect(hit, "the specification link has a 44 px hit area").toBe(true);

  // And the page's long formulas fit a phone: neither scrolls sideways.
  const wide = await page
    .locator("p:has(.katex)")
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .filter((el) => el.scrollWidth > el.clientWidth + 1).length
    );
  expect(wide, "no formula is wider than its box").toBe(0);
});
