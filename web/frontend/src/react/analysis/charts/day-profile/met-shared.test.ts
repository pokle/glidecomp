import { describe, expect, it } from "vitest";
import { buildTimeAxis } from "./time-axis";
import {
  approxTextWidth,
  coverOpacity,
  isBlueHour,
  sampleOffset,
  usableCeilingM,
  weatherInstants,
} from "./met-shared";
import type { TaskWeather, WeatherHour } from "@/react/weather/types";

const T = (iso: string) => new Date(iso).getTime();

/** A weather hour with only the fields a given test cares about. */
function hour(overrides: Partial<WeatherHour> = {}): WeatherHour {
  return {
    t: "2026-01-10T03:00:00.000Z",
    surface: {
      windDirectionDeg: 290,
      windSpeedKmh: 14,
      windGustKmh: 20,
      temperatureC: 28,
      dewPointC: 10,
    },
    levels: [],
    cloud: { lowPct: 0, midPct: 0, highPct: 0, totalPct: 0 },
    boundaryLayerDepthM: 2000,
    capeJkg: null,
    shortwaveWm2: null,
    precipitationMm: 0,
    cloudBaseAglM: 2250,
    ...overrides,
  };
}

describe("coverOpacity", () => {
  it("draws nothing for a clear sky", () => {
    expect(coverOpacity(0)).toBe(0);
    expect(coverOpacity(-5)).toBe(0);
    expect(coverOpacity(NaN)).toBe(0);
  });

  it("makes a trace of cloud visibly different from clear", () => {
    // The whole reason for the floor: 5% cover has markers, 0% does not, and
    // a linear ramp from zero would render both as blank.
    expect(coverOpacity(5)).toBeGreaterThan(0.1);
  });

  it("rises with cover and saturates at overcast", () => {
    expect(coverOpacity(20)).toBeLessThan(coverOpacity(60));
    expect(coverOpacity(60)).toBeLessThan(coverOpacity(100));
    expect(coverOpacity(100)).toBeCloseTo(0.9, 5);
    expect(coverOpacity(140)).toBe(coverOpacity(100));
  });
});

describe("usableCeilingM", () => {
  it("takes the lower of the two ceilings", () => {
    expect(usableCeilingM(2400, 1800)).toBe(1800);
    expect(usableCeilingM(1500, 2600)).toBe(1500);
  });

  it("falls back to whichever single height the dataset has", () => {
    // ERA5 carries a boundary layer but no pressure levels; a provider with
    // no surface dewpoint carries no LCL. Both must still draw.
    expect(usableCeilingM(2400, null)).toBe(2400);
    expect(usableCeilingM(null, 1800)).toBe(1800);
  });

  it("is null when neither is known, so nothing is drawn", () => {
    expect(usableCeilingM(null, null)).toBeNull();
  });
});

describe("isBlueHour", () => {
  it("is blue when the thermals top out below any cloud", () => {
    expect(isBlueHour(hour({ boundaryLayerDepthM: 1800, cloudBaseAglM: 2600 }))).toBe(true);
  });

  it("is cumulus when cloud base is the lower ceiling", () => {
    expect(isBlueHour(hour({ boundaryLayerDepthM: 2600, cloudBaseAglM: 1800 }))).toBe(false);
  });

  it("refuses to answer on one number — the reading is a comparison", () => {
    expect(isBlueHour(hour({ cloudBaseAglM: null }))).toBeNull();
    expect(isBlueHour(hour({ boundaryLayerDepthM: null }))).toBeNull();
  });
});

