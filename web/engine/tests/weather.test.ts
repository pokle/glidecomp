import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_FLYING_HEIGHT_AGL_M,
  NoWeatherAvailable,
  fetchTaskWeather,
  flyingHeightLevel,
  lclHeightAglM,
  openMeteoEra5Provider,
  openMeteoHistoricalForecastProvider,
  pressureToHeightM,
  heightToPressureHpa,
  selectProviders,
  taskCentroid,
  taskElevationM,
  weatherQueryForTask,
  weatherQueryKey,
  type TaskWeather,
  type WeatherFetchFn,
  type WeatherProvider,
  type WeatherQuery,
} from '../src/weather';
import type { XCTask } from '../src/xctsk-parser';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal gated race near Corryong, with a launch window and a deadline. */
function racetask(): XCTask {
  return {
    version: 1,
    taskType: 'CLASSIC',
    turnpoints: [
      { type: 'TAKEOFF', radius: 400, waypoint: { name: 'LAUNCH', lat: -36.2, lon: 147.9, altSmoothed: 800 } },
      { type: 'SSS', radius: 5000, waypoint: { name: 'SSS', lat: -36.2, lon: 147.9, altSmoothed: 800 } },
      { type: null, radius: 2000, waypoint: { name: 'TP1', lat: -36.0, lon: 148.1, altSmoothed: 700 } },
      { type: 'ESS', radius: 1000, waypoint: { name: 'GOAL', lat: -36.4, lon: 147.7, altSmoothed: 300 } },
    ],
    sss: { type: 'RACE', direction: 'EXIT', timeGates: ['03:00:00'] },
    goal: { type: 'CYLINDER', deadline: '08:00:00' },
    takeoff: { timeOpen: '01:30:00', timeClose: '04:00:00' },
  } as unknown as XCTask;
}

