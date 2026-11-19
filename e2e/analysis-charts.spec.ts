/**
 * The charts of the task analysis, the comp analysis and the report card, on
 * a phone and on a desktop (issue #860): the horserace and the leg waterfall
 * on Task analysis → Metric details, the rank scatter on Winning strategies,
 * the consistency map on Comp analysis, and the score curves on the report
 * card.
 *
 * Three of them were one 560-unit drawing scaled to the page, so a phone
 * painted their labels at 5.3 to 5.7px; the rank scatter had one label left
 * at that size. Four of them named a pilot or a behaviour only for a mouse on
 * a mark about 14px across, under the line "Hover or focus a dot…".
 *
 * What this spec pins:
 * - every label in the charts is PAINTED at 11px or more, measured after the
 *   SVG's own scaling — a class or a `font-size` attribute says nothing about
 *   that, which is how the old charts said "10px" and painted 5.3;
 * - no label runs off its chart, before or after a mark is chosen, and the
 *   page does not scroll sideways;
 * - the names on the consistency map do not overlap one another;
 * - a mark is chosen by pointing NEAR it: a tap on a phone, the pointer on a
 *   desktop. It is named in the line above the plot. On a phone a tap far
 *   from every mark still chooses the nearest; a mouse far from every mark
 *   chooses nothing;
 * - arrow keys walk the marks, and leaving the chart ends the choice;
 * - nothing tells a reader to hover.
 *
 * Four more charts are held to the first two of those: the comparison chart
 * on "Who flew like me?" (6.1px on a phone), the field distribution strip
 * under the rank scatter (5.7px), and the lift rose and the climb profile of
 * a thermal (8px). None of them names a mark, so there is nothing to choose.
 *
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp. Never waits
 * on "networkidle": these pages keep a freshness poll in flight.
 */
