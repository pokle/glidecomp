/**
 * Task weather store + endpoints (migration 0023), and the weather notes
 * that ride alongside them.
 *
 * The store's contract differs from its two siblings in one way this file
 * exists to pin down: invalidation is by QUERY KEY, not by an inputs
 * revision. There is deliberately no bump at the mutation sites — weather is
 * not derived from competition data — so the tests that matter most are the
 * ones proving a route or date change re-fetches on its own, and that a
 * failing provider backs off instead of firing a request per page view.
 *
 * Every test that would otherwise reach the network injects fake providers.
 * The one place that can't (the route's own background scheduling) is
 * covered by seeding rows directly in D1, so no scheduled work races an
 * assertion.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { authRequest, createComp, createTask, request, clearCompData } from "./helpers";
import {
  backoffMsFor,
  isWeatherRowStale,
  queryForTaskRow,
  readWeatherRow,
  refreshTaskWeather,
  shouldFetchWeather,
  PROVISIONAL_TTL_MS,
  type TaskWeatherRow,
} from "../src/weather-store";
import {
  WEATHER_SCHEMA_VERSION,
  weatherQueryKey,
  type TaskWeather,
  type WeatherProvider,
} from "@glidecomp/engine";

/** A minimal route with a launch window and a deadline, near Corryong. */
function xctsk() {
  return {
    version: 1,
    taskType: "CLASSIC",
    turnpoints: [
      {
        type: "TAKEOFF",
        radius: 400,
        waypoint: { name: "LAUNCH", lat: -36.2, lon: 147.9, altSmoothed: 800 },
      },
      {
        type: "SSS",
        radius: 5000,
        waypoint: { name: "SSS", lat: -36.2, lon: 147.9, altSmoothed: 800 },
      },
      {
        type: "ESS",
        radius: 1000,
        waypoint: { name: "GOAL", lat: -36.4, lon: 147.7, altSmoothed: 300 },
      },
    ],
    sss: { type: "RACE", direction: "EXIT", timeGates: ["03:00:00"] },
    goal: { type: "CYLINDER", deadline: "08:00:00" },
    takeoff: { timeOpen: "01:30:00", timeClose: "04:00:00" },
  };
}

/** A canned provider answer with one usable hour. */
function weatherFixture(providerId = "fake", provisional = false): TaskWeather {
  return {
    source: {
      providerId,
      model: "Fake model 1 km",
      attribution: "Fake Weather",
      attributionUrl: "https://example.invalid/",
      license: "CC BY 4.0",
      kind: "model",
      variables: ["surface_wind", "level_wind", "cloud_cover", "boundary_layer"],
      pointLat: -36.17,
      pointLon: 147.86,
      pointElevationM: 477,
    },
    resolved: { lat: -36.2, lon: 147.9, fromMs: 0, toMs: 3_600_000 },
    hours: [
      {
        t: "2026-01-15T03:00:00.000Z",
        surface: {
          windDirectionDeg: 290,
          windSpeedKmh: 14,
          windGustKmh: 22,
          temperatureC: 28,
          dewPointC: 10,
        },
        levels: [
          {
            pressureHpa: 850,
            heightM: 1460,
            windDirectionDeg: 284,
            windSpeedKmh: 44,
            temperatureC: 15,
          },
        ],
        cloud: { lowPct: 20, midPct: 5, highPct: 0, totalPct: 25 },
        boundaryLayerDepthM: 2400,
        capeJkg: 180,
        shortwaveWm2: 900,
        precipitationMm: 0,
        cloudBaseAglM: 2250,
      },
    ],
    provisional,
    fetchedAt: "2026-01-20T00:00:00.000Z",
  };
}

function fakeProvider(
  impl: () => Promise<TaskWeather>,
  id = "fake"
): WeatherProvider {
  return { id, label: id, priority: 10, supports: () => true, fetch: impl };
}

/** Numeric task_id behind an encoded one. */
async function taskIdOf(encoded: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT task_id FROM task ORDER BY task_id DESC LIMIT 1"
  ).first<{ task_id: number }>();
  expect(row, `no task for ${encoded}`).toBeTruthy();
  return row!.task_id;
}

interface ServedWeather {
  task_id: string;
  notes: string;
  weather: TaskWeather | null;
  stale: boolean;
  pending: boolean;
  too_far_ahead: boolean;
  error: string | null;
}

/** An ISO date this many days from today, for the future-dated task tests. */
function dateDaysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await clearCompData();
  await env.DB.prepare("DELETE FROM task_weather").run();
});

