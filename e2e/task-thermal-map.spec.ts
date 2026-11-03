/**
 * The thermal map — one thermal's rose over the terrain it worked, at the size
 * of the screen — is a page under the thermals section (issue #816), where it
 * was a full-screen sheet over it. Part of the "No full-screen overlays" rule
 * in CLAUDE.md: a figure at full size is a page, with its own URL, left with
 * the browser's Back.
 *
 * What this spec pins:
 * - the section's maximise control is a LINK to
 *   `/analysis/thermals/map?thermal=<id>`, naming the thermal the pane shows;
 * - the page draws that thermal's rose, without scrolling sideways and with
 *   the figure no taller than the screen;
 * - a reload rebuilds it from the URL alone — the thermal, the backdrop and
 *   the report — where the sheet was handed all three in memory;
 * - Back returns to the section on the same thermal, with the backdrop still
 *   on and at the scroll it was left at (#844), and the restore control in
 *   the map's corner is that same Back;
 * - side by side, the section opens with its default thermal named in the URL
 *   and lit in the census, though it loads from a bare-id URL whose canonical
 *   replace used to wipe the seed (#845);
 * - opened from a shared link, restore goes to the section in place of the
 *   map page rather than leaving the site.
 *
 * In the `mobile` project too (e2e/fixtures/mobile.ts): the sheet was a fixed
 * layer, which is what misbehaved on a phone, and a phone is where the page
 * has to fit.
 *
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp, like
 * task-analysis.spec.ts: nothing is created, so nothing to clean up. Never
 * waits on "networkidle" — every task-analysis page keeps a freshness poll in
 * flight by design.
 *
 * Mapbox is blocked outright. The satellite style this map uses is not among
 * the recordings (e2e/fixtures/mapbox.ts), and nothing here is about the
 * imagery: what is asserted is the rose, the URL and the history, all of which
 * are ours. The map canvas mounts either way.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";
const THERMALS_HEADING = /The day's thermals/;
const ROSE = /Top-down lift rose/;
const MAP_PATH = /\/analysis\/thermals\/map\/?$/;
const SECTION_PATH = /\/analysis\/thermals\/?$/;

/** `/comp/<id>/task/<id>/analysis/thermals` for a task whose report has thermals. */
let sectionPath: string;

