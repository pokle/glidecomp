import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanAltitudes, type IGCFix } from "@glidecomp/engine";
import {
  TrackCleaningChart,
  bandRect,
  channelHealth,
  decimateSeries,
  zoomWindow,
} from "./TrackCleaningChart";

function fix(t: number, gnss: number, baro: number): IGCFix {
  return {
    time: new Date(Date.UTC(2026, 0, 10, 3, 0, t)),
    latitude: -36.5,
    longitude: 148.2,
    pressureAltitude: baro,
    gnssAltitude: gnss,
    valid: true,
  };
}

describe("channelHealth", () => {
  it("reports both channels alive when both are logged", () => {
    const fixes = Array.from({ length: 100 }, (_, i) => fix(i, 1500 + i, 1450 + i));
    expect(channelHealth(fixes)).toEqual({ gnssAlive: true, baroAlive: true });
  });

  it("calls the barometer dead for a scoring-server export (all zeros)", () => {
    const fixes = Array.from({ length: 100 }, (_, i) => fix(i, 1500 + i, 0));
    expect(channelHealth(fixes)).toEqual({ gnssAlive: true, baroAlive: false });
  });

  it("tolerates a handful of zero fixes in a live channel", () => {
    const fixes = Array.from({ length: 100 }, (_, i) =>
      fix(i, i < 5 ? 0 : 1500 + i, 1450 + i),
    );
    expect(channelHealth(fixes).gnssAlive).toBe(true);
  });

  it("calls the GPS channel dead for a pressure-only logger", () => {
    const fixes = Array.from({ length: 100 }, (_, i) => fix(i, 0, 1450 + i));
    expect(channelHealth(fixes)).toEqual({ gnssAlive: false, baroAlive: true });
  });
});

describe("zoomWindow", () => {
  const flight: [number, number] = [0, 3_600_000];

  it("gives a short repair the minimum context either side", () => {
    expect(zoomWindow({ startTimeMs: 600_000, endTimeMs: 603_000 }, flight)).toEqual([
      570_000, 633_000,
    ]);
  });

  it("scales the context to a long excursion", () => {
    expect(zoomWindow({ startTimeMs: 600_000, endTimeMs: 640_000 }, flight)).toEqual([
      520_000, 720_000,
    ]);
  });

  it("caps the context so a huge excursion is not lost in its own frame", () => {
    const [t0, t1] = zoomWindow({ startTimeMs: 900_000, endTimeMs: 1_500_000 }, flight);
    expect(t0).toBe(900_000 - 120_000);
    expect(t1).toBe(1_500_000 + 120_000);
  });

  it("clamps to the flight, so a repair at take-off is not framed before it", () => {
    expect(zoomWindow({ startTimeMs: 1_000, endTimeMs: 2_000 }, flight)).toEqual([
      0, 32_000,
    ]);
  });
});

describe("decimateSeries", () => {
  const flat: Array<[number, number]> = Array.from({ length: 2_000 }, (_, i) => [
    i * 1_000,
    1_500,
  ]);

  it("leaves a series that already fits alone", () => {
    const points = flat.slice(0, 40);
    expect(decimateSeries(points, 40)).toBe(points);
  });

  it("thins a long series to roughly four points per bucket", () => {
    const out = decimateSeries(flat, 100);
    expect(out.length).toBeLessThan(flat.length / 4);
    expect(out.length).toBeGreaterThan(0);
  });

  it("keeps a one-sample spike — the whole point of the chart", () => {
    const points = [...flat];
    points[1_234] = [1_234_000, -9_600];
    const out = decimateSeries(points, 100);
    expect(out).toContainEqual([1_234_000, -9_600]);
  });

  it("keeps a one-sample dropout to zero", () => {
    const points = [...flat];
    points[777] = [777_000, 0];
    expect(decimateSeries(points, 100)).toContainEqual([777_000, 0]);
  });

  it("returns points in ascending time order", () => {
    const points = [...flat];
    points[500] = [500_000, 4_000];
    points[501] = [501_000, -1_000];
    const out = decimateSeries(points, 120);
    for (let i = 1; i < out.length; i++) {
      expect(out[i][0]).toBeGreaterThan(out[i - 1][0]);
    }
  });
});

