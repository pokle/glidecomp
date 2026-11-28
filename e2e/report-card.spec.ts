/**
 * The pilot report card — `/comp/:c/task/:t/pilot/:p` — as a BROWSER renders
 * it, which is the half nothing covered.
 *
 * What existed before this file: ssr.spec.ts asserts some explanation prose is
 * in the server HTML, and lazy-map-in-view.spec.ts asserts the map mounts.
 * Neither reaches the four rules CLAUDE.md sets for this page, and two of them
 * (the emphasis charts and the track-cleaning chart) are client-only by
 * design, so no server-side assertion can ever reach them:
 *
 *   (a) every section that states a rule names its inputs and prints the
 *       substituted arithmetic — the day-quality section asserted bare
 *       percentages for a year, the one figure a reader cannot check;
 *   (b) the page never re-derives GAP parameters from the comp record — it
 *       reads the published `ClassScore.gap_params`, because the scorer merged
 *       the TASK's overrides over the comp's and resolved "auto" against the
 *       route;
 *   (c) the charts are EMPHASIS charts sampled from the scorer's own
 *       functions: one accent dot for this pilot, muted ink for everyone else,
 *       and a curve that IS the formula rather than a fit through the dots;
 *   (d) a repaired track shows its repairs, drawn client-side off the tracklog
 *       the page already downloaded for the map.
 *
 * A fifth concern joined them with issue #666: this page is PUBLIC, and the
 * link it offers into the analysis viewer now opens for a reader with no
 * session. That is a gate, so it is tested as one — see the "signed out"
 * block at the foot of the file.
 *
 * The fixture is a private scored competition (e2e/fixtures/scored-comp.ts) —
 * real tracklogs with both altitude channels, which (d) needs, and a field of
 * three, which (c) needs to have anyone to be muted against.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN, e2eCompName } from "./fixtures/stack";
import { installMapbox } from "./fixtures/mapbox";
import {
  createScoredComp,
  openClass,
  pilotIn,
  readFreshScore,
  registerPilot,
  spikedIgc,
  uploadTrack,
  type ScoredClass,
  type ScoredComp,
} from "./fixtures/scored-comp";

const BASE_URL = FRONTEND_URL;

/** The pilot whose tracklog carries a repairable altitude glitch (rule d). */
const REPAIRED_PILOT = "Dita Spike";