test.beforeAll(async ({ playwright }) => {
  // Seeding plus the cold task-analysis compute can both take a while.
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
  let compId = await findComp();
  if (!compId) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    compId = await findComp();
  }
  if (!compId) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);

  const detail = await api.get(`/api/comp/${compId}`);
  expect(detail.ok()).toBe(true);
  const { tasks } = (await detail.json()) as { tasks: Array<{ task_id: string }> };

  // A task analysis never computes on the read path: poll each report warm,
  // and take the first whose field shared a thermal.
  for (const t of tasks) {
    const url = `/api/comp/${compId}/task/${t.task_id}/analysis`;
    for (let i = 0; i < 60; i++) {
      const res = await api.get(url);
      if (res.ok()) {
        const body = (await res.json()) as {
          pending?: boolean;
          classes?: Array<{ report?: { thermals?: { shapes?: unknown[] } } }>;
        };
        if (!body.pending) {
          if ((body.classes?.[0]?.report?.thermals?.shapes?.length ?? 0) > 0) {
            sectionPath = `/comp/${compId}/task/${t.task_id}/analysis/thermals`;
          }
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (sectionPath) break;
  }
  await api.dispose();
  if (!sectionPath) throw new Error(`No task of "${COMP_NAME}" has reconstructed thermals`);
});

test.beforeEach(async ({ page }) => {
  await page.context().route(/^https:\/\/([a-z0-9-]+\.)*mapbox\.com\//, (route) => route.abort());
});

function thermalsCard(page: Page) {
  return page.locator("section", {
    has: page.getByRole("heading", { name: THERMALS_HEADING }),
  });
}

/** The detail pane, and the thermal it shows ("Thermal at 13:05"). */
function thermalPane(page: Page) {
  return thermalsCard(page).locator('[role="region"][aria-labelledby]').first();
}

/** The thermal the URL names, and the path it is on — compared by these,
 * never by the whole URL: the page settles its address bar on the canonical
 * `${slug}-${id}` segments once the names load. */
function urlState(page: Page): { path: string; thermal: string | null; map: string | null } {
  const url = new URL(page.url());
  return {
    path: url.pathname,
    thermal: url.searchParams.get("thermal"),
    map: url.searchParams.get("map"),
  };
}

/**
 * The section, on a thermal, with the backdrop on — the state the maximise
 * control exists in. Returns the pane's heading, "Thermal at HH:MM".
 */
async function openSectionWithMap(page: Page): Promise<string> {
  await page.goto(sectionPath, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: THERMALS_HEADING }).waitFor();
  const census = page.getByRole("grid", { name: "Reconstructed thermals" });
  if (await thermalPane(page).isVisible()) {
    // Side by side the pane is on screen from the start, showing the default
    // thermal — which the URL names and the census lights, even on this
    // bare-id URL that the page replaces with its canonical one (#845).
    await expect.poll(() => urlState(page).thermal).toBeTruthy();
    await expect(census.locator("tbody tr[aria-selected='true']")).toHaveCount(1);
  } else {
    // Stacked (a phone) the census is the view until a thermal is chosen,
    // and choosing one navigates to its detail.
    await census.locator("tbody tr").first().locator("th, td").first().click();
  }
  await expect(thermalPane(page)).toBeVisible();
  await expect.poll(() => urlState(page).thermal).toBeTruthy();
  const heading = (await thermalPane(page).locator("h3").first().innerText()).trim();
  const title = heading.split(" — ")[0];
  expect(title).toMatch(/^Thermal at /);

  const mapToggle = thermalsCard(page).getByRole("button", { name: "Map", exact: true });
  await mapToggle.click();
  await expect(mapToggle).toHaveAttribute("aria-pressed", "true");
  // URL state, so Back to here can return it as it was left.
  await expect.poll(() => urlState(page).map).toBe("1");
  return title;
}

/**
 * Back has put the page within a few pixels of `y`, and it stays there once
 * whatever loads late has landed — a restore that scrolled once and stopped
 * let late content above move the reader off it (#846).
 */
async function expectScrollRestoredTo(page: Page, y: number) {
  const offBy = async () => Math.abs((await page.evaluate(() => window.scrollY)) - y);
  await expect.poll(offBy).toBeLessThanOrEqual(3);
  await page.waitForTimeout(1000);
  expect(await offBy()).toBeLessThanOrEqual(3);
}

/** Nothing on the page reaches past the viewport's right edge. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("maximise is a link to the thermal map page: reload keeps it, Back returns", async ({
  page,
}) => {
  const title = await openSectionWithMap(page);
  const thermal = urlState(page).thermal;

  // A link, naming the thermal the pane shows — not a button opening a layer.
  const maximise = thermalsCard(page).getByRole("link", { name: "Maximise map" });
  await expect(maximise).toHaveAttribute("href", new RegExp(`/analysis/thermals/map\\?(.*&)?thermal=${thermal}(&|$)`));
  // Somewhere down the page, so Back has an offset to restore: the control
  // mid-screen, clear of the sticky header. Nothing scrolls after the Map
  // toggle's REPLACE, so this also pins that the offset carries over to the
  // entry that replace made.
  await maximise.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const leftAt = await page.evaluate(() => window.scrollY);
  expect(leftAt, "the section should have scrolled").toBeGreaterThan(0);
  const entries = await page.evaluate(() => history.length);
  await maximise.click();

  // Its own URL, its own page.
  await expect.poll(() => urlState(page).path).toMatch(MAP_PATH);
  expect(urlState(page).thermal).toBe(thermal);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("img", { name: ROSE })).toBeVisible();
  await expect(page.getByRole("button", { name: "Map", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("button", { name: "Restore map size" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Thermals" })).toBeVisible();

  // Sized to the screen: no sideways scroll, and the figure's box (the map
  // and the rose over it) no taller than the viewport, so there is always
  // page outside it to scroll by.
  await expectNoSidewaysScroll(page);
  const viewport = page.viewportSize()!;
  const rose = (await page.getByRole("img", { name: ROSE }).boundingBox())!;
  expect(rose.width).toBeLessThanOrEqual(viewport.width);
  expect(rose.height).toBeLessThan(viewport.height);

  /** Back on the section: the same thermal, the backdrop still on. */
  const expectSectionAsLeft = async () => {
    await expect.poll(() => urlState(page).path).toMatch(SECTION_PATH);
    await expect(thermalPane(page)).toBeVisible();
    await expect(thermalPane(page).locator("h3").first()).toContainText(title);
    expect(urlState(page).thermal).toBe(thermal);
    await expect(
      thermalsCard(page).getByRole("button", { name: "Map", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
  };

  // Back returns the section as it was left, scroll included (#844).
  await page.goBack();
  await expectSectionAsLeft();
  await expectScrollRestoredTo(page, leftAt);

  // A reload rebuilds the same view from the URL alone.
  await page.goForward();
  await expect(page.getByRole("img", { name: ROSE })).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("img", { name: ROSE })).toBeVisible();
  expect(urlState(page).path).toMatch(MAP_PATH);
  expect(urlState(page).thermal).toBe(thermal);

  // And Back still goes where it came from, reload or no reload.
  await page.goBack();
  await expectSectionAsLeft();

  // The restore control in the map's corner is that same Back: no new
  // history entry, the same section.
  await page.goForward();
  await expect(page.getByRole("img", { name: ROSE })).toBeVisible();
  await page.getByRole("button", { name: "Restore map size" }).click();
  await expect.poll(() => urlState(page).path).toMatch(SECTION_PATH);
  await expect(thermalPane(page)).toBeVisible();
  expect(urlState(page).thermal).toBe(thermal);
  expect(await page.evaluate(() => history.length)).toBe(entries + 1);
});

test("opened from a shared link, restore goes to the section in its place", async ({
  page,
}) => {
  // The URL the maximise link makes, opened cold in a fresh tab.
  const title = await openSectionWithMap(page);
  const thermal = urlState(page).thermal!;
  const shared = `${sectionPath}/map?thermal=${thermal}`;

  const fresh = await page.context().newPage();
  await fresh.goto(shared, { waitUntil: "domcontentloaded" });
  await expect(fresh.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(fresh.getByRole("img", { name: ROSE })).toBeVisible();
  await expectNoSidewaysScroll(fresh);

  const entries = await fresh.evaluate(() => history.length);
  await fresh.getByRole("button", { name: "Restore map size" }).click();
  await expect.poll(() => urlState(fresh).path).toMatch(SECTION_PATH);
  await expect(thermalPane(fresh)).toBeVisible();
  expect(urlState(fresh).thermal).toBe(thermal);
  // Replaced, not pushed: Back from the section does not land on the map.
  expect(await fresh.evaluate(() => history.length)).toBe(entries);
  await fresh.close();
});
