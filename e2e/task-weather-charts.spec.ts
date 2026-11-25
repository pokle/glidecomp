/**
 * The weather charts on a phone and on a desktop (issue #860): the three
 * modelled charts on the task page, and the same three with the three
 * track-derived charts on Task analysis → Weather.
 *
 * They were one 560-unit drawing scaled to the page, so on a phone their
 * labels were painted at 5px, and their exact figures answered a mouse hover
 * and nothing else: a tap did nothing and a keyboard could not reach them.
 *
 * What this spec pins, on both pages:
 * - every label in the charts is PAINTED at 11px or more, measured after the
 *   SVG's own scaling — a class or a `font-size` attribute says nothing about
 *   that, which is how the old charts said "10px" and painted 5.7;
 * - no label runs off its chart, and the page does not scroll sideways;
 * - choosing an hour (a tap on a phone, the pointer on a desktop) marks that
 *   hour in every chart of the stack, and each chart prints its own figures
 *   for it in its legend row;
 * - arrow keys move the hour, and each hour is named with its figures;
 * - a leg on the wind-by-leg chart is a row that opens its full sentence;
 * - nothing tells a reader to hover.
 *
 * The weather answer is a fixture served by `page.route`: the real one comes
 * from an outside provider, and its numbers are not ours to assert on. It is
 * a whole daylight day on purpose — about fifteen hour columns, the narrow
 * case a task with no launch window produces.
 *
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp. Never waits
 * on "networkidle": both pages keep a freshness poll in flight.
 */
import { execSync } from "node:child_process";
import { test, expect, type Locator, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";
const HOUR_MS = 3_600_000;
/** 06:00 AEDT on 5 January 2026. */
const DAY_START_MS = Date.UTC(2026, 0, 4, 19);
/** 14:00 AEDT — the hour the tests choose. */
const CHOSEN_MS = Date.UTC(2026, 0, 5, 3);

let compId: string;
let taskId: string;

function weatherFixture() {
  const hours = Array.from({ length: 16 }, (_, i) => {
    const tMs = DAY_START_MS + i * HOUR_MS;
    const chosen = tMs === CHOSEN_MS;
    return {
      t: new Date(tMs).toISOString(),
      surface: {
        windDirectionDeg: 270,
        windSpeedKmh: chosen ? 12 : 8,
        windGustKmh: chosen ? 25 : 14,
        temperatureC: 28,
        dewPointC: 6,
      },
      levels: [
        { pressureHpa: 950, heightM: 540, windSpeedKmh: 15, windDirectionDeg: 280, temperatureC: 29 },
        {
          pressureHpa: 850,
          heightM: 1500,
          windSpeedKmh: chosen ? 23 : 18,
          windDirectionDeg: 290,
          temperatureC: 19,
        },
        { pressureHpa: 700, heightM: 3000, windSpeedKmh: 30, windDirectionDeg: 280, temperatureC: 5 },
      ],
      cloud: { lowPct: 0, midPct: chosen ? 40 : 10, highPct: 20, totalPct: 30 },
      boundaryLayerDepthM: chosen ? 2950 : 1500 + i * 80,
      capeJkg: 120,
      shortwaveWm2: 700,
      precipitationMm: 0,
      cloudBaseAglM: chosen ? 3100 : 2400,
    };
  });
  return {
    task_id: taskId,
    comp_id: compId,
    notes: "",
    stale: false,
    pending: false,
    too_far_ahead: false,
    error: null,
    weather: {
      source: {
        providerId: "open-meteo-historical-forecast",
        model: "Open-Meteo best-match (ECMWF/regional)",
        attribution: "Open-Meteo archived forecast",
        attributionUrl: "https://open-meteo.com/",
        license: "CC BY 4.0",
        kind: "model",
        resolutionKm: null,
        variables: ["surface_wind", "level_wind", "cloud_cover", "boundary_layer", "cape"],
        pointLat: -36.1687,
        pointLon: 147.8571,
        pointElevationM: 298,
      },
      resolved: {
        lat: -36.1933,
        lon: 147.8894,
        elevationM: 543,
        fromMs: DAY_START_MS,
        toMs: DAY_START_MS + 16 * HOUR_MS,
      },
      provisional: false,
      fetchedAt: "2026-01-06T00:00:00.000Z",
      hours,
    },
  };
}

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
  expect(detail.ok()).toBe(true);
  const { tasks } = (await detail.json()) as { tasks: Array<{ task_id: string }> };
  taskId = tasks[0].task_id;
  await api.dispose();
});

