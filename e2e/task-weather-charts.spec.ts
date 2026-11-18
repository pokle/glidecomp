/**
 * The task page's weather charts on a phone and on a desktop (issue #860).
 *
 * The three charts (wind, cloud, thermal ceiling) were one 560-unit drawing
 * scaled to the page, so on a phone their labels were painted at 5px, and
 * their exact figures answered a mouse hover and nothing else: a tap did
 * nothing and a keyboard could not reach them.
 *
 * What this spec pins:
 * - every label in the charts is PAINTED at 11px or more, measured after the
 *   SVG's own scaling — a class or a `font-size` attribute says nothing about
 *   that, which is how the old charts said "10px" and painted 5.7;
 * - no label runs off its chart, and the page does not scroll sideways;
 * - choosing an hour (a tap on a phone, the pointer on a desktop) marks that
 *   hour in all three charts and prints all three charts' figures for it;
 * - arrow keys move the hour;
 * - nothing tells a reader to hover.
 *
 * The weather answer is a fixture served by `page.route`: the real one comes
 * from an outside provider, and its numbers are not ours to assert on. It is
 * a whole daylight day on purpose — about fifteen hour columns, the narrow
 * case a task with no launch window produces.
 *
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp. Never waits
 * on "networkidle": the task page keeps a freshness poll in flight.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures/test";
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

/** Open the task page with the fixture weather and wait for the charts. */
async function openCharts(page: Page) {
  await page.route("**/api/comp/*/task/*/weather", (route) =>
    route.fulfill({ json: weatherFixture() })
  );
  await page.goto(`/comp/${compId}/task/${taskId}`, { waitUntil: "domcontentloaded" });
  const figure = page.locator("figure", { has: page.locator('[data-met-chart="wind"]') });
  await expect(figure.locator("[data-met-chart]")).toHaveCount(3);
  // The frame is measured after mount; the charts are laid out for the real
  // width once the viewBox is as wide as the chart is drawn.
  await expect
    .poll(() =>
      figure.locator('[data-met-chart="wind"] svg[role="group"]').evaluate((svg) => {
        const el = svg as SVGSVGElement;
        return Math.abs(el.viewBox.baseVal.width - el.getBoundingClientRect().width);
      })
    )
    .toBeLessThan(1);
  return figure;
}

test("every chart label is painted at a readable size and stays on its chart", async ({
  page,
}) => {
  const figure = await openCharts(page);

  const report = await figure.evaluate((fig) => {
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
    // The titles, the source stamp, the legends and the readout are text
    // beside the SVGs.
    for (const el of fig.querySelectorAll<HTMLElement>("p, span")) {
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

  expect(report.texts).toBeGreaterThan(10);
  expect(report.small).toEqual([]);
  expect(report.clipped).toEqual([]);
  expect(report.sideways).toBe(false);

  // The source is on every chart, and nothing asks for a hover.
  await expect(figure.locator("[data-met-source]")).toHaveCount(3);
  await expect(figure).not.toContainText(/hover/i);
});

test("choosing an hour marks it on all three charts and prints their figures", async ({
  page,
  hasTouch,
}) => {
  const figure = await openCharts(page);
  const readout = figure.locator("[data-met-readout]");
  await expect(readout).toHaveText("Select an hour on a chart to see its exact figures.");

  const column = figure.locator(`[data-met-chart="cloud"] [data-hour="${CHOSEN_MS}"]`);
  if (hasTouch) await column.tap();
  else await column.hover();

  await expect(figure.locator("[data-selected]")).toHaveCount(3);
  await expect(readout).toContainText("14:00–15:00 AEDT");
  await expect(readout).toContainText(
    "Wind: 23 km/h from 290° (WNW) at ~1500 m, surface 12 km/h from 270° (W), gusting 25 km/h"
  );
  await expect(readout).toContainText("Cloud: low 0%, mid 40%, high 20%");
  await expect(readout).toContainText(
    "Height: thermal top 2950 m AGL, cloud base 3100 m AGL, blue, CAPE 120 J/kg"
  );
});

test("arrow keys move the hour, and each hour is named with its figures", async ({ page }) => {
  const figure = await openCharts(page);
  const readout = figure.locator("[data-met-readout]");
  const wind = figure.locator('[data-met-chart="wind"]');

  const column = wind.locator(`[data-hour="${CHOSEN_MS}"]`);
  await expect(column).toHaveAttribute(
    "aria-label",
    "14:00–15:00 AEDT — 23 km/h from 290° (WNW) at ~1500 m, surface 12 km/h from 270° (W), gusting 25 km/h"
  );
  await column.focus();
  await expect(readout).toContainText("14:00–15:00 AEDT");

  await page.keyboard.press("ArrowRight");
  await expect(readout).toContainText("15:00–16:00 AEDT");
  await expect(wind.locator(`[data-hour="${CHOSEN_MS + HOUR_MS}"]`)).toBeFocused();
  await expect(figure.locator("[data-selected]")).toHaveCount(3);

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(readout).toContainText("13:00–14:00 AEDT");

  // One tab stop per chart: only the selected hour is in the tab order.
  await expect(wind.locator('[tabindex="0"]')).toHaveCount(1);
});