/** A fetch stand-in returning one canned Open-Meteo payload. */
function stubFetch(body: unknown, ok = true, status = 200): WeatherFetchFn {
  return async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

/** An Open-Meteo-shaped response covering three UTC hours from 02:00. */
function openMeteoBody(overrides: Record<string, unknown> = {}) {
  return {
    latitude: -36.17,
    longitude: 147.86,
    elevation: 298,
    hourly: {
      time: ['2026-01-10T01:00', '2026-01-10T02:00', '2026-01-10T03:00', '2026-01-10T04:00'],
      temperature_2m: [20, 24, 27, 28],
      dew_point_2m: [12, 12, 11, 11],
      wind_speed_10m: [8, 11, 16, 18],
      wind_direction_10m: [310, 306, 300, 291],
      wind_gusts_10m: [14, 20, 28, 30],
      cloud_cover: [0, 10, 25, 40],
      cloud_cover_low: [0, 5, 20, 35],
      cloud_cover_mid: [0, 5, 5, 5],
      cloud_cover_high: [0, 0, 0, 0],
      precipitation: [0, 0, 0, 0],
      boundary_layer_height: [900, 1600, 2400, 2600],
      shortwave_radiation: [600, 814, 771, 639],
      cape: [10, 120, 300, 260],
      wind_speed_950hPa: [20, 24, 28, 30],
      wind_direction_950hPa: [300, 298, 292, 288],
      temperature_950hPa: [19, 21, 23, 23],
      wind_speed_900hPa: [30, 36, 39, 42],
      wind_direction_900hPa: [290, 288, 283, 281],
      temperature_900hPa: [16, 18, 19, 19],
      wind_speed_850hPa: [40, 45, 47, 46],
      wind_direction_850hPa: [285, 284, 280, 279],
      temperature_850hPa: [13, 14, 15, 15],
      ...overrides,
    },
  };
}

const NOW_MS = Date.UTC(2026, 5, 1); // long after the fixture day: not provisional

// ---------------------------------------------------------------------------
// Derived quantities
// ---------------------------------------------------------------------------

describe('lclHeightAglM', () => {
  it('applies 125 m per degree of spread', () => {
    expect(lclHeightAglM(24, 12)).toBe(1500);
    expect(lclHeightAglM(30, 5)).toBe(3125);
  });

  it('returns null rather than a guess when inputs are missing', () => {
    expect(lclHeightAglM(null, 12)).toBeNull();
    expect(lclHeightAglM(24, null)).toBeNull();
    expect(lclHeightAglM(undefined, undefined)).toBeNull();
    expect(lclHeightAglM(NaN, 12)).toBeNull();
  });

  it('returns null in saturated air, where the reading is meaningless', () => {
    expect(lclHeightAglM(12, 12)).toBeNull();
    expect(lclHeightAglM(10, 14)).toBeNull();
  });
});

describe('pressure/height conversion', () => {
  it('puts the standard levels near their textbook heights', () => {
    expect(pressureToHeightM(1013.25)).toBeCloseTo(0, 5);
    expect(pressureToHeightM(900)).toBeGreaterThan(950);
    expect(pressureToHeightM(900)).toBeLessThan(1050);
    expect(pressureToHeightM(850)).toBeGreaterThan(1400);
    expect(pressureToHeightM(850)).toBeLessThan(1550);
  });

  it('round-trips', () => {
    for (const hpa of [950, 900, 850, 700]) {
      expect(heightToPressureHpa(pressureToHeightM(hpa))).toBeCloseTo(hpa, 4);
    }
  });
});

describe('flyingHeightLevel', () => {
  const levels = [
    { pressureHpa: 950, heightM: 540, windSpeedKmh: 24, windDirectionDeg: 298, temperatureC: 21 },
    { pressureHpa: 900, heightM: 990, windSpeedKmh: 36, windDirectionDeg: 288, temperatureC: 18 },
    { pressureHpa: 850, heightM: 1460, windSpeedKmh: 45, windDirectionDeg: 284, temperatureC: 14 },
    { pressureHpa: 700, heightM: 3010, windSpeedKmh: 90, windDirectionDeg: 270, temperatureC: 2 },
  ];

  it('picks the level nearest terrain + working height, not the surface', () => {
    // 800 m terrain + 1000 m default → 1800 m, nearest is 850 hPa.
    expect(flyingHeightLevel(levels, 800)?.pressureHpa).toBe(850);
    // Flatland launch at 100 m → 1100 m, nearest is 900 hPa.
    expect(flyingHeightLevel(levels, 100)?.pressureHpa).toBe(900);
  });

  it('honours an explicit working height', () => {
    expect(flyingHeightLevel(levels, 800, 2200)?.pressureHpa).toBe(700);
  });

  it('treats unknown terrain as sea level', () => {
    expect(flyingHeightLevel(levels, null)?.pressureHpa).toBe(900);
    expect(DEFAULT_FLYING_HEIGHT_AGL_M).toBe(1000);
  });

  it('skips levels carrying no wind, and returns null when none do', () => {
    const partial = levels.map((l, i) =>
      i < 2 ? { ...l, windSpeedKmh: null, windDirectionDeg: null } : l
    );
    expect(flyingHeightLevel(partial, 100)?.pressureHpa).toBe(850);
    const none = levels.map((l) => ({ ...l, windSpeedKmh: null, windDirectionDeg: null }));
    expect(flyingHeightLevel(none, 100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task → query
// ---------------------------------------------------------------------------

describe('taskElevationM', () => {
  it('averages the turnpoint altitudes', () => {
    // 800, 800, 700, 300 → 650
    expect(taskElevationM(racetask())).toBe(650);
  });

  it('is null when the route carries no altitudes', () => {
    const bare = {
      ...racetask(),
      turnpoints: racetask().turnpoints.map((tp) => ({
        ...tp,
        waypoint: { name: tp.waypoint.name, lat: tp.waypoint.lat, lon: tp.waypoint.lon },
      })),
    } as XCTask;
    expect(taskElevationM(bare)).toBeNull();
  });

  it("rides into the query, so the terrain datum isn't the provider's smoothed grid", () => {
    // The reason this exists: a model cell kilometres wide averages a ridge
    // and its valley, and reports terrain hundreds of metres out.
    expect(weatherQueryForTask(racetask(), '2026-01-10')!.elevationM).toBe(650);
    // An explicit caller override still wins.
    expect(
      weatherQueryForTask(racetask(), '2026-01-10', { elevationM: 900 })!.elevationM
    ).toBe(900);
  });
});

describe('weatherQueryForTask', () => {
  it('centres on the turnpoint mean', () => {
    const c = taskCentroid(racetask())!;
    expect(c.lat).toBeCloseTo((-36.2 - 36.2 - 36.0 - 36.4) / 4, 6);
    expect(c.lon).toBeCloseTo((147.9 + 147.9 + 148.1 + 147.7) / 4, 6);
  });

  it("spans the task's own clock with an hour of padding either side", () => {
    const q = weatherQueryForTask(racetask(), '2026-01-10')!;
    // Launch window opens 01:30Z, deadline 08:00Z → 00:30Z to 09:00Z.
    expect(new Date(q.fromMs).toISOString()).toBe('2026-01-10T00:30:00.000Z');
    expect(new Date(q.toMs).toISOString()).toBe('2026-01-10T09:00:00.000Z');
  });

  it('falls back to the whole UTC day when the task defines no times', () => {
    const bare = { ...racetask(), sss: undefined, goal: undefined, takeoff: undefined } as XCTask;
    const q = weatherQueryForTask(bare, '2026-01-10')!;
    expect(new Date(q.fromMs).toISOString()).toBe('2026-01-10T00:00:00.000Z');
    expect(new Date(q.toMs).toISOString()).toBe('2026-01-11T00:00:00.000Z');
  });

  it('returns null for a task with no turnpoints or a bad date', () => {
    expect(weatherQueryForTask({ ...racetask(), turnpoints: [] } as XCTask, '2026-01-10')).toBeNull();
    expect(weatherQueryForTask(racetask(), 'not-a-date')).toBeNull();
  });

  it('keys stably under floating-point noise but moves with the route', () => {
    const a = weatherQueryForTask(racetask(), '2026-01-10')!;
    const jittered: WeatherQuery = { ...a, lat: a.lat + 1e-9 };
    expect(weatherQueryKey(jittered)).toBe(weatherQueryKey(a));

    const moved = weatherQueryForTask(racetask(), '2026-01-11')!;
    expect(weatherQueryKey(moved)).not.toBe(weatherQueryKey(a));
  });
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

describe('selectProviders', () => {
  const q = (fromMs: number): WeatherQuery => ({ lat: -36.2, lon: 147.9, fromMs, toMs: fromMs + 3_600_000 });

  it('prefers the archived forecast for recent comps', () => {
    const picked = selectProviders(q(Date.UTC(2026, 0, 10)));
    expect(picked[0].id).toBe('open-meteo-historical-forecast');
    expect(picked[1].id).toBe('open-meteo-era5');
  });

  it('leaves only ERA5 for the pre-2022 back-catalogue', () => {
    const picked = selectProviders(q(Date.UTC(2020, 0, 10)));
    expect(picked.map((p) => p.id)).toEqual(['open-meteo-era5']);
  });

  it('lets a regional provider outrank the global default', () => {
    const bom: WeatherProvider = {
      id: 'bom',
      label: 'Bureau of Meteorology',
      priority: 80,
      supports: (query) => query.lon > 110 && query.lon < 155,
      fetch: async () => ({}) as TaskWeather,
    };
    const picked = selectProviders(q(Date.UTC(2026, 0, 10)), [...selectProviders(q(Date.UTC(2026, 0, 10))), bom]);
    expect(picked[0].id).toBe('bom');
    // ...and stays out of the way outside its region.
    const european = selectProviders({ lat: 46, lon: 8, fromMs: Date.UTC(2026, 0, 10), toMs: Date.UTC(2026, 0, 10) + 3_600_000 }, [bom, openMeteoHistoricalForecastProvider()]);
    expect(european.map((p) => p.id)).toEqual(['open-meteo-historical-forecast']);
  });

  it('treats a provider whose supports() throws as unavailable', () => {
    const broken: WeatherProvider = {
      id: 'broken',
      label: 'broken',
      priority: 99,
      supports: () => {
        throw new Error('nope');
      },
      fetch: async () => ({}) as TaskWeather,
    };
    expect(selectProviders(q(Date.UTC(2026, 0, 10)), [broken, openMeteoEra5Provider()]).map((p) => p.id)).toEqual([
      'open-meteo-era5',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Open-Meteo adapter
// ---------------------------------------------------------------------------

describe('open-meteo adapter', () => {
  const query = weatherQueryForTask(racetask(), '2026-01-10')!;

  it('maps a response onto the neutral shape, in UTC hours', async () => {
    const provider = openMeteoHistoricalForecastProvider();
    const w = await provider.fetch(query, { fetchImpl: stubFetch(openMeteoBody()), nowMs: NOW_MS });

    expect(w.hours).toHaveLength(4);
    expect(w.hours[0].t).toBe('2026-01-10T01:00:00.000Z');
    expect(w.hours[1].surface.windSpeedKmh).toBe(11);
    expect(w.hours[1].surface.windDirectionDeg).toBe(306);
    expect(w.hours[1].surface.windGustKmh).toBe(20);
    expect(w.hours[1].cloud.lowPct).toBe(5);
    expect(w.hours[1].boundaryLayerDepthM).toBe(1600);
    expect(w.hours[1].capeJkg).toBe(120);
  });

  it('derives cloud base from the surface spread', async () => {
    const provider = openMeteoHistoricalForecastProvider();
    const w = await provider.fetch(query, { fetchImpl: stubFetch(openMeteoBody()), nowMs: NOW_MS });
    // 24 °C over 12 °C dewpoint → 12 × 125 m.
    expect(w.hours[1].cloudBaseAglM).toBe(1500);
  });

  it('sorts levels by height and labels them with an ISA height', async () => {
    const provider = openMeteoHistoricalForecastProvider();
    const w = await provider.fetch(query, { fetchImpl: stubFetch(openMeteoBody()), nowMs: NOW_MS });
    const levels = w.hours[1].levels;
    expect(levels.map((l) => l.pressureHpa)).toEqual([950, 900, 850]);
    expect(levels[0].heightM).toBeLessThan(levels[1].heightM);
    expect(levels[1].windSpeedKmh).toBe(36);
  });

  it('reads the flying-height wind as far stronger than the surface', async () => {
    const provider = openMeteoHistoricalForecastProvider();
    const w = await provider.fetch(query, { fetchImpl: stubFetch(openMeteoBody()), nowMs: NOW_MS });
    const level = flyingHeightLevel(w.hours[2].levels, 800)!;
    expect(level.pressureHpa).toBe(850);
    expect(level.windSpeedKmh).toBe(47);
    expect(w.hours[2].surface.windSpeedKmh).toBe(16);
  });

  it('requests the interval as whole UTC days and slices to the window', async () => {
    let seen = '';
    const provider = openMeteoHistoricalForecastProvider();
    await provider.fetch(query, {
      nowMs: NOW_MS,
      fetchImpl: async (url) => {
        seen = url;
        return { ok: true, status: 200, json: async () => openMeteoBody(), text: async () => '' };
      },
    });
    expect(seen).toContain('start_date=2026-01-10');
    expect(seen).toContain('end_date=2026-01-10');
    expect(seen).toContain('timezone=UTC');
    expect(seen).toContain('wind_speed_unit=kmh');
    expect(seen).toContain('cape');
    expect(seen).toContain('wind_speed_900hPa');
  });

  it('drops hours outside the requested window', async () => {
    const provider = openMeteoHistoricalForecastProvider();
    const narrow: WeatherQuery = { ...query, fromMs: Date.UTC(2026, 0, 10, 2), toMs: Date.UTC(2026, 0, 10, 4) };
    const w = await provider.fetch(narrow, { fetchImpl: stubFetch(openMeteoBody()), nowMs: NOW_MS });
    expect(w.hours.map((h) => h.t)).toEqual([
      '2026-01-10T02:00:00.000Z',
      '2026-01-10T03:00:00.000Z',
    ]);
  });

  it('never asks ERA5 for variables it does not have', async () => {
    let seen = '';
    await openMeteoEra5Provider().fetch(query, {
      nowMs: NOW_MS,
      fetchImpl: async (url) => {
        seen = url;
        return { ok: true, status: 200, json: async () => openMeteoBody(), text: async () => '' };
      },
    });
    expect(seen).not.toContain('hPa');
    expect(seen).not.toContain('cape');
    expect(seen).toContain('boundary_layer_height');
  });

  it('withdraws the level_wind claim when a response carried none', async () => {
    const noLevels = openMeteoBody({
      wind_speed_950hPa: [null, null, null, null],
      wind_speed_900hPa: [null, null, null, null],
      wind_speed_850hPa: [null, null, null, null],
      temperature_950hPa: [null, null, null, null],
      temperature_900hPa: [null, null, null, null],
      temperature_850hPa: [null, null, null, null],
    });
    const w = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(noLevels),
      nowMs: NOW_MS,
    });
    expect(w.source.variables).not.toContain('level_wind');
    expect(w.hours[0].levels).toEqual([]);
  });

  it('drops boundary_layer when the archive returned a null column', async () => {
    // The real defect this guards: Open-Meteo's archived forecast advertises
    // boundary_layer but only populates it from ~Sept 2024, so every earlier
    // competition got a null column behind a claim that it had one — and the
    // thermal chart could not tell "no data" from "fetch failed".
    const noBlh = openMeteoBody({ boundary_layer_height: [null, null, null, null] });
    const w = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(noBlh),
      nowMs: NOW_MS,
    });
    expect(w.source.variables).not.toContain('boundary_layer');
    // Only that claim goes; the rest of the answer is untouched.
    expect(w.source.variables).toContain('cape');
    expect(w.source.variables).toContain('level_wind');
    expect(w.hours[0].boundaryLayerDepthM).toBeNull();
  });

  it('keeps every variable the answer actually delivered', async () => {
    const w = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody()),
      nowMs: NOW_MS,
    });
    expect(w.source.variables).toEqual([
      'surface_wind',
      'surface_gust',
      'surface_temp',
      'level_wind',
      'cloud_cover',
      'boundary_layer',
      'cape',
      'radiation',
      'precipitation',
    ]);
  });

  it('narrows one variable at a time, not the whole list', async () => {
    // cape is the historical forecast's own extra column, so this is a real
    // retraction rather than a variable it never claimed.
    const w = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody({ cape: [null, null, null, null] })),
      nowMs: NOW_MS,
    });
    expect(w.source.variables).not.toContain('cape');
    expect(w.source.variables).toContain('boundary_layer');
    expect(w.source.variables).toContain('level_wind');
  });

  it('drops all-null hours so an unpublished day reads as no data', async () => {
    const empty = openMeteoBody(
      Object.fromEntries(
        Object.keys(openMeteoBody().hourly)
          .filter((k) => k !== 'time')
          .map((k) => [k, [null, null, null, null]])
      )
    );
    const w = await openMeteoEra5Provider().fetch(query, { fetchImpl: stubFetch(empty), nowMs: NOW_MS });
    expect(w.hours).toEqual([]);
  });

  it('marks a fetch inside the publication lag provisional', async () => {
    const justAfter = Date.UTC(2026, 0, 10, 12);
    const fresh = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody()),
      nowMs: justAfter,
    });
    expect(fresh.provisional).toBe(true);

    const settled = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody()),
      nowMs: NOW_MS,
    });
    expect(settled.provisional).toBe(false);
  });

  it('echoes the task elevation so a consumer can compare it to the grid', async () => {
    const w = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody()),
      nowMs: NOW_MS,
    });
    expect(w.resolved.elevationM).toBe(650);
    // The gap this makes visible: the grid says 298 m for 650 m of terrain.
    expect(w.source.pointElevationM).toBe(298);
  });

  it('states a resolution only where one is honestly knowable', async () => {
    // ERA5 is a single global 0.25 degree grid — a fact.
    const era5 = await openMeteoEra5Provider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody()),
      nowMs: NOW_MS,
    });
    expect(era5.source.resolutionKm).toBe(25);

    // best_match picks a different model per location and the API does not
    // report which, so null is the correct answer, not a placeholder.
    const best = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody()),
      nowMs: NOW_MS,
    });
    expect(best.source.resolutionKm).toBeNull();
  });

  it('carries the grid point and the licence to the caller', async () => {
    const w = await openMeteoHistoricalForecastProvider().fetch(query, {
      fetchImpl: stubFetch(openMeteoBody()),
      nowMs: NOW_MS,
    });
    expect(w.source.pointLat).toBe(-36.17);
    expect(w.source.pointElevationM).toBe(298);
    expect(w.source.license).toBe('CC BY 4.0');
    expect(w.source.kind).toBe('model');
    expect(openMeteoEra5Provider().id).toBe('open-meteo-era5');
  });

  it('surfaces the API reason on an error response', async () => {
    const provider = openMeteoHistoricalForecastProvider();
    await expect(
      provider.fetch(query, {
        fetchImpl: stubFetch({ error: true, reason: 'Invalid date' }, false, 400),
        nowMs: NOW_MS,
      })
    ).rejects.toThrow(/Invalid date/);
  });
});

