import { describe, expect, it } from "vitest";
import type { TaskWeather, WeatherHour } from "@glidecomp/engine";
import { legWind, legWindWord, taskWindFromWeather, type TaskWind } from "./task-wind";

function hour(
  overrides: {
    surface?: { dir: number | null; kmh: number | null };
    level?: { dir: number | null; kmh: number | null; heightM?: number };
  } = {}
): WeatherHour {
  return {
    t: "2026-01-05T03:00:00Z",
    surface: {
      windDirectionDeg: overrides.surface?.dir ?? null,
      windSpeedKmh: overrides.surface?.kmh ?? null,
      windGustKmh: null,
      temperatureC: null,
      dewPointC: null,
    },
    levels: overrides.level
      ? [
          {
            pressureHpa: 850,
            heightM: overrides.level.heightM ?? 1500,
            windDirectionDeg: overrides.level.dir,
            windSpeedKmh: overrides.level.kmh,
            temperatureC: null,
          },
        ]
      : [],
    cloud: { lowPct: null, midPct: null, highPct: null, totalPct: null },
    boundaryLayerDepthM: null,
    capeJkg: null,
    shortwaveWm2: null,
    precipitationMm: null,
  } as WeatherHour;
}

function weather(hours: WeatherHour[], elevationM: number | null = 500): TaskWeather {
  return {
    source: {} as TaskWeather["source"],
    resolved: { lat: -36, lon: 148, elevationM, fromMs: 0, toMs: 0 },
    hours,
    provisional: false,
    fetchedAt: "2026-01-05T09:00:00Z",
  };
}

describe("taskWindFromWeather", () => {
  it("returns null without weather or hours", () => {
    expect(taskWindFromWeather(null)).toBeNull();
    expect(taskWindFromWeather(weather([]))).toBeNull();
  });

  it("returns null when no hour carries a usable wind", () => {
    expect(taskWindFromWeather(weather([hour(), hour()]))).toBeNull();
  });

  it("averages the flying-height level when the dataset has one", () => {
    const wind = taskWindFromWeather(
      weather([
        hour({ level: { dir: 270, kmh: 20 }, surface: { dir: 90, kmh: 5 } }),
        hour({ level: { dir: 270, kmh: 30 }, surface: { dir: 90, kmh: 5 } }),
      ])
    )!;
    expect(wind.fromDeg).toBeCloseTo(270, 5);
    expect(wind.speedKmh).toBeCloseTo(25, 5);
    expect(wind.level).toBe("flying");
    expect(wind.heightM).toBe(1500);
    expect(wind.hours).toBe(2);
  });

  it("falls back to surface only when NO hour has a level", () => {
    // Mixing a 1500 m wind with a screen-height one would average two
    // different quantities; the fallback is all-or-nothing on purpose.
    const wind = taskWindFromWeather(
      weather([hour({ surface: { dir: 180, kmh: 10 } }), hour({ surface: { dir: 180, kmh: 14 } })])
    )!;
    expect(wind.level).toBe("surface");
    expect(wind.heightM).toBeNull();
    expect(wind.fromDeg).toBeCloseTo(180, 5);
    expect(wind.speedKmh).toBeCloseTo(12, 5);
  });

  it("takes the circular mean, not the arithmetic one", () => {
    // 350° and 10° average to 0°, not to 180°.
    const wind = taskWindFromWeather(
      weather([hour({ level: { dir: 350, kmh: 20 } }), hour({ level: { dir: 10, kmh: 20 } })])
    )!;
    expect(wind.fromDeg).toBeCloseTo(0, 4);
  });
});

describe("legWind", () => {
  const wind: TaskWind = {
    fromDeg: 270,
    speedKmh: 20,
    hours: 4,
    level: "flying",
    heightM: 1500,
  };

  it("calls a leg into the wind a headwind", () => {
    const leg = legWind(wind, 270);
    expect(leg.alongKmh).toBeCloseTo(20, 6);
    expect(leg.crossKmh).toBeCloseTo(0, 6);
    expect(leg.kind).toBe("head");
  });

  it("calls a leg with the wind behind it a tailwind", () => {
    const leg = legWind(wind, 90);
    expect(leg.alongKmh).toBeCloseTo(-20, 6);
    expect(leg.kind).toBe("tail");
  });

  it("calls a perpendicular leg a crosswind", () => {
    const north = legWind(wind, 0);
    expect(north.alongKmh).toBeCloseTo(0, 6);
    expect(north.crossKmh).toBeCloseTo(20, 6);
    expect(north.kind).toBe("cross");
  });

  it("lets the dominant component name a quartering leg", () => {
    // The crossover is 45°: inside that the along-course component is the
    // larger one, so the leg is still a headwind.
    const quartering = legWind(wind, 270 - 30);
    expect(quartering.kind).toBe("head");
    expect(quartering.alongKmh).toBeGreaterThan(quartering.crossKmh);
    // Past 45° off, the across-course component wins.
    expect(legWind(wind, 270 - 60).kind).toBe("cross");
  });

  it("keeps the along-course sign on a crosswind leg", () => {
    // Wind from 270 means the downwind heading is 090. A leg on 170 is 100°
    // off the wind's source: mostly across, but with the wind still nudging
    // it along — and the negative sign is what tells a pilot that.
    const leg = legWind(wind, 170);
    expect(leg.kind).toBe("cross");
    expect(leg.alongKmh).toBeLessThan(0);
  });

  it("is symmetric about the wind axis", () => {
    const left = legWind(wind, 270 - 30);
    const right = legWind(wind, 270 + 30);
    expect(left.alongKmh).toBeCloseTo(right.alongKmh, 6);
    expect(left.crossKmh).toBeCloseTo(right.crossKmh, 6);
  });

  it("handles bearings that wrap the compass", () => {
    const w: TaskWind = { ...wind, fromDeg: 10 };
    expect(legWind(w, 350).kind).toBe("head");
    expect(legWind(w, 190).kind).toBe("tail");
  });
});

describe("legWindWord", () => {
  it("names each kind", () => {
    expect(legWindWord("head")).toBe("headwind");
    expect(legWindWord("tail")).toBe("tailwind");
    expect(legWindWord("cross")).toBe("crosswind");
  });
});