import { execSync } from "node:child_process";
import { test, expect, type Locator, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";
import { expectNoSidewaysScroll } from "./fixtures/layout";

const COMP_NAME = "Corryong Cup 2026";

let compId: string;
let taskId: string;

test.beforeAll(async ({ playwright }) => {
  // Seeding plus the cold analysis compute can both take a while.
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
  expect(detail.ok()).toBe(true);
  const { tasks } = (await detail.json()) as { tasks: Array<{ task_id: string }> };
  taskId = tasks[0].task_id;

  // Never computed on the read path. Reading the comp aggregate schedules
  // every cold task, so polling it is also what warms them all.
  for (let i = 0; i < 90; i++) {
    const res = await api.get(`/api/comp/${compId}/analysis`);
    if (res.ok() && ((await res.json()) as { pending_task_count: number }).pending_task_count === 0) {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await api.dispose();
});

const chart = (page: Page, name: string) =>
  page.locator(`figure[data-chart="${name}"]`).filter({ visible: true }).first();
const plot = (figure: Locator) => figure.locator('svg[role="group"]');
const readout = (figure: Locator) => figure.locator("[data-chart-readout]");

/** Every label's painted size, and whether any leaves its chart. */
async function measureLabels(figure: Locator) {
  return figure.evaluate((fig) => {
    const small: string[] = [];
    const clipped: string[] = [];
    let texts = 0;
    // A chart with no figure round it is handed over as its <svg>.
      const svgs = fig.matches("svg")
        ? [fig as unknown as SVGSVGElement]
        : [...fig.querySelectorAll<SVGSVGElement>("svg[viewBox]")];
      for (const svg of svgs) {
      const box = svg.getBoundingClientRect();
      const scale = box.width / svg.viewBox.baseVal.width;
      for (const text of svg.querySelectorAll("text")) {
        texts++;
        const painted = parseFloat(getComputedStyle(text).fontSize) * scale;
        const label = `${text.textContent} (${painted.toFixed(1)}px)`;
        if (painted < 11) small.push(label);
        const r = text.getBoundingClientRect();
        if (
          r.left < box.left - 0.5 ||
          r.right > box.right + 0.5 ||
          r.top < box.top - 0.5 ||
          r.bottom > box.bottom + 0.5
        ) {
          clipped.push(label);
        }
      }
    }
    // The line above the plot, the legend and the caption are text beside
    // the SVG.
    for (const el of fig.querySelectorAll<HTMLElement>("p, span, figcaption")) {
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 11) small.push(`${el.textContent?.slice(0, 30)} (${px}px)`);
    }
    return { small, clipped, texts };
  });
}

/**
 * Every label in the chart is painted at `px`, none is small, and none has
 * left the chart.
 *
 * Polled, because the first render assumes a desktop width, as the server's
 * does, and the chart is measured after it mounts. Waiting for the exact
 * size is also what tells the rest of a test that the chart has stopped
 * moving and a dot's place on the screen can be trusted.
 */
async function expectReadable(figure: Locator, minTexts: number, px = 13) {
  const offSize = () =>
    figure.evaluate((fig, want) => {
      const off: string[] = [];
      // A chart with no figure round it is handed over as its <svg>.
      const svgs = fig.matches("svg")
        ? [fig as unknown as SVGSVGElement]
        : [...fig.querySelectorAll<SVGSVGElement>("svg[viewBox]")];
      for (const svg of svgs) {
        const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
        for (const text of svg.querySelectorAll("text")) {
          const painted = parseFloat(getComputedStyle(text).fontSize) * scale;
          if (Math.abs(painted - want) > 0.6) off.push(`${text.textContent} (${painted.toFixed(1)}px)`);
        }
      }
      return off;
    }, px);
  await expect.poll(offSize).toEqual([]);
  const report = await measureLabels(figure);
  expect(report.texts).toBeGreaterThanOrEqual(minTexts);
  expect(report.small).toEqual([]);
  expect(report.clipped).toEqual([]);
  await expect(figure).not.toContainText(/hover/i);
}

/** Put the plot in the middle of the screen, clear of the page bar. */
async function centre(svg: Locator) {
  await svg.evaluate((el) => el.scrollIntoView({ block: "center" }));
}

/** Point at a place on the screen: a tap on a phone, the pointer on a desktop. */
async function pointAt(page: Page, at: { x: number; y: number }, hasTouch: boolean) {
  if (hasTouch) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.move(at.x, at.y);
}

interface Dot {
  key: string;
  label: string;
  x: number;
  y: number;
}

/** Every dot of a scatter, where it is on the screen. */
async function dotsOf(svg: Locator): Promise<Dot[]> {
  return svg.evaluate((el) =>
    [...el.querySelectorAll<SVGGElement>("[data-dot]")].map((g) => {
      const c = g.querySelector("circle")!.getBoundingClientRect();
      return {
        key: g.dataset.dot!,
        label: g.getAttribute("aria-label")!,
        x: c.left + c.width / 2,
        y: c.top + c.height / 2,
      };
    })
  );
}

const far = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** The dot with the most room round it, so a point beside it is nearest it
 * and nothing else. */
function loneliest(dots: Dot[]): Dot {
  const room = (d: Dot) => Math.min(...dots.filter((o) => o !== d).map((o) => far(o, d)));
  return [...dots].sort((a, b) => room(b) - room(a))[0];
}

/**
 * A place in the plot far from every dot, and the dot that is nearest it by a
 * clear margin. Searched for rather than fixed: where the dots are depends on
 * the data.
 */
async function emptySpace(svg: Locator, dots: Dot[]) {
  const box = (await svg.boundingBox())!;
  for (let fy = 0.2; fy < 0.9; fy += 0.1) {
    for (let fx = 0.25; fx < 0.9; fx += 0.1) {
      const at = { x: box.x + box.width * fx, y: box.y + box.height * fy };
      const byDistance = [...dots].sort((a, b) => far(a, at) - far(b, at));
      const [first, second] = byDistance;
      if (far(first, at) >= 48 && far(second, at) - far(first, at) >= 4) {
        return { at, nearest: first };
      }
    }
  }
  throw new Error("no empty space found in the plot");
}

/** The shared behaviour of the three scatters. */
async function expectDotsChosenByPointingNear(
  page: Page,
  figure: Locator,
  hasTouch: boolean,
  prompt: string
) {
  const svg = plot(figure);
  await centre(svg);
  await expect(readout(figure)).toHaveText(prompt);
  const focused = () =>
    page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.dot ?? null);

  // Far from every dot. A finger cannot point, so the nearest dot is chosen
  // all the same; a mouse can, so empty space stays empty.
  const dots = await dotsOf(svg);
  const empty = await emptySpace(svg, dots);
  await pointAt(page, empty.at, hasTouch);
  if (hasTouch) {
    await expect(readout(figure)).toHaveText(empty.nearest.label);
    expect(await focused()).toBe(empty.nearest.key);
  } else {
    await expect(readout(figure)).toHaveText(prompt);
  }

  // Beside a dot, not on it.
  const dot = loneliest(dots);
  const beside = { x: dot.x + 9, y: dot.y + 7 };
  await pointAt(page, beside, hasTouch);
  await expect(readout(figure)).toHaveText(dot.label);
  if (!hasTouch) {
    // A click chooses what a tap does: focus moves to the dot, so the name
    // stays once the mouse has gone.
    await page.mouse.click(beside.x, beside.y);
    await page.mouse.move(0, 0);
    await expect(readout(figure)).toHaveText(dot.label);
  }
  expect(await focused()).toBe(dot.key);
  // Nothing has left the chart now that a dot is named in it.
  expect((await measureLabels(figure)).clipped).toEqual([]);

  // Arrow keys walk the dots from the chosen one, and leaving ends it. The
  // chosen dot may be the last of them, where there is no next to walk to.
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  if ((await readout(figure).innerText()) === dot.label) await page.keyboard.press("ArrowLeft");
  await expect(readout(figure)).not.toHaveText(dot.label);
  await expect(readout(figure)).not.toHaveText(prompt);
  await page.keyboard.press("Tab");
  await expect(readout(figure)).toHaveText(prompt);
}

test.describe("Task analysis → Metric details", () => {
  async function open(page: Page) {
    await page.goto(`/comp/${compId}/task/${taskId}/analysis/metrics`, {
      waitUntil: "domcontentloaded",
    });
    // The two charts are in the race craft family, which may be shut.
    const family = page.locator("#family-racecraft");
    const trigger = family.locator('button[slot="trigger"]').first();
    await expect(trigger).toBeVisible({ timeout: 60_000 });
    if ((await trigger.getAttribute("aria-expanded")) === "false") await trigger.click();
    await expect(chart(page, "horserace")).toBeVisible();
  }

  test("the horserace and the leg waterfall are readable and stay on their charts", async ({
    page,
  }) => {
    await open(page);
    const horserace = chart(page, "horserace");
    const waterfall = chart(page, "waterfall");
    await expectReadable(horserace, 10);
    await expectReadable(waterfall, 6);
    await expectNoSidewaysScroll(page);

    // Drawn in CSS pixels: the viewBox is as wide as the chart.
    for (const figure of [horserace, waterfall]) {
      const offBy = await figure.locator("svg[viewBox]").last().evaluate((el) => {
        const svg = el as SVGSVGElement;
        return Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width);
      });
      expect(offBy).toBeLessThan(1);
    }
    // And taller than the strip a phone used to get: the plot has its own
    // height, where it was the page's width times a fixed ratio.
    expect((await plot(horserace).boundingBox())!.height).toBeGreaterThan(240);

    // The leaders are named in a row above the plot, and each coloured line
    // ends in its rank, so a line is tied to its name by more than colour.
    const legend = horserace.locator("[data-chart-legend]");
    await expect(legend).toContainText("1. ");
    await expect(legend).toContainText("5. ");
    await expect(plot(horserace).locator("text", { hasText: /^5$/ })).toHaveCount(1);

    // The waterfall names the turnpoints at the edges of its bars: one more
    // name than there are legs, and none of them a whole leg.
    await expect(waterfall.locator("svg text", { hasText: "→" })).toHaveCount(0);
    await expect(waterfall.locator("svg text", { hasText: /^SSS$/ })).toHaveCount(1);
    await expect(waterfall.locator("svg text", { hasText: /^ESS$/ })).toHaveCount(1);
  });

  test("a line is chosen by pointing near it, and arrow keys walk the field", async ({
    page,
    hasTouch,
  }) => {
    await open(page);
    const figure = chart(page, "horserace");
    const svg = plot(figure);
    const prompt = "Select a line to name the pilot behind it.";
    await expectReadable(figure, 10);
    await centre(svg);
    await expect(readout(figure)).toHaveText(prompt);

    // Where the leader's line ends: alone at the top of the last turnpoint.
    const leader = svg.locator('[data-line][aria-label^="1. "]');
    const end = await leader.locator("path").evaluate((el) => {
      const path = el as SVGPathElement;
      const p = path.getPointAtLength(path.getTotalLength());
      const ctm = path.getScreenCTM()!;
      return { x: p.x * ctm.a + ctm.e, y: p.y * ctm.d + ctm.f };
    });
    const leaderLabel = (await leader.getAttribute("aria-label"))!;
    const leaderTrack = (await leader.getAttribute("data-line"))!;

    // Beside the line, not on it: the old target was the stroke itself.
    await pointAt(page, { x: end.x - 12, y: end.y - 6 }, hasTouch);
    await expect(readout(figure)).toHaveText(leaderLabel);
    await expect(svg.locator("[data-emphasized]")).toHaveAttribute("data-emphasized", leaderTrack);
    if (!hasTouch) {
      await page.mouse.click(end.x - 12, end.y - 6);
      await page.mouse.move(0, 0);
      await expect(readout(figure)).toHaveText(leaderLabel);
    }
    await expect(leader).toBeFocused();

    // Arrow keys walk the lines in rank order; Tab leaves and ends it.
    await page.keyboard.press("ArrowDown");
    await expect(readout(figure)).toContainText(/^2\. /);
    await page.keyboard.press("Tab");
    await expect(readout(figure)).toHaveText(prompt);
    await expect(svg.locator("[data-emphasized]")).toHaveCount(0);
  });
});