test.describe("the pilot report card", () => {
  let admin: APIRequestContext;
  let fixture: ScoredComp;
  let cls: ScoredClass;
  let cardUrl: string;
  /** The pilot `cardUrl` belongs to — the analysis deep link names them. */
  let cardPilot: { comp_pilot_id: string; pilot_name: string };
  /** The report card of the pilot whose track needed repairing. */
  let repairedCardUrl: string;

  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE_URL });
    const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    expect(signIn.ok(), "super admin dev-login").toBeTruthy();
    fixture = await createScoredComp(admin, "report card");

    // A fourth pilot flying the same trace with an altitude glitch cut into
    // it, so there is a repaired track on this task to read a report card for.
    fixture.pilotIds.set(
      REPAIRED_PILOT,
      await registerPilot(admin, fixture.compId, REPAIRED_PILOT)
    );
    await uploadTrack(admin, fixture, REPAIRED_PILOT, spikedIgc());

    cls = openClass(await readFreshScore(admin, fixture));
    expect(
      cls.pilots.length,
      "a scored field — without one there is no report card to read"
    ).toBeGreaterThan(1);
    // The winner: the pilot most likely to carry every section (goal, time,
    // leading), so the page under test is the fullest one the fixture has.
    const you = cls.pilots[0];
    cardPilot = you;
    const card = (compPilotId: string) =>
      `${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}/pilot/${compPilotId}`;
    cardUrl = card(you.comp_pilot_id);

    const repaired = pilotIn(cls, REPAIRED_PILOT);
    expect(repaired, "the repaired track must still score — quality passes it").toBeTruthy();
    repairedCardUrl = card(repaired!.comp_pilot_id);
  });

  test.afterAll(async () => {
    if (fixture?.compId) await admin.delete(`/api/comp/${fixture.compId}`);
    await admin.dispose();
  });

  test("(a) day quality names its inputs and prints the arithmetic", async ({ page }) => {
    await page.goto(cardUrl);

    const heading = page.getByRole("heading", { name: "Day quality — points on offer" });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    const section = page.locator("section", { has: heading });

    // Launch validity: the counts on both sides of the ratio, and the
    // threshold they are measured against — not "launch validity 100%".
    await expect(section.getByText(/\d+ pilots? flew out of \d+ present/)).toBeVisible();
    await expect(
      section.getByText(/Nominal launch is 96%, so launch validity is full once/)
    ).toBeVisible();

    // Distance validity: the nominal distance, the nominal goal and the
    // minimum distance the formula used, plus what the field actually flew.
    await expect(
      section.getByText(/Measured against a [\d.]+ km nominal distance/)
    ).toBeVisible();
    await expect(section.getByText(/The field flew [\d.]+ km past the minimum/)).toBeVisible();

    // And a way out of the page for a reader who does not know GAP.
    await expect(
      section.getByRole("link", { name: /How day quality .* works/i })
    ).toHaveAttribute("href", "/scoring/gap#task-validity");
  });

  test("(b) the formula named is the one the task was scored with", async ({ page }) => {
    // The page fetches the comp record as well as the score, and still carries
    // a re-derivation fallback for score rows cached before `gap_params` was
    // published. Serve it a comp record that disagrees loudly: if anything on
    // the page is derived from the comp instead of read from the published
    // class score, the absurd number appears in the prose.
    const LIE_KM = 999;
    await page.route(/\/api\/comp\/[^/]+(\?|$)/, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { gap_params?: Record<string, unknown> | null };
      await route.fulfill({
        response: res,
        json: {
          ...body,
          gap_params: { ...(body.gap_params ?? {}), nominalDistance: LIE_KM * 1000 },
        },
      });
    });

    await page.goto(cardUrl);
    const heading = page.getByRole("heading", { name: "Day quality — points on offer" });
    await expect(heading).toBeVisible({ timeout: 30_000 });

    const published = (cls.gap_params!.nominalDistance / 1000).toFixed(1);
    await expect(
      page.getByText(`Measured against a ${published} km nominal distance`)
    ).toBeVisible();
    await expect(page.getByText(`${LIE_KM}.0 km nominal distance`)).toHaveCount(0);
  });

  test("(c) the charts single this pilot out, and are the formula not a fit", async ({
    page,
  }) => {
    await page.goto(cardUrl);
    await expect(
      page.getByRole("heading", { name: "Day quality — points on offer" })
    ).toBeVisible({ timeout: 30_000 });

    // Exactly one dot on a curve is this pilot's. More than one would mean the
    // accent is being painted on the field; none would mean the reader cannot
    // find themselves, which is the only reason the chart is here.
    const you = page.getByRole("img", { name: /— this pilot$/ });
    await expect(you.first()).toBeVisible();
    expect(await you.count(), "one accent dot per curve, and only one").toBeGreaterThan(0);

    // The curve is sampled from the scorer's own function. The task-analysis
    // charts say "a trend fitted through the dots" and these must never — the
    // difference between a formula and a regression is the whole claim.
    await expect(page.getByText(/fitted through the dots/)).toHaveCount(0);
    await expect(page.getByText(/The curve is the .*formula/).first()).toBeVisible();
  });

  test("(d) a repaired track shows its repairs, client-side", async ({ page }) => {
    await page.goto(repairedCardUrl);

    const heading = page.getByRole("heading", { name: "Track data cleaning" });
    await expect(heading).toBeVisible({ timeout: 30_000 });

    // The prose counts the repair before any chart exists — it is what the
    // server rendered, and it survives with no JS.
    await expect(
      page.getByText(/\d+ of \d+ GPS fixes .* carried an implausible altitude/)
    ).toBeVisible();

    // The chart is drawn from the tracklog the page downloads for the map, so
    // it appears only after that lands — and only in a browser. Its accessible
    // name carries the whole reading, which is also what a screen reader gets
    // in place of the three lines.
    const chart = page.getByRole("img", { name: /^Altitude against time\./ });
    await expect(chart).toBeVisible({ timeout: 30_000 });

    // A channel the file does not carry is NAMED, never drawn as a flat line
    // at zero — these tracklogs log no barometric altitude, so the legend has
    // to say so.
    await expect(chart).toHaveAttribute(
      "aria-label",
      /carries no barometric channel/
    );

    // The exact numbers live in the list either way — the chart is the shape
    // of the repair, the list is the record of it, and the list doubles as the
    // chart's controls.
    await expect(page.getByText(/\d+ fix(es)? · up to \d+ m off/).first()).toBeVisible();
  });

  /**
   * On a phone the map is a floating window (owner's decision, 28 November
   * 2026; docs/interaction-guide.md 2.8, `components/FloatingWindow.tsx`).
   *
   * It was pinned under the page bar, and held half the screen for as long
   * as the reader was in the Flight section. Now it covers a corner, and the
   * reader says which, how large, and whether at all.
   *
   * These run in the desktop project at a phone's width, with a mouse: the
   * window is driven by pointer events, which a mouse and a finger both are.
   *
   * The map is ONE instance in the report card's column, in the window and
   * on its full-size page: the reader's view, and what they drew on it, go
   * with them.
   */
  const win = (page: Page) => page.locator("[data-floating]");
  const settled = async (page: Page) => {
    // The move is a 320 ms animation; a rect read during it is in between.
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-floating]");
      return el != null && el.getAnimations().length === 0;
    });
    return (await win(page).boundingBox())!;
  };

  test("on a phone the map floats in a corner; its button sizes it, and it can be put away and brought back", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(cardUrl);

    const map = page.getByRole("region", { name: "Track map" });
    await expect(map).toBeVisible({ timeout: 30_000 });
    await expect(map).toHaveAttribute("data-floating", "small");
    // At the foot, where it covers none of the page's opening lines.
    await expect(map).toHaveAttribute("data-corner", "bottom-right");

    // Small, it is a map in a corner: it does not take the screen.
    const small = await settled(page);
    expect(small.width, "a corner, not a band").toBeLessThan(200);
    expect(small.y, "below the page's first screenful of text").toBeGreaterThan(500);
    // The way to the full-size page is on the large window.
    await expect(page.getByRole("link", { name: "Expand map" })).toBeHidden();

    // A press on the map is the map's: it does not change the window.
    await page.mouse.click(small.x + 50, small.y + 120);
    await expect(map).toHaveAttribute("data-floating", "small");

    // One button, in the window's top right corner at both sizes.
    const sizeButton = page.getByRole("button", { name: "Enlarge map" });
    const at = (await sizeButton.boundingBox())!;
    expect(small.x + small.width - (at.x + at.width), "against the right edge").toBeLessThan(12);
    expect(at.y - small.y, "against the top edge").toBeLessThan(12);
    await sizeButton.click();
    await expect(map).toHaveAttribute("data-floating", "large");
    const large = await settled(page);
    expect(large.width).toBeGreaterThan(340);
    const shrink = (await page.getByRole("button", { name: "Make map smaller" }).boundingBox())!;
    expect(large.x + large.width - (shrink.x + shrink.width)).toBeLessThan(12);
    expect(shrink.y - large.y).toBeLessThan(12);
    await expect(page.getByRole("link", { name: "Expand map" })).toBeVisible();
    await expect(page.getByRole("slider", { name: "Flight time" })).toBeVisible({
      timeout: 30_000,
    });

    // Nothing here needs a drag (guide 2.9): the grabber is a button too.
    await page.getByRole("button", { name: "Move or hide map" }).click();
    await page.getByRole("menuitem", { name: "Move to the top" }).click();
    await expect(map).toHaveAttribute("data-corner", "top-right");
    const high = await settled(page);
    expect(high.y, "under the page bar").toBeGreaterThanOrEqual(60);
    expect(high.y).toBeLessThan(100);

    await page.getByRole("button", { name: "Move or hide map" }).click();
    await page.getByRole("menuitem", { name: "Hide" }).click();
    await expect(map).toBeHidden();
    const tab = page.getByRole("button", { name: "Show map" });
    await expect(tab).toBeVisible();

    // Remembered: the next report card opens with the map still put away.
    await page.goto(repairedCardUrl);
    await expect(page.getByRole("heading", { name: "Track data cleaning" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "Show map" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Track map" })).toBeHidden();

    await page.getByRole("button", { name: "Show map" }).click();
    await expect(page.getByRole("region", { name: "Track map" })).toBeVisible();

    await page.getByRole("button", { name: "Make map smaller" }).click();
    await expect(page.getByRole("region", { name: "Track map" })).toHaveAttribute(
      "data-floating",
      "small"
    );
  });

  test("the window is carried by its grabber to a corner, and off a side to put it away", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(cardUrl);
    const map = page.getByRole("region", { name: "Track map" });
    await expect(map).toBeVisible({ timeout: 30_000 });
    await expect(map).toHaveAttribute("data-corner", "bottom-right");

    // By the grabber: the map under it is the map's own to drag.
    const carry = async (to: { x: number; y: number }) => {
      const box = await settled(page);
      const from = { x: box.x + box.width / 2, y: box.y + 10 };
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
      await page.mouse.move(to.x, to.y, { steps: 5 });
      // Let go at rest: this is a carry, not a throw.
      await page.waitForTimeout(200);
      await page.mouse.up();
    };

    // Let go anywhere, and it goes to the nearest corner.
    await carry({ x: 150, y: 150 });
    await expect(map).toHaveAttribute("data-corner", "top-left");
    const rest = await settled(page);
    expect(rest.x, "against the left edge").toBeLessThan(20);
    expect(rest.y, "under the page bar").toBeLessThan(100);
    // The carry was not a tap: no menu opened, and the page did not scroll.
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // The page's last lines are not left under a window resting at the foot.
    await carry({ x: 120, y: 520 });
    await expect(map).toHaveAttribute("data-corner", "bottom-left");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const footer = page.getByRole("contentinfo");
    if ((await footer.count()) > 0) {
      const f = (await footer.boundingBox())!;
      const w = await settled(page);
      expect(f.y + f.height, "the footer ends above the window").toBeLessThanOrEqual(w.y + 1);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    // Carried over the left edge, it is put away, and a tab stays there.
    await carry({ x: 15, y: 600 });
    await expect(map).toBeHidden();
    const tab = page.getByRole("button", { name: "Show map" });
    await expect(tab).toBeVisible();
    expect((await tab.boundingBox())!.x, "the tab is on the side it left by").toBeLessThan(5);

    // Side by side there is no window at all: the map is a column of the page.
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator("[data-floating]")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Track map" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show map" })).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.getByRole("region", { name: "Track map" })).toBeInViewport();
  });

  test("picking a step brings a map that was put away back, clear of the step", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(cardUrl);
    const map = page.getByRole("region", { name: "Track map" });
    await expect(map).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "Move or hide map" }).click();
    await page.getByRole("menuitem", { name: "Hide" }).click();
    await expect(map).toBeHidden();

    // A step is a question put to the map. In the lower half of the screen,
    // so the map has to come back at the top.
    const step = page.locator('button[title="Show on map"]').first();
    await step.evaluate((el) => {
      window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - 560);
    });
    await step.click();

    await expect(map).toBeVisible();
    await expect(map).toHaveAttribute("data-floating", "small");
    const w = await settled(page);
    const s = (await step.boundingBox())!;
    expect(w.y + w.height, "the window is above the step that was picked").toBeLessThan(s.y);
  });

  // #870: the map at full size was a fixed layer over the report card. It is
  // a page (docs/interaction-guide.md 2.1), reached by a link and left by Back.
  test("Expand map opens the map's own page with the SAME map; a reload stands on it, and Back returns", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(cardUrl);
    // The way to the full-size page is on the large window.
    await page.getByRole("button", { name: "Enlarge map" }).click({ timeout: 30_000 });
    const expand = page.getByRole("link", { name: "Expand map" });
    await expect(expand).toBeVisible({ timeout: 30_000 });
    // Mark the map's element: the page that opens must show THIS map, with
    // its camera and whatever was drawn on it, not a new one.
    const mark = () =>
      page.evaluate(() => {
        const c = document.querySelector(".mapboxgl-canvas") as
          | (HTMLElement & { __mark?: string })
          | null;
        if (!c) return null;
        c.__mark ??= String(Math.random());
        return c.__mark;
      });
    await expect.poll(mark, { timeout: 30_000 }).not.toBeNull();
    const before = await mark();
    await expand.click();

    await expect(page).toHaveURL(/\/pilot\/[^/]+\/map$/);
    await expect(page.getByRole("heading", { level: 1, name: "Map" })).toBeVisible();
    const map = page.getByRole("region", { name: "Track map" });
    await expect(map).toBeVisible();
    expect(await mark(), "the same map element").toBe(before);
    // The page is the map: it fills what the bar leaves, edge to edge, and
    // nothing scrolls.
    const box = await map.boundingBox();
    expect(box!.height, "the map has most of the screen").toBeGreaterThan(450);
    expect(box!.width, "the map is as wide as the screen").toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("link", { name: `Back to ${cardPilot.pilot_name}` })).toBeVisible();

    // The map's own way back, where the way in was: the same map again, in
    // the window it left.
    await page.getByRole("button", { name: "Shrink map" }).click();
    await expect(page).toHaveURL(/\/pilot\/[^/]+$/);
    await expect(page.getByRole("region", { name: "Track map" })).toHaveAttribute(
      "data-floating",
      "large"
    );
    expect(await mark(), "still the same map element").toBe(before);

    await page.getByRole("link", { name: "Expand map" }).click();
    await expect(page).toHaveURL(/\/pilot\/[^/]+\/map$/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Map" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Track map" })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/pilot\/[^/]+$/);
    await expect(page.getByRole("heading", { level: 1, name: cardPilot.pilot_name })).toBeVisible();
  });

  test("side by side, the full-size map is as wide as the window", async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(cardUrl);
    await page.getByRole("link", { name: "Expand map" }).click({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/pilot\/[^/]+\/map$/);
    const map = page.getByRole("region", { name: "Track map" });
    await expect(map).toBeVisible();
    expect((await map.boundingBox())!.width, "edge to edge, not the bar's width").toBe(1500);
    await page.getByRole("button", { name: "Shrink map" }).click();
    await expect(page).toHaveURL(/\/pilot\/[^/]+$/);
    await expect(page.getByRole("link", { name: "Expand map" })).toBeVisible();
  });

  // #870: the title's menu listed every pilot of the class, one row each. It
  // has one row for them now, and that opens a page with a search field.
  test("the title's menu has one row for the other pilots, which opens a page to choose one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(cardUrl);
    await expect(page.getByRole("heading", { level: 1, name: cardPilot.pilot_name })).toBeVisible({
      timeout: 30_000,
    });
    const other = cls.pilots.find((p) => p.comp_pilot_id !== cardPilot.comp_pilot_id)!;

    await page.getByRole("button", { name: /go to another page$/ }).click();
    await expect(page.getByRole("menuitem", { name: other.pilot_name })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Another pilot…" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Another pilot" })).toBeVisible();
    // The address settles on its slugs and keeps the one `from`.
    await expect(page).toHaveURL(new RegExp(`-${fixture.taskId}/pilots\\?from=${cardPilot.comp_pilot_id}$`));
    const list = page.getByRole("list", { name: "Pilots, by rank" });
    await expect(list.getByRole("listitem")).toHaveCount(cls.pilots.length);
    // The pilot the reader came from is named, and is not a link to itself.
    const own = list.getByRole("listitem").filter({ hasText: cardPilot.pilot_name });
    await expect(own).toContainText("The report card you came from");
    await expect(own.getByRole("link")).toHaveCount(0);

    // The search narrows the rows, and says so when nothing matches.
    const search = page.getByRole("searchbox", { name: "Search pilots" });
    await search.fill(other.pilot_name);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await search.fill("nobody of this name");
    await expect(page.getByText("No pilot of that name on this task.")).toBeVisible();
    await search.fill(other.pilot_name);

    // A row opens that pilot's report card, and Back returns to the list.
    await list.getByRole("link", { name: new RegExp(other.pilot_name) }).click();
    await expect(page.getByRole("heading", { level: 1, name: other.pilot_name })).toBeVisible({
      timeout: 30_000,
    });
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Another pilot" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  /**
   * The anonymous reader (issue #666).
   *
   * The report card is public and server-rendered, so most of its readers have
   * no session — the pilot who was sent the link, their club, a meet director
   * on somebody else's laptop. Its bar's ⋯ menu offers "Open the track on the
   * map" (a button over the map until #863, where it sat on top of the map's
   * own controls), and that link used to be drawn for signed-in visitors
   * only, because the analysis viewer bounced everyone else to sign-in.
   *
   * What changed is deliberately one URL shape wide: `?compId=…&taskId=…`
   * (plus `pilotId`) opens with no session, and nothing else does. The three
   * tests here are the three halves of that claim — it works, it is narrow,
   * and it still cannot see a hidden `test` comp.
   *
   * These tests run in the default context, which carries no session at all,
   * so "signed out" needs no arranging.
   */
  test.describe("signed out", () => {
    test("the report card offers the analysis map, and it opens this pilot's track", async ({
      page,
      context,
    }) => {
      const mapbox = await installMapbox(context);
      await page.goto(cardUrl);

      // The action is the first row of the bar's ⋯ menu, for a reader with no
      // session too — and no longer a button over the map.
      const more = page.getByRole("button", { name: "More actions" });
      await expect(more).toBeVisible({ timeout: 30_000 });
      await more.click();
      await expect(
        page.getByRole("menuitem", { name: "Climbs and glides" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("link", { name: /Open full track in the analysis map/ })
      ).toHaveCount(0);

      // The same link is in the markup with the menu closed (the bar's
      // visually hidden "Page actions" list), which is where its href is read.
      const link = page
        .getByRole("navigation", { name: "Page actions" })
        .getByRole("link", { name: "Climbs and glides" });
      await expect(link).toHaveCount(1);
      // `pilotId` is what narrows the viewer to this one track, which is what
      // keeps its panel in single-track mode. Without it the reader lands on
      // the whole field and the per-track tabs are replaced by a score table
      // the report card already showed them.
      await expect(link).toHaveAttribute(
        "href",
        `/analysis?compId=${fixture.compId}&taskId=${fixture.taskId}` +
          `&pilotId=${cardPilot.comp_pilot_id}`
      );

      // Follow it here rather than in the new tab it asks for — the URL is the
      // thing under test, and a second tab only complicates the assertions.
      await page.goto((await link.getAttribute("href"))!);

      // Not bounced. This is the assertion the whole issue is about.
      await expect(page).toHaveURL(/\/analysis\?compId=/);

      // The task arrived: the bar's trail is only named once it resolved,
      // and with a pilot in the link, Back is that pilot's report card.
      await expect(page.locator("#breadcrumbs")).toContainText("Task 4", {
        timeout: 60_000,
      });
      await expect(page.locator("#breadcrumbs")).toContainText(cardPilot.pilot_name);
      await expect(page.getByRole("link", { name: `Back to ${cardPilot.pilot_name}` })).toHaveAttribute(
        "href",
        new RegExp(`/task/[^/]*${fixture.taskId}/pilot/[^/]*${cardPilot.comp_pilot_id}$`),
      );

      // And the pilot's track was parsed and analysed, under their registered
      // name rather than whatever the IGC header says.
      await expect(page.locator("#event-panel-container")).toContainText(
        cardPilot.pilot_name,
        { timeout: 60_000 }
      );

      // All six single-track tabs — the tooling the report card does not have.
      // The panel is a sidebar over the map, collapsed to zero width until the
      // reader opens it from "Lists" in the page bar. Collapsed is not the same
      // as absent: it keeps its markup (and enough of a box to look "visible"
      // to a bounding-box check), so its own `aria-hidden` is what says
      // whether it is open.
      const panel = page.locator("#waypoint-sidebar");
      if ((await panel.getAttribute("aria-hidden")) !== "false") {
        await page.getByRole("button", { name: "Lists", exact: true }).click();
      }
      await expect(panel).toHaveAttribute("aria-hidden", "false");
      const tabs = page.locator("#tab-row-single");
      for (const name of ["Task", "Score", "Events", "Glides", "Climbs", "Sinks"]) {
        await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
      }

      // The page is read-only in the one way that matters to a visitor: every
      // control that would reload into a URL this gate does not allow is
      // hidden, rather than left to throw the reader back out to sign-in.
      const gated = page.locator("[data-requires-account]");
      expect(await gated.count(), "the sample loaders should be marked").toBeGreaterThan(0);
      for (const el of await gated.all()) {
        await expect(el).toHaveClass(/\bhidden\b/);
      }

      mapbox.assertComplete();
    });

    test("every other way into the analysis page still asks for a sign-in", async ({
      page,
    }) => {
      const link = `compId=${fixture.compId}&taskId=${fixture.taskId}`;
      const gated = [
        // The bare page — the personal library and the file tooling.
        "",
        // The bundled samples and the mobile share target.
        "?track=2025-01-05-Tushar-Corryong.igc",
        "?task=buje",
        "?sampleComp=corryong-cup-2026-open-t1",
        "?shared=1",
        // The personal library proper.
        "?storedTrack=whatever",
        "?storedTask=buje",
        "?u=someone",
        // Half a competition link is not a competition link.
        `?compId=${fixture.compId}`,
        `?taskId=${fixture.taskId}`,
        // And a real one cannot be used to smuggle the rest past the gate.
        `?${link}&storedTrack=whatever`,
        `?${link}&track=2025-01-05-Tushar-Corryong.igc`,
      ];

      for (const query of gated) {
        await page.goto(`/analysis${query}`);
        await page.waitForURL(/\/u\/me/, { timeout: 30_000 });
      }
    });

    test("a deep link into a hidden test comp finds nothing, and names nothing", async ({
      page,
      context,
    }) => {
      const mapbox = await installMapbox(context);

      // A `test` comp is invisible to anyone but its admins: all four routes
      // the deep link uses answer a non-admin the same "Not found" they answer
      // for an id that never existed.
      const name = e2eCompName("hidden from the analysis deep link");
      const compRes = await admin.post("/api/comp", {
        data: { name, category: "hg", pilot_classes: ["open"], test: true },
      });
      expect(compRes.ok(), await compRes.text()).toBeTruthy();
      const { comp_id: hiddenComp } = (await compRes.json()) as { comp_id: string };
      try {
        const taskRes = await admin.post(`/api/comp/${hiddenComp}/task`, {
          data: { name: "Secret task", task_date: "2020-12-12", pilot_classes: ["open"] },
        });
        expect(taskRes.ok(), await taskRes.text()).toBeTruthy();
        const { task_id: hiddenTask } = (await taskRes.json()) as { task_id: string };

        await page.goto(`/analysis?compId=${hiddenComp}&taskId=${hiddenTask}`);

        // Not-found, said as an answer rather than as a failure.
        await expect(page.locator("#status-message")).toHaveText(
          "Competition task not found",
          { timeout: 60_000 }
        );

        // And nothing about the competition leaked on the way to saying so:
        // the bar's trail keeps its generic names until the task resolves,
        // and the title is the page's own.
        await expect(page.locator("#breadcrumbs li")).toHaveText(["Competitions", "Competition", "Task", "All tracks"]);
        expect(await page.locator("body").innerText()).not.toContain(name);
        expect(await page.title()).not.toContain(name);
        expect(await page.title()).not.toContain("Secret task");
      } finally {
        await admin.delete(`/api/comp/${hiddenComp}`);
      }

      mapbox.assertComplete();
    });
  });
});
