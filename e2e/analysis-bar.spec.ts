/**
 * The analysis page's bar (issue #869): the app's three slots in plain
 * markup (web/frontend/src/analysis.html `#page-bar`, analysis/page-bar.ts),
 * floating over the map.
 *
 * What this spec pins, at a desktop width and on a phone (it is in
 * MOBILE_SPEC_FILES, e2e/fixtures/mobile.ts):
 * - from a report card's link, Back is that pilot's report card, and the
 *   trail names the competition, the task and the pilot;
 * - the page has one <h1>, "Map", and the trail is in the markup as links;
 * - ⋯ is a plain menu: a Show row ticks and unticks, writes the URL, and
 *   closes the menu; ⌘K opens it; Escape closes it and gives focus back;
 * - "Analysis" opens the side panel and says so, and on a wide screen the
 *   bar keeps clear of the open panel;
 * - an anonymous reader is not offered the rows that would send them to sign
 *   in (the samples, My Flights in ⋯);
 * - every control in the bar and its menus is 44 px, and on a coarse
 *   pointer so is every control the map and the panel show (#860 §1).
 *
 * Signed out throughout: the report card's link is the one URL shape the
 * page opens for anonymously (`isPublicCompLink`), and it is the way most
 * readers arrive. Mutation-free: it reads the seeded sample comp (seeded
 * here if the store is cold), as trusted-types.spec.ts does.
 */
import { execSync } from "node:child_process";
import { test, expect, PHONE_ONLY, type Locator, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";
import { installMapbox } from "./fixtures/mapbox";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { SAMPLE_COMP_NAME } from "../web/workers/competition-api/src/sample";

/** The floor: a control a finger can hit. Half a pixel of slack for rounding. */
const TARGET = 43.5;

let compId: string;
let taskId: string;
let taskName: string;
let pilotId: string;
let pilotName: string;

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
  const { tracks } = (await (await api.get(`/api/comp/${compId}/task/${taskId}/igc`)).json()) as {
    tracks: Array<{ comp_pilot_id: string; pilot_name: string }>;
  };
  pilotId = tracks[0].comp_pilot_id;
  pilotName = tracks[0].pilot_name;
  await api.dispose();
});

async function expectTarget(control: Locator, what: string): Promise<void> {
  await expect(control, `${what} must be on screen`).toBeVisible();
  const box = await control.boundingBox();
  expect(box, `${what} must be on screen`).not.toBeNull();
  expect(box!.width, `${what} must be 44 px wide or more`).toBeGreaterThanOrEqual(TARGET);
  expect(box!.height, `${what} must be 44 px tall or more`).toBeGreaterThanOrEqual(TARGET);
}

const more = (page: Page) => page.locator("#bar-more");
/** ⋯ itself: the menu's own summary, not "Samples…" inside it. */
const dots = (page: Page) => page.locator("#bar-more > summary");
const title = (page: Page) => page.locator("#bar-title");

/** The report card's link: one pilot's track, signed out. */
async function openFromReportCard(page: Page): Promise<void> {
  await page.goto(`/analysis?compId=${compId}&taskId=${taskId}&pilotId=${pilotId}`);
  // Named once the task resolves; the links work before that.
  await expect(page.locator("#bar-back")).toHaveAttribute("aria-label", `Back to ${pilotName}`, {
    timeout: 60_000,
  });
}