const WIND = '[data-met-chart="wind"]';

async function stubWeather(page: Page) {
  await page.route("**/api/comp/*/task/*/weather", (route) =>
    route.fulfill({ json: weatherFixture() })
  );
}

/** Wait until the stack is laid out for its real width: the viewBox is then
 * as wide as the chart is drawn. The frame is measured after mount. */
async function laidOut(figure: Locator) {
  await expect
    .poll(() =>
      figure.locator(`${WIND} svg[role="group"]`).evaluate((svg) => {
        const el = svg as SVGSVGElement;
        return Math.abs(el.viewBox.baseVal.width - el.getBoundingClientRect().width);
      })
    )
    .toBeLessThan(1);
}

/** Open the task page with the fixture weather and wait for the charts. */
async function openTaskPage(page: Page) {
  await stubWeather(page);
  await page.goto(`/comp/${compId}/task/${taskId}`, { waitUntil: "domcontentloaded" });
  const figure = page.locator("figure", { has: page.locator(WIND) });
  await expect(figure.locator("[data-met-chart]")).toHaveCount(3);
  await laidOut(figure);
  return figure;
}

/** Open Task analysis → Weather: the same three charts above the three
 * drawn from the pilots' tracks. */
async function openAnalysisPage(page: Page) {
  await stubWeather(page);
  await page.goto(`/comp/${compId}/task/${taskId}/analysis/weather`, {
    waitUntil: "domcontentloaded",
  });
  const figure = page.locator("figure", { has: page.locator(WIND) });
  await expect(figure.locator("[data-met-chart]")).toHaveCount(3, { timeout: 60_000 });
  await expect(figure.locator("[data-day-chart]")).toHaveCount(3);
  await laidOut(figure);
  return figure;
}

