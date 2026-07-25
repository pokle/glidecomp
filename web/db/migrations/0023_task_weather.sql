-- Cached meteorological conditions for a task's flying window, plus the
-- organizer's own weather notes.
--
-- ── task_weather ───────────────────────────────────────────────────────────
--
-- Third member of the stale-first derived-cache family (task_scores 0012,
-- task_field_analysis 0019), and the one that departs furthest from the
-- pattern — for a reason worth stating, because the departure IS the design:
--
--   Weather is not derived from competition data at all. It comes from an
--   outside provider, it is a function of a place and a past interval, and a
--   past interval's weather never changes. So there is no `inputs_rev` and
--   nothing to bump: the 28 score-affecting mutation sites are irrelevant
--   here, and adding a bump call to them would be wrong, not merely
--   redundant. Editing a pilot's status cannot change what the sky did.
--
-- Invalidation is by KEY, not by revision. `query_key` is the engine's
-- weatherQueryKey() — the rounded centroid and the rounded hour bounds of
-- the flying window. Change the route or the task date and the centroid or
-- the window moves, the key stops matching, and the row re-fetches on next
-- read. Nothing has to remember to invalidate it, which is exactly the
-- property that makes a bump-based scheme fragile.
--
-- Three further staleness triggers, all derived rather than stored:
--   schema_version  — WEATHER_SCHEMA_VERSION. A change to the stored shape
--                     or to a derived field (cloud base, level heights)
--                     rolls every row over with no migration step.
--   provisional     — set when the fetch landed inside the source's
--                     publication lag (ERA5 runs ~5 days behind; archived
--                     forecast runs get revised for a day or two). Such a
--                     row re-fetches after a TTL until it settles, which is
--                     what makes weather for a task flown THIS MORNING
--                     correct itself instead of freezing a half-published
--                     day.
--   error/attempts  — a failed fetch is stored, not discarded, so the read
--                     path can back off. Without this a task whose provider
--                     is down re-fetches on every single page view.
--
-- Like field analysis and unlike scores, the cold path NEVER fetches
-- synchronously: a request to an external API has no business blocking a
-- page render. A rowless task returns `pending`, schedules the fetch, and
-- the UI polls.
CREATE TABLE "task_weather" (
  "task_id"         INTEGER PRIMARY KEY
                    REFERENCES "task"("task_id") ON DELETE CASCADE,
  -- JSON of the engine's TaskWeather: the hourly rows plus the source
  -- credit. Plain TEXT, not a gzipped BLOB like task_field_analysis: a
  -- flying window is a dozen hourly rows (~6 KB), where compression buys
  -- little and costs readability in `wrangler d1 execute`.
  "weather_json"    TEXT    NOT NULL DEFAULT '',
  -- engine weatherQueryKey(): "lat:lon:fromHour:toHour". A mismatch against
  -- the task's current key means the route or date moved — refetch.
  "query_key"       TEXT    NOT NULL DEFAULT '',
  "schema_version"  INTEGER NOT NULL DEFAULT 0,
  -- Which provider answered (open-meteo-historical-forecast, open-meteo-era5,
  -- and regional sources added later). Stored for observability: "why does
  -- this 2020 comp have no upper winds?" is answered by reading this column.
  "provider_id"     TEXT    NOT NULL DEFAULT '',
  "fetched_at"      TEXT    NOT NULL DEFAULT '',   -- ISO, when the fetch completed
  "provisional"     INTEGER NOT NULL DEFAULT 0,    -- 1 = source may still revise it
  "fetching_until"  TEXT    NOT NULL DEFAULT '',   -- fetch lock lease (ISO); '' = unlocked
  -- Failure bookkeeping. `attempts` counts CONSECUTIVE failures and resets
  -- to 0 on success; the read path backs off exponentially on it.
  "error"           TEXT    NOT NULL DEFAULT '',
  "attempts"        INTEGER NOT NULL DEFAULT 0
);

-- ── task.weather_notes ─────────────────────────────────────────────────────
--
-- The organizer's free-text account of the day: "overdeveloped by 2pm, glass
-- off at 3". Deliberately NOT structured and deliberately NOT an analysis
-- input — no metric reads it and no score depends on it. It exists because
-- the modelled numbers above are a 9–25 km grid cell and the people who were
-- there know things the grid cannot: that the cycle went through at 1pm,
-- that the valley wind switched, that half the field got flushed.
--
-- Public to read (subject to the comp's own test-comp visibility), writable
-- by competition admins and super-admins. Edits are audit-logged like every
-- other organizer mutation; they do NOT mark scores stale, because notes
-- cannot change a score.
ALTER TABLE task ADD COLUMN weather_notes TEXT NOT NULL DEFAULT '';
