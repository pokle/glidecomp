import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewBlock, type OverviewBlockProps } from "./OverviewBlock";
import type {
  FieldAnalysisBasis,
  FieldAnalysisReport,
  FieldThermalsSummary,
  MetricFamily,
  MetricReport,
  StyleClusterReport,
  WindHourlySeries,
  ClimbHourlySeries,
} from "./types";
import type { TaskWeather } from "@/react/weather/types";
import { metricsByFamily } from "./MetricFamilySection";

function createMetric(
  id: string,
  family: MetricFamily,
  extra: Partial<MetricReport> = {}
): MetricReport {
  return {
    id,
    label: `Metric ${id}`,
    unit: "s",
    family,
    direction: "higher",
    explanation: "test metric",
    perPilot: [],
    correlation: {
      metricId: id,
      rho: -0.6,
      absRho: 0.6,
      n: 20,
      verdict: "strong",
    },
    ...extra,
  };
}

const DEFAULT_BASIS: FieldAnalysisBasis = {
  pilotCount: 32,
  gridStepSeconds: 10,
  sharedThermalCount: 120,
  multiPilotThermalCount: 82,
  workingBandFloor: 900,
  workingBandCeiling: 2500,
  workingBandFallback: false,
  analysisWindow: {
    from: "2026-01-07T02:46:00Z",
    to: "2026-01-07T07:33:00Z",
  },
};

const WIND_HOURLY_SERIES: WindHourlySeries = {
  id: "day.wind.hourly",
  title: "Wind by hour",
  kind: "wind-hourly",
  hours: [
    { t: "2026-01-07T03:00:00Z", speedKmh: 18, directionDeg: 270, n: 10 },
  ],
  wholeTask: {
    speedKmh: 19.2,
    directionDeg: 270, // West
    n: 40,
  },
};

const CLIMB_HOURLY_SERIES: ClimbHourlySeries = {
  id: "day.climb.hourly",
  title: "Climb by hour",
  kind: "climb-hourly",
  hours: [],
  wholeTask: {
    p10: 0.8,
    p25: 1.0,
    median: 1.34,
    p75: 1.7,
    p90: 2.1,
    n: 82,
  },
};

function createReport(
  basis: FieldAnalysisBasis = DEFAULT_BASIS,
  metrics: MetricReport[] = [],
  thermalsCount = 10
): FieldAnalysisReport {
  return {
    basis,
    pilots: [
      { trackFile: "a.igc", pilotName: "Pilot A", rank: 1 },
      { trackFile: "b.igc", pilotName: "Pilot B", rank: 2 },
    ],
    metrics,
    thermals:
      thermalsCount > 0
        ? {
            shapes: Array.from({ length: thermalsCount }, (_, i) => ({
              id: i + 1,
            })) as unknown as FieldThermalsSummary["shapes"],
            totalShapeCount: thermalsCount,
          }
        : undefined,
  };
}