describe("bandRect", () => {
  const plot = { left: 48, right: 550 };

  it("draws a wide repair at its true extent", () => {
    expect(bandRect(100, 180, 2.5, plot)).toEqual({ x: 100, width: 80 });
  });

  it("widens a hairline around its own centre", () => {
    expect(bandRect(200, 202, 10, plot)).toEqual({ x: 196, width: 10 });
  });

  it("keeps a widened band inside the plot at either edge", () => {
    expect(bandRect(48, 49, 10, plot).x).toBe(48);
    expect(bandRect(549, 550, 10, plot)).toEqual({ x: 540, width: 10 });
  });

  it("never exceeds the plot width", () => {
    const r = bandRect(0, 900, 10, plot);
    expect(r).toEqual({ x: 48, width: 502 });
  });
});

/**
 * Rendered output. The bundled sample comps are all scoring-server exports
 * with no barometric channel, so the two-channel figure — the one the
 * explainer is really about — can only be exercised here: a synthetic
 * two-channel track, judged by the REAL cleaning engine, drawn by the real
 * component.
 */
describe("TrackCleaningChart rendering", () => {
  /** Steady climb with a GNSS-only spike the barometer refuses to confirm. */
  function twoChannelTrack(): IGCFix[] {
    const fixes: IGCFix[] = [];
    for (let t = 0; t <= 240; t++) {
      const alt = 1850 + t * 1.2;
      const gnss = t >= 118 && t <= 121 ? alt + 340 : alt;
      fixes.push(fix(t, Math.round(gnss), Math.round(alt - 45)));
    }
    return fixes;
  }

  function draw(fixes: IGCFix[], selected: number | null = null) {
    const report = cleanAltitudes(fixes);
    expect(report.repairedFixCount).toBeGreaterThan(0);
    return renderToStaticMarkup(
      createElement(TrackCleaningChart, {
        fixes,
        ranges: report.ranges,
        selected,
        timezone: "Australia/Melbourne",
        onSelectRange: () => {},
      }),
    );
  }

  it("draws GPS, barometer and cleaned when the file has both channels", () => {
    const html = draw(twoChannelTrack());
    expect(html).toContain("stroke-chart-1"); // raw GPS
    expect(html).toContain("stroke-chart-3"); // raw barometer
    expect(html).toContain("stroke-chart-2"); // cleaned
    expect(html).toContain("raw barometer");
    expect(html).toContain("raw barometric altitude");
  });

  it("omits a barometer that isn't in the file, and says so", () => {
    const gpsOnly = twoChannelTrack().map((f) => ({ ...f, pressureAltitude: 0 }));
    const html = draw(gpsOnly);
    expect(html).toContain("stroke-chart-1");
    expect(html).not.toContain("stroke-chart-3");
    expect(html).toContain("no barometric channel");
  });

  it("frames the whole flight by default and one repair when selected", () => {
    const fixes = twoChannelTrack();
    expect(draw(fixes)).toContain("repaired stretch");
    expect(draw(fixes, 0)).toContain("The repair at");
  });

  it("renders nothing when neither altimeter is in the file", () => {
    const dead = twoChannelTrack().map((f) => ({
      ...f,
      gnssAltitude: 0,
      pressureAltitude: 0,
    }));
    const html = renderToStaticMarkup(
      createElement(TrackCleaningChart, {
        fixes: dead,
        ranges: [{
          startIndex: 0, endIndex: 1, startTimeMs: dead[0].time.getTime(),
          endTimeMs: dead[1].time.getTime(), fixCount: 2,
          maxCorrectionMeters: 10, method: "rate" as const,
        }],
        selected: null,
        timezone: null,
        onSelectRange: () => {},
      }),
    );
    expect(html).toBe("");
  });
});