/** Every label's painted size, and whether any leaves its chart. */
async function measureLabels(figure: Locator) {
  return figure.evaluate((fig) => {
    const small: string[] = [];
    const clipped: string[] = [];
    for (const svg of fig.querySelectorAll<SVGSVGElement>("svg[viewBox]")) {
      const box = svg.getBoundingClientRect();
      const scale = box.width / svg.viewBox.baseVal.width;
      for (const text of svg.querySelectorAll("text")) {
        const painted = parseFloat(getComputedStyle(text).fontSize) * scale;
        const label = `${text.textContent} (${painted.toFixed(1)}px)`;
        if (painted < 11) small.push(label);
        const r = text.getBoundingClientRect();
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5) clipped.push(label);
      }
    }
    // The titles, the source stamp, the legends and the leg rows are text
    // beside the SVGs.
    for (const el of fig.querySelectorAll<HTMLElement>("p, span, button")) {
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 11) small.push(`${el.textContent?.slice(0, 30)} (${px}px)`);
    }
    return {
      small,
      clipped,
      texts: fig.querySelectorAll("svg text").length,
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function choose(column: Locator, hasTouch: boolean) {
  if (hasTouch) await column.tap();
  else await column.hover();
}

test.describe("the task page", () => {
  test("every chart label is painted at a readable size and stays on its chart", async ({
    page,
  }) => {
    const figure = await openTaskPage(page);
    const report = await measureLabels(figure);
    expect(report.texts).toBeGreaterThan(10);
    expect(report.small).toEqual([]);
    expect(report.clipped).toEqual([]);
    expect(report.sideways).toBe(false);

    // The source is on every chart, and nothing asks for a hover.
    await expect(figure.locator("[data-met-source]")).toHaveText([
      "Open-Meteo · modelled",
      "Open-Meteo · modelled",
      "Open-Meteo · modelled",
    ]);
    // Until an hour is chosen, the cloud legend is the shading's scale.
    await expect(figure.locator('[data-met-chart="cloud"] [data-chart-legend]')).toHaveText(
      "10%50%100% of the layer covered"
    );
    await expect(figure).not.toContainText(/hover/i);
    await expect(figure).toContainText("Select an hour on a chart to see its exact figures.");
  });

  test("choosing an hour marks it on all three charts, and each prints its figures", async ({
    page,
    hasTouch,
  }) => {
    const figure = await openTaskPage(page);
    const wind = figure.locator(WIND);
    await expect(wind.locator("[data-chart-legend]")).toContainText("flying height ~1500 m");
    await expect(figure.locator("[data-chart-when]")).toHaveCount(0);

    await choose(figure.locator(`[data-met-chart="cloud"] [data-hour="${CHOSEN_MS}"]`), hasTouch);

    await expect(figure.locator("[data-selected]")).toHaveCount(3);
    await expect(figure.locator("[data-chart-when]")).toHaveText([
      "14:00–15:00 AEDT",
      "14:00–15:00 AEDT",
      "14:00–15:00 AEDT",
    ]);
    const legend = (chart: string) =>
      figure.locator(`[data-met-chart="${chart}"] [data-chart-legend]`);
    await expect(legend("wind")).toContainText("flying height 23 km/h WNW");
    await expect(legend("wind")).toContainText("surface 12 km/h W, gusting 25");
    await expect(legend("wind")).toContainText("direction 290°");
    // The hour leads the row, then the layers; the shading's scale is gone.
    await expect(legend("cloud")).toHaveText("14:00–15:00 AEDThigh 20%mid 40%low 0%");
    await expect(legend("height")).toContainText("thermal top 2950 m");
    await expect(legend("height")).toContainText("cloud base 3100 m");
    await expect(legend("height")).toContainText("blue");
    await expect(legend("height")).toContainText("CAPE 120 J/kg");
  });

  // The weather is what adds the Leg wind column, so this lives beside the
  // stub. 375 px is the narrowest current iPhone, narrower than the mobile
  // project's Pixel 7: at 393 px the table was 343 px in a 319 px box, with
  // the end of the leg wind off screen, because the turnpoint's radius and
  // elevation line could not wrap.
  test("the turnpoints table fits a 375 px phone with its Leg wind column", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openTaskPage(page);
    const table = page.getByRole("grid", { name: "Turnpoints" });
    await expect(table.getByRole("columnheader", { name: "Leg wind" })).toBeVisible();
    const fit = await table.evaluate((el) => ({
      table: Math.ceil(el.getBoundingClientRect().width),
      box: el.parentElement!.clientWidth,
    }));
    expect(fit.table).toBeLessThanOrEqual(fit.box);
  });

  test("arrow keys move the hour, and each hour is named with its figures", async ({ page }) => {
    const figure = await openTaskPage(page);
    const wind = figure.locator(WIND);
    const when = wind.locator("[data-chart-when]");

    const column = wind.locator(`[data-hour="${CHOSEN_MS}"]`);
    await expect(column).toHaveAttribute(
      "aria-label",
      "14:00–15:00 AEDT — 23 km/h from 290° (WNW) at ~1500 m, surface 12 km/h from 270° (W), gusting 25 km/h"
    );
    await column.focus();
    await expect(when).toContainText("14:00–15:00 AEDT");

    await page.keyboard.press("ArrowRight");
    await expect(when).toContainText("15:00–16:00 AEDT");
    await expect(wind.locator(`[data-hour="${CHOSEN_MS + HOUR_MS}"]`)).toBeFocused();
    await expect(figure.locator("[data-selected]")).toHaveCount(3);

    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(when).toContainText("13:00–14:00 AEDT");

    // One tab stop per chart: only the selected hour is in the tab order.
    await expect(wind.locator('[tabindex="0"]')).toHaveCount(1);
  });
});

test.describe("Task analysis → Weather", () => {
  test("all six charts are readable, and none of them asks for a hover", async ({ page }) => {
    const figure = await openAnalysisPage(page);
    const report = await measureLabels(figure);
    expect(report.texts).toBeGreaterThan(20);
    expect(report.small).toEqual([]);
    expect(report.clipped).toEqual([]);
    expect(report.sideways).toBe(false);

    await expect(figure).not.toContainText(/hover/i);
    await expect(figure).toContainText(
      "Select an hour or a leg on a chart to see its exact figures."
    );
    // What a hover over the takeoff lane used to say is printed.
    await expect(figure.locator('[data-day-chart="climb"] [data-chart-legend]')).toContainText(
      /takeoffs: \d+, \d\d:\d\d–\d\d:\d\d AEDT \(median \d\d:\d\d\)/
    );
  });

  test("one hour is marked through the whole stack, with each chart's own figures", async ({
    page,
    hasTouch,
  }) => {
    const figure = await openAnalysisPage(page);
    const climb = figure.locator('[data-day-chart="climb"]');
    const column = climb.locator("[data-hour]").nth(1);
    const label = (await column.getAttribute("aria-label")) ?? "";
    // "14:00–15:00 AEDT — median 1.4 m/s (p25–p75 …), 457 climbs"
    const [, hour, median] = label.match(/^(.+?) — median ([\d.]+ \S+) /) ?? [];
    expect(hour).toBeTruthy();

    await choose(column, hasTouch);

    // The band: the three modelled charts, wind by hour and climb by hour.
    await expect(figure.locator("[data-selected]")).toHaveCount(5);
    await expect(climb.locator("[data-chart-when]")).toHaveText(hour);
    await expect(climb.locator("[data-chart-legend]")).toContainText(`median climb ${median}`);
    await expect(climb.locator("[data-chart-legend]")).toContainText(/p10–p90 [\d.]+–[\d.]+/);
    await expect(
      figure.locator('[data-day-chart="wind"] [data-chart-legend]')
    ).toContainText(/wind speed [\d.]+ km\/h [NESW]+/);
    await expect(figure.locator(`${WIND} [data-chart-when]`)).toHaveText(hour);
  });

  // The page is the charts: the two cards are titled for their evidence, and
  // what each day metric measures is behind the ⓘ on the chart it draws
  // rather than a block of prose between the cards.
  test("two titled cards, with each metric's explanation behind its chart's ⓘ", async ({
    page,
  }) => {
    const figure = await openAnalysisPage(page);
    await expect(figure.locator('[data-slot="card-title"]')).toHaveText([
      "From the weather model",
      "From the pilots’ tracks",
    ]);
    await expect(figure.locator("[data-chart-source]")).toHaveText(
      Array(3).fill(/^\d+ tracks · measured$/)
    );
    // The explanation is not printed on the page...
    const climbHelp = /We group the thermal climbs of all pilots/;
    await expect(figure).not.toContainText(climbHelp);
    // ...it is one tap away, on the chart.
    await figure
      .locator('[data-day-chart="climb"]')
      .getByRole("button", { name: /^About How strong the day.s climbs were/ })
      .click();
    await expect(page.getByRole("dialog")).toContainText(climbHelp);
    await page.keyboard.press("Escape");

    // The exact figures are a link away.
    await expect(figure.getByRole("link", { name: /Metric details/ })).toHaveAttribute(
      "href",
      /\/analysis\/metrics$/
    );
  });

  test("a leg is a row that opens its full sentence", async ({ page }) => {
    const figure = await openAnalysisPage(page);
    const legs = figure.locator('[data-day-chart="legs"]');
    const first = legs.locator('[data-leg="0"]');
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await expect(legs.locator("[data-leg-detail]")).toHaveCount(0);

    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(legs.locator("[data-leg-detail]")).toHaveText(/ — flown \d\d:\d\d–\d\d:\d\d AEDT by \d+ pilots?/);

    // Arrow keys walk the legs; a second leg replaces the first.
    await page.keyboard.press("ArrowDown");
    await expect(legs.locator('[data-leg="1"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(legs.locator("[data-leg-detail]")).toHaveCount(1);
    await expect(first).toHaveAttribute("aria-expanded", "false");
  });
});
