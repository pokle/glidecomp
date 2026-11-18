import { describe, expect, it } from "vitest";
import type { WeatherHour } from "../../../weather/types";
import { cloudReading, flyingHeightLabel, heightReading, windReading } from "./met-readout";

const METRIC = { factor: 1, unit: "km/h" };
const METRES = { factor: 1, unit: "m" };
const FEET = { factor: 3.28084, unit: "ft" };

function hour(over: Partial<WeatherHour> = {}): WeatherHour {
  return {
    t: "2026-01-05T03:00:00.000Z",
    surface: {
      windDirectionDeg: 270,
      windSpeedKmh: 12,
      windGustKmh: 25,
      temperatureC: 28,
      dewPointC: 6,
    },
    levels: [
      { pressureHpa: 950, heightM: 540, windSpeedKmh: 15, windDirectionDeg: 280, temperatureC: 29 },
      { pressureHpa: 850, heightM: 1500, windSpeedKmh: 23, windDirectionDeg: 290, temperatureC: 19 },
    ],
    cloud: { lowPct: 0, midPct: 40, highPct: 20, totalPct: 50 },
    boundaryLayerDepthM: 2950,
    capeJkg: 120,
    shortwaveWm2: 700,
    precipitationMm: 0,
    cloudBaseAglM: 3100,
    ...over,
  } as WeatherHour;
}

describe("windReading", () => {
  it("gives flying height first, then the surface and the gust", () => {
    const h = hour();
    const label = flyingHeightLabel([h], 500, METRES);
    expect(label).toBe("~1500 m");
    expect(windReading(h, 500, METRIC, label)).toBe(
      "23 km/h from 290° (WNW) at ~1500 m, surface 12 km/h from 270° (W), gusting 25 km/h"
    );
  });

  it("gives the surface alone for a dataset with no levels", () => {
    const h = hour({ levels: [] });
    expect(flyingHeightLabel([h], 500, METRES)).toBeNull();
    expect(windReading(h, 500, METRIC, null)).toBe(
      "surface 12 km/h from 270° (W), gusting 25 km/h"
    );
  });

  it("is null when the hour has no wind at all", () => {
    const h = hour({
      levels: [],
      surface: {
        windDirectionDeg: null,
        windSpeedKmh: null,
        windGustKmh: null,
        temperatureC: null,
        dewPointC: null,
      },
    });
    expect(windReading(h, 500, METRIC, null)).toBeNull();
  });
});

describe("cloudReading", () => {
  it("reads the layers low first, and rain only when it fell", () => {
    expect(cloudReading(hour())).toBe("low 0%, mid 40%, high 20%");
    expect(cloudReading(hour({ precipitationMm: 0.24 }))).toBe(
      "low 0%, mid 40%, high 20%, rain 0.2 mm"
    );
  });

  it("is null with no cloud data", () => {
    expect(
      cloudReading(hour({ cloud: { lowPct: null, midPct: null, highPct: null, totalPct: null } }))
    ).toBeNull();
  });
});

describe("heightReading", () => {
  it("names both heights, which is lower, and CAPE", () => {
    expect(heightReading(hour(), METRES)).toBe(
      "thermal top 2950 m AGL, cloud base 3100 m AGL, blue, CAPE 120 J/kg"
    );
    expect(heightReading(hour({ cloudBaseAglM: 2000 }), METRES)).toContain("cumulus");
  });

  it("converts to the reader's unit", () => {
    expect(heightReading(hour({ capeJkg: null }), FEET)).toBe(
      "thermal top 9678 ft AGL, cloud base 10171 ft AGL, blue"
    );
  });

  it("does not call a day blue or cumulus on one height", () => {
    expect(heightReading(hour({ boundaryLayerDepthM: null, capeJkg: null }), METRES)).toBe(
      "cloud base 3100 m AGL"
    );
    expect(heightReading(hour({ boundaryLayerDepthM: null, cloudBaseAglM: null }), METRES)).toBeNull();
  });
});