function renderBlock(props: Partial<OverviewBlockProps> = {}): string {
  const metrics = props.report?.metrics ?? [
    createMetric("glide.speed", "gliding"),
    createMetric("climb.rate", "climbing"),
    createMetric("day.wind", "day", {
      extraSeries: [WIND_HOURLY_SERIES],
    }),
    createMetric("day.climb_by_hour", "day", {
      extraSeries: [CLIMB_HOURLY_SERIES],
    }),
  ];
  const report = props.report ?? createReport(DEFAULT_BASIS, metrics);
  const grouped = props.grouped ?? metricsByFamily(report.metrics);
  const dayMetrics = props.dayMetrics ?? (grouped.get("day") ?? []);

  const fullProps: OverviewBlockProps = {
    report,
    excluded: props.excluded ?? [
      { pilot_name: "Excluded 1", reason: "Manual flight" },
      { pilot_name: "Excluded 2", reason: "Corrupt track" },
    ],
    grouped,
    dayMetrics,
    weather: props.weather ?? null,
    weatherPending: props.weatherPending ?? false,
    compTimezone: props.compTimezone ?? "Australia/Sydney",
    hasWeatherSection: props.hasWeatherSection ?? true,
    hasThermalsSection: props.hasThermalsSection ?? true,
    hasDebrief: props.hasDebrief ?? true,
    styleClusters: (props.styleClusters !== undefined
      ? props.styleClusters
      : {
          pilotCount: 20,
          metricCount: 8,
          k: 2,
          kMin: 2,
          kMax: 4,
          meanSilhouette: 0.45,
          explanation: "Test clustering",
          clusters: [
            {
              id: 1,
              label: "high leavers",
              exemplarTrackFile: "a.igc",
              members: [],
              signatures: [],
              rankBest: 1,
              rankWorst: 10,
              rankMedian: 5,
              rankP25: 3,
              rankP75: 8,
            },
            {
              id: 2,
              label: "bold leavers",
              exemplarTrackFile: "b.igc",
              members: [],
              signatures: [],
              rankBest: 2,
              rankWorst: 12,
              rankMedian: 7,
              rankP25: 4,
              rankP75: 10,
            },
          ],
          unclustered: [],
        }) as unknown as StyleClusterReport,
    ...props,
  };

  return renderToStaticMarkup(createElement(OverviewBlock, fullProps));
}