test.describe("the analysis page's bar", () => {
  test("Back leads to the report card, and the title menu holds the trail", async ({ page, context }) => {
    await installMapbox(context);
    await openFromReportCard(page);
    await expect(page.locator("#bar-back")).toHaveAttribute(
      "href",
      new RegExp(`/comp/[^/]*${compId}/task/[^/]*${taskId}/pilot/[^/]*${pilotId}$`),
    );

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Map");
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link");
    await expect(crumbs).toHaveText(["Competitions", SAMPLE_COMP_NAME, taskName, pilotName]);

    await title(page).click();
    const pages = page.getByRole("navigation", { name: "Pages" });
    await expect(pages).toBeVisible();
    await expect(pages.getByRole("link", { name: pilotName })).toBeVisible();
    await expect(pages.locator('[aria-current="page"]')).toHaveText("Map");
    // Competitions is in the trail, so "Elsewhere" does not repeat it.
    await expect(pages.getByRole("link", { name: "Competitions" })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(pages).toBeHidden();
    await expect(title(page)).toBeFocused();
  });

  test("⋯ is a plain menu: a Show row ticks, writes the URL and closes it", async ({ page, context }) => {
    await installMapbox(context);
    await openFromReportCard(page);

    const track = page.locator("#menu-toggle-track");
    await dots(page).click();
    await expect(track).toBeVisible();
    await expect(track).toHaveAttribute("aria-pressed", "true");
    await track.click();
    await expect(more(page)).not.toHaveAttribute("open", "");
    await expect(page).toHaveURL(/track-visible=0/);
    await dots(page).click();
    await expect(track).toHaveAttribute("aria-pressed", "false");

    // Escape closes it and gives focus back to ⋯.
    await page.keyboard.press("Escape");
    await expect(more(page)).not.toHaveAttribute("open", "");
    await expect(dots(page)).toBeFocused();

    // ⌘K / Ctrl+K opens it, focused on its first row.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(more(page)).toHaveAttribute("open", "");
    await expect(page.locator("#menu-toggle-task")).toBeFocused();
    await page.keyboard.press("Escape");

    // A reader with no session is not offered what would send them to sign in.
    await dots(page).click();
    await expect(page.locator("#bar-samples")).toBeHidden();
    await expect(more(page).getByRole("link", { name: "My Flights" })).toBeHidden();
    await expect(page.locator("#menu-open-igc")).toBeVisible();
  });

  test("Analysis opens the panel, and the bar keeps clear of it", async ({ page, context }) => {
    await installMapbox(context);
    await openFromReportCard(page);
    const toggle = page.getByRole("button", { name: "Analysis", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(page.locator("#waypoint-sidebar")).toHaveAttribute("aria-hidden", "false");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    // On a wide screen the panel sits beside the map: ⋯ is left of it, not under it.
    const wide = (page.viewportSize()?.width ?? 0) >= 768;
    if (wide) {
      await expect
        .poll(async () => {
          const button = await dots(page).boundingBox();
          const panel = await page.locator("#waypoint-sidebar").boundingBox();
          return button && panel ? panel.x - (button.x + button.width) : -1;
        })
        .toBeGreaterThanOrEqual(0);
    }
  });

  test("every control in the bar and its menus is a 44 px target", async ({ page, context }) => {
    await installMapbox(context);
    await openFromReportCard(page);
    await expectTarget(page.locator("#bar-back"), "Back");
    await expectTarget(title(page), "The title");
    await expectTarget(page.getByRole("button", { name: "Analysis", exact: true }), "Analysis");
    await expectTarget(dots(page), "⋯");

    await dots(page).click();
    const rows = more(page).locator(".bar-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if (await row.isVisible()) await expectTarget(row, `⋯ row ${i + 1}`);
    }
    await page.keyboard.press("Escape");
    await expectNoSidewaysScroll(page, "the analysis page");

  });

  // On a coarse pointer, the map's controls and the panel's are 44 px too
  // (#860 §1); a mouse is held to 24 px. The Mapbox logo is the vendor's, and
  // its terms keep it as it is.
  test("on a phone, every control on the map and in the panel is a target", { tag: PHONE_ONLY }, async ({ page, context }) => {
    await installMapbox(context);
    await openFromReportCard(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a coarse pointer").toBe(true);
    await page.getByRole("button", { name: "Analysis", exact: true }).click();
    await expect(page.locator("#waypoint-sidebar")).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator(".mapboxgl-ctrl-zoom-in")).toBeVisible({ timeout: 30_000 });
    // The panel slides open (a width transition): measure what it holds once it
    // has stopped, or every row reads as a sliver.
    const sidebar = page.locator("#waypoint-sidebar");
    let last = -1;
    await expect
      .poll(async () => {
        const w = (await sidebar.boundingBox())?.width ?? 0;
        const settled = w > 100 && w === last;
        last = w;
        return settled;
      }, { intervals: [200] })
      .toBe(true);
    // Measured in one call: one round trip per control is slow on a busy map.
    const small = await page.evaluate((min) => {
      const out: string[] = [];
      const controls = document.querySelectorAll<HTMLElement>(
        "#map button, #map select, #map a:not(.mapboxgl-ctrl-logo), #waypoint-sidebar button, #waypoint-sidebar [role=tab]",
      );
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // not shown in this state
        // A small control may be widened by an invisible hit area (`touch-target`).
        const after = getComputedStyle(el, "::after");
        const hitW = after.position === "absolute" ? Math.max(r.width, parseFloat(after.width) || 0) : r.width;
        const hitH = after.position === "absolute" ? Math.max(r.height, parseFloat(after.height) || 0) : r.height;
        if (hitW < min || hitH < min) {
          const name = el.getAttribute("aria-label") || el.title || el.textContent?.trim().slice(0, 20);
          out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(hitW)}×${Math.round(hitH)}`);
        }
      }
      return out;
    }, TARGET);
    expect(small, "controls under 44 px on a coarse pointer").toEqual([]);
  });
});