// ---------------------------------------------------------------------------
// Registry fall-through
// ---------------------------------------------------------------------------

describe('fetchTaskWeather', () => {
  const query = weatherQueryForTask(racetask(), '2026-01-10')!;

  function fake(id: string, priority: number, impl: () => Promise<TaskWeather>): WeatherProvider {
    return { id, label: id, priority, supports: () => true, fetch: impl };
  }

  const oneHour = (id: string): TaskWeather =>
    ({
      source: { providerId: id },
      resolved: { lat: 0, lon: 0, fromMs: 0, toMs: 0 },
      hours: [{ t: '2026-01-10T02:00:00.000Z' }],
      provisional: false,
      fetchedAt: '2026-01-10T02:00:00.000Z',
    }) as unknown as TaskWeather;

  it('takes the highest-priority answer', async () => {
    const w = await fetchTaskWeather(query, {
      nowMs: NOW_MS,
      fetchImpl: stubFetch({}),
      providers: [fake('low', 1, async () => oneHour('low')), fake('high', 9, async () => oneHour('high'))],
    });
    expect(w.source.providerId).toBe('high');
  });

  it('falls through when the preferred provider throws', async () => {
    const w = await fetchTaskWeather(query, {
      nowMs: NOW_MS,
      fetchImpl: stubFetch({}),
      providers: [
        fake('high', 9, async () => {
          throw new Error('upstream down');
        }),
        fake('low', 1, async () => oneHour('low')),
      ],
    });
    expect(w.source.providerId).toBe('low');
  });

  it('falls through when the preferred provider has no data for the day', async () => {
    const w = await fetchTaskWeather(query, {
      nowMs: NOW_MS,
      fetchImpl: stubFetch({}),
      providers: [
        fake('high', 9, async () => ({ ...oneHour('high'), hours: [] })),
        fake('low', 1, async () => oneHour('low')),
      ],
    });
    expect(w.source.providerId).toBe('low');
  });

  it('reports every attempt when all of them fail', async () => {
    const promise = fetchTaskWeather(query, {
      nowMs: NOW_MS,
      fetchImpl: stubFetch({}),
      providers: [
        fake('a', 2, async () => {
          throw new Error('boom');
        }),
        fake('b', 1, async () => {
          throw new Error('bang');
        }),
      ],
    });
    await expect(promise).rejects.toThrow(NoWeatherAvailable);
    await expect(promise).rejects.toThrow(/a \(boom\).*b \(bang\)/);
  });

  it('refuses a query no provider covers', async () => {
    await expect(
      fetchTaskWeather(query, { nowMs: NOW_MS, fetchImpl: stubFetch({}), providers: [] })
    ).rejects.toThrow(NoWeatherAvailable);
  });
});