describe("OverviewBlock", () => {
  it("renders all four stage headings and navigation links", () => {
    const html = renderBlock();
    expect(html).toContain('aria-label="Report contents"');
    expect(html).toContain("The day they flew");
    expect(html).toContain("What separated the field");
    expect(html).toContain("Where each pilot sat");
    expect(html).toContain("How it was measured");

    expect(html).toContain('href="#analysis-basis"');
    expect(html).toContain('href="#weather-heading"');
    expect(html).toContain('href="#thermals-heading"');
    expect(html).toContain('href="#debrief-heading"');
    expect(html).toContain('href="#separation-heading"');
    expect(html).toContain('href="#heatmap-heading"');
    expect(html).toContain('href="#clusters-heading"');
    expect(html).toContain('href="#families-heading"');
    expect(html).toContain('href="#footnotes-heading"');
  });

  describe("state lines and fallbacks", () => {
    it("renders Analysis basis with analysis window in comp timezone", () => {
      const html = renderBlock();
      expect(html).toContain("32 pilots · 13:46–18:33 AEDT");
    });

    it("falls back to pilots analysed when analysisWindow is absent", () => {
      const basisNoWindow: FieldAnalysisBasis = {
        ...DEFAULT_BASIS,
        analysisWindow: undefined,
      };
      const html = renderBlock({ report: createReport(basisNoWindow) });
      expect(html).toContain("32 pilots analysed");
      expect(html).not.toContain("13:46");
    });

    it("renders Weather node from pilots tracks with wind and climbs", () => {
      const html = renderBlock();
      expect(html).toContain("19 km/h W · climbs 1.3 m/s");
      expect(html).toContain("From the pilots&#x27; tracks");
    });

    it("renders Weather node from pilots tracks with wind only", () => {
      const metrics = [
        createMetric("day.wind", "day", {
          extraSeries: [WIND_HOURLY_SERIES],
        }),
      ];
      const html = renderBlock({ report: createReport(DEFAULT_BASIS, metrics) });
      expect(html).toContain("19 km/h W");
      expect(html).not.toContain("climbs");
      expect(html).toContain("From the pilots&#x27; tracks");
    });

    it("renders Weather node from weather model when tracks have no wholeTask", () => {
      const mockWeather: TaskWeather = {
        source: {
          providerId: "open-meteo",
          model: "ECMWF IFS",
          attribution: "Open-Meteo",
          attributionUrl: "https://open-meteo.com",
          license: "CC BY 4.0",
          kind: "model",
          resolutionKm: 9,
          variables: ["surface_wind"],
          pointLat: -36.2,
          pointLon: 147.8,
          pointElevationM: 400,
        },
        resolved: {
          lat: -36.2,
          lon: 147.8,
          elevationM: 400,
          fromMs: 0,
          toMs: 3600000,
        },
        hours: [
          {
            t: "2026-01-07T03:00:00Z",
            surface: {
              windSpeedKmh: 22,
              windDirectionDeg: 270,
              windGustKmh: null,
              temperatureC: null,
              dewPointC: null,
            },
            levels: [],
            cloud: { lowPct: null, midPct: null, highPct: null, totalPct: null },
            boundaryLayerDepthM: null,
            capeJkg: null,
            shortwaveWm2: null,
            precipitationMm: null,
            cloudBaseAglM: null,
          },
        ],
        provisional: false,
        fetchedAt: "2026-01-07T08:00:00Z",
      };

      const metrics = [createMetric("day.wind", "day")]; // no extraSeries with wholeTask
      const html = renderBlock({
        report: createReport(DEFAULT_BASIS, metrics),
        weather: mockWeather,
      });
      expect(html).toContain("22 km/h W");
      expect(html).toContain("From the weather model");
      expect(html).not.toContain("From the pilots&#x27; tracks");
    });

    it("falls back to descriptive weather line when neither tracks nor model are available", () => {
      const metrics = [createMetric("day.wind", "day")]; // no extraSeries
      const html = renderBlock({
        report: createReport(DEFAULT_BASIS, metrics),
        weather: null,
      });
      expect(html).toContain(
        "How the wind, climbs and cloudbase moved through the day"
      );
      expect(html).not.toContain("From the pilots&#x27; tracks");
      expect(html).not.toContain("From the weather model");
    });

    it("renders Thermals state line", () => {
      const html = renderBlock();
      expect(html).toContain("82 thermals shared by two or more pilots");
    });

    it("renders Style clusters state line and handles too few pilots fallback", () => {
      const html = renderBlock();
      expect(html).toContain("2 groups — high leavers, bold leavers");

      const htmlNoClusters = renderBlock({ styleClusters: null });
      expect(htmlNoClusters).toContain("Too few pilots to group by style");
    });

    it("renders Metrics in detail count", () => {
      const metrics = [
        createMetric("m1", "gliding"),
        createMetric("m2", "climbing"),
        createMetric("m3", "decision"),
      ];
      const html = renderBlock({ report: createReport(DEFAULT_BASIS, metrics) });
      expect(html).toContain("3 families · 3 metrics, with their charts");
    });

    it("renders Footnotes state line with excluded count and handles 0 excluded", () => {
      const html = renderBlock({
        excluded: [{ pilot_name: "Pilot X", reason: "Manual" }],
      });
      expect(html).toContain("1 pilot not analysed · ");

      const htmlZeroExcluded = renderBlock({ excluded: [] });
      expect(htmlZeroExcluded).toContain(
        "How the field is compared, and every metric defined"
      );
    });

    it("renders Behaviour ranking state line", () => {
      const html = renderBlock();
      expect(html).toContain("behaviours, strongest correlation first");
    });
  });

  describe("conditional nodes", () => {
    it("omits weather node when hasWeatherSection is false", () => {
      const html = renderBlock({ hasWeatherSection: false });
      expect(html).not.toContain('href="#weather-heading"');
      expect(html).not.toContain("What the weather did");
      // Stage 1 heading is still rendered because Analysis basis is present
      expect(html).toContain("The day they flew");
      expect(html).toContain('href="#analysis-basis"');
    });

    it("omits thermals node when hasThermalsSection is false", () => {
      const html = renderBlock({ hasThermalsSection: false });
      expect(html).not.toContain('href="#thermals-heading"');
      expect(html).not.toContain("The day&#x27;s thermals");
    });

    it("omits debrief node when hasDebrief is false", () => {
      const html = renderBlock({ hasDebrief: false });
      expect(html).not.toContain('href="#debrief-heading"');
      expect(html).not.toContain("Task debrief");
      // Behaviour ranking is still present in Stage 2
      expect(html).toContain('href="#separation-heading"');
      expect(html).toContain("Behaviour ranking");
    });
  });
});