test("Winning strategies: the rank scatter is readable, and a dot is chosen by pointing near it", async ({
  page,
  hasTouch,
}) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/strategies`, {
    waitUntil: "domcontentloaded",
  });
  const ranking = page.getByRole("grid", { name: "Behaviour ranking" });
  await ranking.waitFor({ timeout: 60_000 });
  // Side by side (desktop) the chart is on screen from the start; stacked (a
  // phone) it is behind a row of the ranking.
  const figure = chart(page, "rank-scatter");
  if (!(await figure.isVisible())) {
    await ranking.locator("tbody tr").first().locator("th, td").first().click();
  }
  await expect(figure).toBeVisible();
  // The top row is a clear pattern, so it has a trend curve and its label —
  // the one label this chart still painted at 5.7px.
  await expect(plot(figure).locator("text", { hasText: /^trend$/ })).toHaveCount(1);
  // This chart's labels are the page's body size, not the footnote size.
  await expectReadable(figure, 10, 16);
  await expectNoSidewaysScroll(page);
  await expectDotsChosenByPointingNear(
    page,
    figure,
    hasTouch,
    "Select a dot to name the pilot behind it."
  );
});

test("Comp analysis: the consistency map is readable, its names do not overlap, and a dot is chosen by pointing near it", async ({
  page,
  hasTouch,
}) => {
  await page.goto(`/comp/${compId}/analysis`, { waitUntil: "domcontentloaded" });
  const figure = chart(page, "consistency-map");
  await expect(figure).toBeVisible({ timeout: 60_000 });
  await expectReadable(figure, 14);
  await expectNoSidewaysScroll(page);

  // Each name is beside its own dot, clear of every other name and dot.
  const names = await plot(figure).evaluate((svg) => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom };
    };
    const dots = new Map(
      [...svg.querySelectorAll<SVGGElement>("[data-dot]")].map((g) => [
        g.dataset.dot!,
        rect(g.querySelector("circle")!),
      ])
    );
    return [...svg.querySelectorAll<SVGTextElement>("[data-dot-label]")].map((t) => ({
      key: t.dataset.dotLabel!,
      box: rect(t),
      dot: dots.get(t.dataset.dotLabel!)!,
    }));
  });
  expect(names.length, "some dots are named in place").toBeGreaterThan(2);
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      // The text boxes are a line tall; allow the two pixels by which lines
      // of type sit inside one another's leading.
      const overlap =
        Math.min(a.box.x1, b.box.x1) - Math.max(a.box.x0, b.box.x0) > 0 &&
        Math.min(a.box.y1, b.box.y1) - Math.max(a.box.y0, b.box.y0) > 2;
      expect(overlap, `${a.key} and ${b.key} overlap`).toBe(false);
    }
    const dy = Math.abs((a.box.y0 + a.box.y1) / 2 - (a.dot.y0 + a.dot.y1) / 2);
    expect(dy, `${a.key} is beside its own dot`).toBeLessThan(26);
  }

  await expectDotsChosenByPointingNear(
    page,
    figure,
    hasTouch,
    "Select a dot to name the behaviour."
  );
  // The chosen dot is ringed, and the ring goes when the choice ends.
  await expect(plot(figure).locator("[data-chosen]")).toHaveCount(0);
});

test("The report card: a dot on a score curve is chosen by pointing near it", async ({
  page,
  hasTouch,
}) => {
  // Any scored pilot's card, by the link the task page gives a reader.
  await page.goto(`/comp/${compId}/task/${taskId}`, { waitUntil: "domcontentloaded" });
  const link = page.locator('a[href*="/pilot/"]').first();
  await link.waitFor({ state: "attached", timeout: 60_000 });
  await page.goto((await link.getAttribute("href"))!, { waitUntil: "domcontentloaded" });

  const figure = chart(page, "score-curve");
  await expect(figure).toBeVisible({ timeout: 60_000 });
  await expectReadable(figure, 6);
  await expectNoSidewaysScroll(page);
  await expectDotsChosenByPointingNear(
    page,
    figure,
    hasTouch,
    "Select a dot to name the pilot behind it."
  );
});

test("Who flew like me?: the comparison chart is readable and stays on its chart", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/similar`, {
    waitUntil: "domcontentloaded",
  });
  const svg = page.locator('svg[data-chart="metric-distribution"]');
  await expect(svg).toBeVisible({ timeout: 60_000 });
  // The field average, both ends of the band and the pilot are all named,
  // each on a row with room for it.
  await expectReadable(svg, 6);
  for (const label of ["Field average", "−1 SD", "+1 SD"]) {
    await expect(svg.locator("text", { hasText: label })).toHaveCount(1);
  }
  const labels = await svg.evaluate((el) =>
    [...el.querySelectorAll("text")].map((t) => {
      const r = t.getBoundingClientRect();
      return { text: t.textContent, x0: r.left, x1: r.right, y0: r.top, y1: r.bottom };
    })
  );
  for (const a of labels) {
    for (const b of labels) {
      if (a === b) continue;
      const overlap =
        Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 &&
        Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 2;
      expect(overlap, `"${a.text}" and "${b.text}" overlap`).toBe(false);
    }
  }
  await expectNoSidewaysScroll(page);
});