describe("weatherInstants", () => {
  it("contributes each hour's start AND end", () => {
    const out = weatherInstants([{ t: "2026-01-10T03:00:00.000Z" }]);
    expect(out).toEqual([T("2026-01-10T03:00:00Z"), T("2026-01-10T04:00:00Z")]);
  });

  it("skips unparseable instants rather than poisoning the axis", () => {
    expect(weatherInstants([{ t: "not a time" }])).toEqual([]);
  });

  it("keeps the last hour's full column inside the shared axis domain", () => {
    // The reason ends are included: an axis stopping at the last hour's START
    // would clip half of its column off the right edge of every chart.
    const hours = [
      { t: "2026-01-10T02:00:00.000Z" },
      { t: "2026-01-10T03:00:00.000Z" },
    ];
    const axis = buildTimeAxis(weatherInstants(hours), "UTC", [0, 560])!;
    expect(axis.domainEnd).toBeGreaterThanOrEqual(T("2026-01-10T04:00:00Z"));
  });

  it("widens a flight-derived axis to cover the weather window", () => {
    // The stack shares ONE axis. Weather padded an hour either side of the
    // task must be inside it, or the charts would look aligned while
    // plotting the same instant at different x.
    const flightOnly = [T("2026-01-10T03:00:00Z"), T("2026-01-10T06:00:00Z")];
    const weather = weatherInstants([
      { t: "2026-01-10T02:00:00.000Z" },
      { t: "2026-01-10T06:00:00.000Z" },
    ]);
    const axis = buildTimeAxis([...flightOnly, ...weather], "UTC", [0, 560])!;
    expect(axis.domainStart).toBeLessThanOrEqual(T("2026-01-10T02:00:00Z"));
    expect(axis.domainEnd).toBeGreaterThanOrEqual(T("2026-01-10T07:00:00Z"));
    // Same axis object, so both series map an instant to the same x.
    expect(axis.x(T("2026-01-10T04:00:00Z"))).toBeGreaterThan(axis.x(T("2026-01-10T03:00:00Z")));
  });
});

describe("sampleOffset", () => {
  /** A stored answer whose grid point and elevation differ from the ask. */
  function weather(
    src: Partial<TaskWeather["source"]> = {},
    resolved: Partial<TaskWeather["resolved"]> = {}
  ): TaskWeather {
    return {
      source: {
        providerId: "p",
        model: "m",
        attribution: "a",
        attributionUrl: "https://example.invalid/",
        license: "CC BY 4.0",
        kind: "model",
        resolutionKm: null,
        variables: [],
        pointLat: -36.168716,
        pointLon: 147.85713,
        pointElevationM: 298,
        ...src,
      },
      resolved: { lat: -36.2, lon: 147.9, elevationM: 543, fromMs: 0, toMs: 0, ...resolved },
      hours: [],
      provisional: false,
      fetchedAt: "2026-01-10T00:00:00.000Z",
    };
  }

  it("measures how far the grid point sits from the point asked about", () => {
    const { distanceKm } = sampleOffset(weather());
    // Real Corryong numbers: a few km off the task centroid.
    expect(distanceKm).toBeGreaterThan(1);
    expect(distanceKm).toBeLessThan(10);
  });

  it("reports the grid's elevation error against the real terrain", () => {
    // The caveat that matters: every AGL height is measured from the grid's
    // datum, which here sits 245 m below the ground the pilots flew over.
    expect(sampleOffset(weather()).elevationDeltaM).toBe(298 - 543);
  });

  it("is signed, so a grid above the terrain reads differently", () => {
    expect(sampleOffset(weather({ pointElevationM: 900 })).elevationDeltaM).toBe(900 - 543);
  });

  it("returns null, not zero, when an elevation is unknown", () => {
    // Zero would assert "the grid is exactly right", which is a claim we
    // cannot make from missing data.
    expect(sampleOffset(weather({ pointElevationM: null })).elevationDeltaM).toBeNull();
    expect(sampleOffset(weather({}, { elevationM: null })).elevationDeltaM).toBeNull();
  });

  it("is ~0 km when the grid point is the point asked about", () => {
    const same = weather({ pointLat: -36.2, pointLon: 147.9 });
    expect(sampleOffset(same).distanceKm).toBeCloseTo(0, 3);
  });
});

describe("approxTextWidth", () => {
  it("scales with the font size", () => {
    expect(approxTextWidth("cloud base", 18)).toBeCloseTo(
      approxTextWidth("cloud base", 9) * 2,
      6
    );
  });

  it("runs slightly wide of the real labels, never short", () => {
    // Measured with getComputedTextLength() at 9 px in the UI sans. A short
    // estimate would print the swatch under the text; a long one only opens
    // the gap a little, so every one of these must land just OVER.
    const measured: [string, number][] = [
      ["thermal top", 50.7],
      ["cloud base", 48.0],
      ["surface (10 m)", 63.9],
      ["flying height ~1500 m", 95.7],
    ];
    for (const [text, real] of measured) {
      const est = approxTextWidth(text, 9);
      expect(est).toBeGreaterThanOrEqual(real);
      expect(est - real).toBeLessThan(6);
    }
  });

  it("charges narrow glyphs less than wide ones", () => {
    expect(approxTextWidth("iii", 9)).toBeLessThan(approxTextWidth("mmm", 9));
  });

  it("is empty for an empty string", () => {
    expect(approxTextWidth("", 9)).toBe(0);
  });
});