// ---------------------------------------------------------------------------
// Freshness rules
// ---------------------------------------------------------------------------

describe("weather freshness", () => {
  const NOW = Date.parse("2026-02-01T00:00:00Z");

  function row(overrides: Partial<TaskWeatherRow> = {}): TaskWeatherRow {
    return {
      task_id: 1,
      weather_json: "{}",
      query_key: "key-a",
      schema_version: WEATHER_SCHEMA_VERSION,
      provider_id: "fake",
      fetched_at: new Date(NOW - 60_000).toISOString(),
      provisional: 0,
      fetching_until: "",
      error: "",
      attempts: 0,
      ...overrides,
    };
  }

  test("a settled answer for the current query never goes stale with age", () => {
    const ancient = row({ fetched_at: "2020-01-01T00:00:00Z" });
    expect(isWeatherRowStale(ancient, "key-a", NOW)).toBe(false);
  });

  test("a moved route (new key) is stale immediately", () => {
    expect(isWeatherRowStale(row(), "key-b", NOW)).toBe(true);
  });

  test("a schema bump rolls every row over", () => {
    expect(
      isWeatherRowStale(row({ schema_version: WEATHER_SCHEMA_VERSION - 1 }), "key-a", NOW)
    ).toBe(true);
  });

  test("a provisional answer re-fetches only after its TTL", () => {
    const fresh = row({
      provisional: 1,
      fetched_at: new Date(NOW - PROVISIONAL_TTL_MS + 60_000).toISOString(),
    });
    expect(isWeatherRowStale(fresh, "key-a", NOW)).toBe(false);

    const expired = row({
      provisional: 1,
      fetched_at: new Date(NOW - PROVISIONAL_TTL_MS - 1).toISOString(),
    });
    expect(isWeatherRowStale(expired, "key-a", NOW)).toBe(true);
  });

  test("a failed row is held for its backoff, then retried", () => {
    const justFailed = row({
      error: "provider down",
      attempts: 1,
      fetched_at: new Date(NOW - 60_000).toISOString(),
    });
    expect(isWeatherRowStale(justFailed, "key-a", NOW)).toBe(false);

    const backedOff = row({
      error: "provider down",
      attempts: 1,
      fetched_at: new Date(NOW - backoffMsFor(1) - 1).toISOString(),
    });
    expect(isWeatherRowStale(backedOff, "key-a", NOW)).toBe(true);
  });

  test("backoff lengthens with consecutive failures and then plateaus", () => {
    expect(backoffMsFor(0)).toBe(0);
    expect(backoffMsFor(1)).toBeLessThan(backoffMsFor(2));
    expect(backoffMsFor(2)).toBeLessThan(backoffMsFor(3));
    expect(backoffMsFor(9)).toBe(backoffMsFor(4));
  });

  test("a never-attempted task fetches; a failing one inside backoff does not", () => {
    expect(shouldFetchWeather(null, "key-a", NOW)).toBe(true);
    // The case the cold path gets wrong: no stored result, but still backing
    // off. Scheduling on "no result" would fire a request per page view.
    const failingCold = row({
      weather_json: "",
      error: "provider down",
      attempts: 2,
      fetched_at: new Date(NOW - 60_000).toISOString(),
    });
    expect(shouldFetchWeather(failingCold, "key-a", NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The task's query
// ---------------------------------------------------------------------------

describe("query derivation", () => {
  test("a task with no route has no query, so nothing to fetch", () => {
    expect(queryForTaskRow({ xctsk: null, task_date: "2026-01-15" })).toBeNull();
    expect(queryForTaskRow({ xctsk: JSON.stringify(xctsk()), task_date: null })).toBeNull();
  });

  test("unparseable stored route degrades to null rather than throwing", () => {
    expect(queryForTaskRow({ xctsk: "{not json", task_date: "2026-01-15" })).toBeNull();
  });

  test("the key moves when the task date moves", () => {
    const a = queryForTaskRow({ xctsk: JSON.stringify(xctsk()), task_date: "2026-01-15" })!;
    const b = queryForTaskRow({ xctsk: JSON.stringify(xctsk()), task_date: "2026-01-16" })!;
    expect(weatherQueryKey(a)).not.toBe(weatherQueryKey(b));
  });
});

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

describe("refreshTaskWeather", () => {
  let taskId: number;

  beforeEach(async () => {
    const compId = await createComp();
    const encoded = await createTask(compId, { xctsk: xctsk() });
    taskId = await taskIdOf(encoded);
  });

  test("stores a successful answer with the key it was fetched for", async () => {
    await refreshTaskWeather(env, taskId, {
      providers: [fakeProvider(async () => weatherFixture())],
    });

    const row = (await readWeatherRow(env.DB, taskId))!;
    expect(row.provider_id).toBe("fake");
    expect(row.error).toBe("");
    expect(row.attempts).toBe(0);
    expect(row.fetching_until).toBe("");
    expect(JSON.parse(row.weather_json).hours).toHaveLength(1);

    const task = await env.DB.prepare(
      "SELECT xctsk, task_date FROM task WHERE task_id = ?"
    )
      .bind(taskId)
      .first<{ xctsk: string; task_date: string }>();
    expect(row.query_key).toBe(weatherQueryKey(queryForTaskRow(task!)!));
  });

  test("does not re-fetch an answer that is already fresh", async () => {
    let calls = 0;
    const provider = fakeProvider(async () => {
      calls++;
      return weatherFixture();
    });
    await refreshTaskWeather(env, taskId, { providers: [provider] });
    await refreshTaskWeather(env, taskId, { providers: [provider] });
    expect(calls).toBe(1);
  });

  test("re-fetches once the task date moves the query key", async () => {
    let calls = 0;
    const provider = fakeProvider(async () => {
      calls++;
      return weatherFixture();
    });
    await refreshTaskWeather(env, taskId, { providers: [provider] });
    expect(calls).toBe(1);

    await env.DB.prepare("UPDATE task SET task_date = ? WHERE task_id = ?")
      .bind("2026-01-16", taskId)
      .run();
    await refreshTaskWeather(env, taskId, { providers: [provider] });
    expect(calls).toBe(2);
  });

  test("records a failure without discarding the answer already stored", async () => {
    await refreshTaskWeather(env, taskId, {
      providers: [fakeProvider(async () => weatherFixture())],
    });
    // Force the row stale so the next call actually attempts a fetch.
    await env.DB.prepare("UPDATE task_weather SET schema_version = 0 WHERE task_id = ?")
      .bind(taskId)
      .run();

    await refreshTaskWeather(env, taskId, {
      providers: [
        fakeProvider(async () => {
          throw new Error("upstream on fire");
        }),
      ],
    });

    const row = (await readWeatherRow(env.DB, taskId))!;
    expect(row.error).toContain("upstream on fire");
    expect(row.attempts).toBe(1);
    // The point of the test: last week's good answer survives an outage.
    expect(JSON.parse(row.weather_json).hours).toHaveLength(1);
  });

  test("drops the stored answer when the failed fetch was for a NEW key", async () => {
    await refreshTaskWeather(env, taskId, {
      providers: [fakeProvider(async () => weatherFixture())],
    });
    await env.DB.prepare("UPDATE task SET task_date = ? WHERE task_id = ?")
      .bind("2026-02-20", taskId)
      .run();

    await refreshTaskWeather(env, taskId, {
      providers: [
        fakeProvider(async () => {
          throw new Error("nope");
        }),
      ],
    });

    // Serving the old location's weather under the new key would be a lie.
    const row = (await readWeatherRow(env.DB, taskId))!;
    expect(row.weather_json).toBe("");
    expect(row.provider_id).toBe("");
    expect(row.error).toContain("nope");
  });

  test("consecutive failures accumulate, and a success resets the count", async () => {
    const failing = fakeProvider(async () => {
      throw new Error("down");
    });
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare(
        "UPDATE task_weather SET fetched_at = '2020-01-01T00:00:00Z' WHERE task_id = ?"
      )
        .bind(taskId)
        .run();
      await refreshTaskWeather(env, taskId, { providers: [failing] });
    }
    expect((await readWeatherRow(env.DB, taskId))!.attempts).toBe(2);

    await env.DB.prepare(
      "UPDATE task_weather SET fetched_at = '2020-01-01T00:00:00Z' WHERE task_id = ?"
    )
      .bind(taskId)
      .run();
    await refreshTaskWeather(env, taskId, {
      providers: [fakeProvider(async () => weatherFixture())],
    });
    const row = (await readWeatherRow(env.DB, taskId))!;
    expect(row.attempts).toBe(0);
    expect(row.error).toBe("");
  });

  test("a held lease keeps a second fetch out", async () => {
    await env.DB.prepare(
      `INSERT INTO task_weather (task_id, fetching_until) VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET fetching_until = excluded.fetching_until`
    )
      .bind(taskId, new Date(Date.now() + 60_000).toISOString())
      .run();

    let calls = 0;
    await refreshTaskWeather(env, taskId, {
      providers: [
        fakeProvider(async () => {
          calls++;
          return weatherFixture();
        }),
      ],
    });
    expect(calls).toBe(0);
  });

  test("a task with no route is left alone entirely", async () => {
    const compId = await createComp();
    const encoded = await createTask(compId);
    const routeless = await taskIdOf(encoded);

    await refreshTaskWeather(env, routeless, {
      providers: [
        fakeProvider(async () => {
          throw new Error("should never be called");
        }),
      ],
    });
    expect(await readWeatherRow(env.DB, routeless)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The read endpoint
// ---------------------------------------------------------------------------

describe("GET /weather", () => {
  let compId: string;
  let encodedTask: string;
  let taskId: number;

  beforeEach(async () => {
    compId = await createComp();
    encodedTask = await createTask(compId, { xctsk: xctsk() });
    taskId = await taskIdOf(encodedTask);
  });

  const url = () => `/api/comp/${compId}/task/${encodedTask}/weather`;

  test("serves a stored answer to anonymous readers", async () => {
    await refreshTaskWeather(env, taskId, {
      providers: [fakeProvider(async () => weatherFixture())],
    });

    const res = await request("GET", url());
    expect(res.status).toBe(200);
    const body = (await res.json()) as ServedWeather;
    expect(body.pending).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.weather?.hours).toHaveLength(1);
    expect(body.weather?.source.license).toBe("CC BY 4.0");
    expect(res.headers.get("X-Cache")).toBe("HIT");
  });

  test("a never-fetched task reads as pending, not as an error", async () => {
    const res = await request("GET", url());
    const body = (await res.json()) as ServedWeather;
    expect(body.weather).toBeNull();
    expect(body.pending).toBe(true);
    expect(body.error).toBeNull();
  });

  test("a routeless task says why, permanently, instead of spinning", async () => {
    const routeless = await createTask(compId);
    const res = await request("GET", `/api/comp/${compId}/task/${routeless}/weather`);
    const body = (await res.json()) as ServedWeather;
    expect(body.pending).toBe(false);
    expect(body.error).toMatch(/no route or date/i);
  });

  test("a task stuck in backoff reports the failure rather than pending", async () => {
    await env.DB.prepare(
      `INSERT INTO task_weather
         (task_id, weather_json, query_key, schema_version, fetched_at, error, attempts)
       VALUES (?, '', ?, ?, ?, ?, ?)`
    )
      .bind(
        taskId,
        weatherQueryKey(
          queryForTaskRow(
            (await env.DB.prepare("SELECT xctsk, task_date FROM task WHERE task_id = ?")
              .bind(taskId)
              .first<{ xctsk: string; task_date: string }>())!
          )!
        ),
        WEATHER_SCHEMA_VERSION,
        new Date().toISOString(),
        "Every weather provider failed",
        3
      )
      .run();

    const res = await request("GET", url());
    const body = (await res.json()) as ServedWeather;
    expect(body.pending).toBe(false);
    expect(body.error).toMatch(/failed/i);
  });

  test("a task set tomorrow is fetched like any other — the forecast covers it", async () => {
    const soon = await createTask(compId, {
      xctsk: xctsk(),
      task_date: dateDaysAhead(1),
    });
    const res = await request("GET", `/api/comp/${compId}/task/${soon}/weather`);
    const body = (await res.json()) as ServedWeather;
    expect(body.too_far_ahead).toBe(false);
    expect(body.pending).toBe(true);
    expect(body.error).toBeNull();
  });

  test("a task set beyond the forecast horizon says 'not yet' instead of spinning", async () => {
    // A comp laid out weeks in advance. Nothing can answer, so scheduling a
    // fetch would only earn a failure row and a backoff of up to a day —
    // exactly the window in which the forecast starts existing.
    const distant = await createTask(compId, {
      xctsk: xctsk(),
      task_date: dateDaysAhead(60),
    });
    const res = await request("GET", `/api/comp/${compId}/task/${distant}/weather`);
    const body = (await res.json()) as ServedWeather;
    expect(body.too_far_ahead).toBe(true);
    expect(body.pending).toBe(false);
    expect(body.weather).toBeNull();
    expect(body.error).toMatch(/days ahead/i);

    // ...and no row was written, so the day it comes into range it fetches.
    const distantId = await taskIdOf(distant);
    expect(await readWeatherRow(env.DB, distantId)).toBeNull();
  });

  test("a hidden test comp 404s anonymously but serves its admin", async () => {
    const hidden = await createComp({ test: true });
    const hiddenTask = await createTask(hidden, { xctsk: xctsk() });

    const anon = await request("GET", `/api/comp/${hidden}/task/${hiddenTask}/weather`);
    expect(anon.status).toBe(404);

    const admin = await authRequest("GET", `/api/comp/${hidden}/task/${hiddenTask}/weather`);
    expect(admin.status).toBe(200);
  });

  test("caches for anonymous readers but never for a signed-in one", async () => {
    await refreshTaskWeather(env, taskId, {
      providers: [fakeProvider(async () => weatherFixture())],
    });

    const anon = await request("GET", url());
    expect(anon.headers.get("Cache-Control")).toMatch(/^public/);

    const signedIn = await authRequest("GET", url());
    expect(signedIn.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

// ---------------------------------------------------------------------------
// Weather notes
// ---------------------------------------------------------------------------

describe("weather notes", () => {
  let compId: string;
  let taskId: string;

  beforeEach(async () => {
    compId = await createComp();
    taskId = await createTask(compId, { xctsk: xctsk() });
  });

  test("default to empty, never null, so no caller has to branch", async () => {
    const res = await request("GET", `/api/comp/${compId}/task/${taskId}`);
    const body = (await res.json()) as { weather_notes: string };
    expect(body.weather_notes).toBe("");
  });

  test("an admin can set them and everyone can read them", async () => {
    const patch = await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      weather_notes: "Overdeveloped by 2pm.\nGlass off at 3.",
    });
    expect(patch.status).toBe(200);

    const anon = await request("GET", `/api/comp/${compId}/task/${taskId}`);
    const body = (await anon.json()) as { weather_notes: string };
    expect(body.weather_notes).toBe("Overdeveloped by 2pm.\nGlass off at 3.");
  });

  test("a non-admin cannot write them", async () => {
    const res = await request("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      body: { weather_notes: "I was not there" },
      user: "user-3",
    });
    expect(res.status).toBe(403);
  });

  test("changes are audit-logged with an excerpt, not the whole essay", async () => {
    const long = `Big day. ${"x".repeat(500)} end.`;
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      weather_notes: long,
    });

    const entries = await env.DB.prepare(
      "SELECT description FROM audit_log WHERE subject_type = 'task' ORDER BY audit_id DESC"
    ).all<{ description: string }>();
    const note = entries.results.find((e) => /weather notes/i.test(e.description));
    expect(note).toBeTruthy();
    expect(note!.description).toMatch(/^Added the weather notes:/);
    expect(note!.description.length).toBeLessThan(200);
  });

  test("clearing them is its own audit line", async () => {
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      weather_notes: "Blown out.",
    });
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      weather_notes: "",
    });

    const entries = await env.DB.prepare(
      "SELECT description FROM audit_log ORDER BY audit_id DESC"
    ).all<{ description: string }>();
    expect(entries.results.some((e) => /Cleared the weather notes/.test(e.description))).toBe(
      true
    );
  });

  test("writing notes does NOT mark scores stale — prose changes no score", async () => {
    const before = await env.DB.prepare(
      "SELECT inputs_rev FROM task_scores WHERE task_id = (SELECT MAX(task_id) FROM task)"
    ).first<{ inputs_rev: number }>();

    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      weather_notes: "Light and variable all day.",
    });

    const after = await env.DB.prepare(
      "SELECT inputs_rev FROM task_scores WHERE task_id = (SELECT MAX(task_id) FROM task)"
    ).first<{ inputs_rev: number }>();
    expect(after?.inputs_rev ?? null).toBe(before?.inputs_rev ?? null);
  });

  test("rejects notes past the length cap", async () => {
    const res = await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      weather_notes: "x".repeat(4001),
    });
    expect(res.status).toBe(400);
  });

  test("the weather endpoint carries the notes too, so one fetch serves both", async () => {
    await authRequest("PATCH", `/api/comp/${compId}/task/${taskId}`, {
      weather_notes: "Cycle went through at 1.",
    });
    const res = await request("GET", `/api/comp/${compId}/task/${taskId}/weather`);
    const body = (await res.json()) as ServedWeather;
    expect(body.notes).toBe("Cycle went through at 1.");
  });
});