test("Winning strategies: the field distribution strip is readable", async ({ page }) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/strategies`, {
    waitUntil: "domcontentloaded",
  });
  const ranking = page.getByRole("grid", { name: "Behaviour ranking" });
  await ranking.waitFor({ timeout: 60_000 });
  const strip = page.locator('svg[data-chart="distribution-strip"]').filter({ visible: true }).first();
  if (!(await strip.isVisible())) {
    await ranking.locator("tbody tr").first().locator("th, td").first().click();
  }
  await expect(strip).toBeVisible();
  await expectReadable(strip, 4);
  // The two ends are always named; the median is where there is room.
  await expect(strip.locator("text", { hasText: /^min$/ })).toHaveCount(1);
  await expect(strip.locator("text", { hasText: /^max$/ })).toHaveCount(1);
});

test("Thermals: the lift rose and the climb profile are readable", async ({ page }) => {
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/thermals`, {
    waitUntil: "domcontentloaded",
  });
  const census = page.getByRole("grid", { name: "Reconstructed thermals" });
  await census.waitFor({ timeout: 60_000 });
  // Side by side (desktop) a thermal is on screen from the start; stacked (a
  // phone) it is behind a row of the census.
  const rose = page.locator('svg[data-chart="thermal-rose"]').filter({ visible: true }).first();
  if (!(await rose.isVisible())) {
    await census.locator("tbody tr").first().locator("th, td").first().click();
  }
  await expect(rose).toBeVisible();
  await expectReadable(rose, 4);
  const profile = page.locator('svg[data-chart="climb-profile"]').filter({ visible: true }).first();
  await expect(profile).toBeVisible();
  await expectReadable(profile, 3);
  await expectNoSidewaysScroll(page);
});

test("The task page: the route diagram's names are readable and its turnpoints can be hit, and the top three are rows", async ({
  page,
}) => {
  await page.goto(`/comp/${compId}/task/${taskId}`, { waitUntil: "domcontentloaded" });

  // The diagram is scaled to its pane, so its names are sized for the width
  // it is drawn at: they were 10 units, which a phone painted at 8px.
  const diagram = page.getByRole("region", { name: "Route diagram" }).locator("svg[viewBox]");
  await expect(diagram).toBeVisible({ timeout: 60_000 });
  const painted = () =>
    diagram.evaluate((el) => {
      const svg = el as SVGSVGElement;
      const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      return [...svg.querySelectorAll("text")].map(
        (t) => Math.round(parseFloat(getComputedStyle(t).fontSize) * scale * 10) / 10
      );
    });
  await expect.poll(async () => Math.min(...(await painted()))).toBeGreaterThanOrEqual(11.5);
  expect(Math.max(...(await painted()))).toBeLessThanOrEqual(13.5);
  // Each turnpoint's target is 44px across, at whatever size the diagram is.
  const targets = await diagram
    .locator("[data-turnpoint] circle")
    .evaluateAll((cs) => cs.map((c) => c.getBoundingClientRect().width));
  expect(targets.length).toBeGreaterThan(2);
  for (const width of targets) expect(width).toBeGreaterThanOrEqual(43.5);

  // The top three of a class are rows of the scores kit: the whole row is
  // the link, and it is as tall as a finger needs.
  const scores = page.locator("#scores");
  const podium = scores.getByRole("list", { name: /^Top 3 — / }).first();
  await expect(podium).toBeVisible({ timeout: 60_000 });
  const rows = podium.getByRole("link");
  expect(await rows.count()).toBeGreaterThanOrEqual(2);
  for (const row of await rows.all()) {
    const box = (await row.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.width).toBeGreaterThan(200);
  }
  await expect(rows.first()).toHaveAttribute("href", /\/pilot\//);
  // The last row opens the rest of the class on the scores page.
  await expect(rows.last()).toHaveText(/^\+ \d+ more pilots?$/);
  await expect(rows.last()).toHaveAttribute("href", /\/scores\?task=/);
  await expectNoSidewaysScroll(page);
});

test("Winning strategies: the ranking is one dot a row on a shared axis", async ({ page }) => {
  // Issues #804 and #860: the ranking was four columns 642px wide in a phone's
  // 359px window, with a bar for the strength and a second bar for the pilots
  // measured. Each row is now one dot on an axis drawn once above the list,
  // and the figure is the correlation with DOING WELL: positive is more of
  // the behaviour.
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/strategies`, {
    waitUntil: "domcontentloaded",
  });
  const region = page.getByRole("region", { name: "Behaviour ranking" });
  const ranking = page.getByRole("grid", { name: "Behaviour ranking" });
  await ranking.waitFor({ timeout: 60_000 });
  const rows = ranking.locator("tbody tr");
  await expect(rows.first()).toBeVisible();

  // No wider than its window, at either width.
  expect(await region.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expectNoSidewaysScroll(page);

  // The axis says what each end means, once.
  await expect(ranking.getByText("less of it did well")).toHaveCount(1);
  await expect(ranking.getByText("more of it did well")).toHaveCount(1);

  // One meter a row, with a signed figure, and the pilots measured in words.
  const row = rows.first();
  await expect(row.getByRole("meter")).toHaveCount(1);
  await expect(row.getByRole("meter")).toHaveAttribute("aria-valuetext", /^[+−]\d\.\d\d$/);
  await expect(row.getByText(/^\d+ of \d+ pilots$/)).toBeVisible();

  // Glide speed is the top row of this task. Faster went with doing well, so
  // its figure is POSITIVE, where the correlation with rank number was -0.79.
  const glide = rows.filter({ hasText: "Glide speed between climbs" });
  await expect(glide.getByRole("meter")).toHaveAttribute("aria-valuetext", /^\+/);

  // Every row's dot is inside its row, and the rows' zero lines line up.
  const zeros = await rows.evaluateAll((trs) =>
    trs.map((tr) => {
      const meter = tr.querySelector('[role~="meter"]')!;
      const track = meter.firstElementChild!.getBoundingClientRect();
      return Math.round(track.left + track.width / 2);
    })
  );
  expect(new Set(zeros).size).toBe(1);
});
