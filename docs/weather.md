# Task weather and weather notes

Two separate things that answer each other: what the model said, and what the
people who were there said. Current-state reference.

## Where they surface

Together, in two prominent places, **notes first**:

1. **The task page's "Weather" section** — under the route, above the results.
   Modelled charts only, via `src/react/weather/TaskWeatherPanel.tsx`.
2. **A top-level "What the weather did" section on the task task-analysis
   page** — placed *before* the separation ranking, because the conditions decide
   which metrics matter.

That second section's body is `charts/day-profile/DayProfilePanel.tsx`: the
flown, track-derived day charts and the modelled charts stacked on ONE shared
time axis under explicit "From the pilots' tracks" / "From the weather model"
group labels, so the predicted day reads against the day the field actually
flew. (The day metric family below it keeps only its tables.)

### How the modelled charts are drawn

The three modelled charts (`MetWindChart`, `MetSkyChart`, `MetThermalChart`)
take their geometry from one `ChartFrame` (`charts/day-profile/frame.ts`) that
the panel decides once for the stack, so an hour is at the same x in all of
them.

- **On the task page the frame is measured.** The viewBox is as wide as the
  chart is drawn, one unit is one CSS pixel, and labels are 13 px at every
  width. Chart heights are multiples of that type size, so they do not grow
  with the page. Before issue #860 the charts were a fixed 560-unit drawing
  scaled to the page, which painted their labels at 5 px on a phone.
- **On the task-analysis page the frame is still the fixed one**
  (`LEGACY_FRAME`). The three track-derived charts have not had their label
  pass, and all six charts must share one left and right edge.
- **What does not fit in the plot is text above it**: the title, the source
  stamp and the legend (`MetChartHeader`, `MetLegend`). The y ticks are bare
  numbers with the unit printed once. Time labels thin to every second tick
  when neighbours would touch (`tickLabelStride`); the gridlines do not.
- **One hour is selected for the whole stack** (`HourColumns.tsx`): a tap or a
  drag on a phone, the pointer on a desktop, arrow keys from a keyboard. The
  hour is a band through all three charts, and `MetReadout` prints the three
  charts' figures for it. The wording is in `met-readout.ts`, which also names
  each hour column for a screen reader. Nothing is hover-only.
- Coverage: `e2e/task-weather-charts.spec.ts`, on a desktop and a phone. It
  measures the painted label sizes; it does not assert on classes.

## Provider architecture

`web/engine/src/weather/` — a provider-neutral `WeatherProvider` interface plus a
priority registry, so a call site names no provider, and adding a regional source
(a BOM adapter for Australian comps) is one new file plus one registry entry.

Three Open-Meteo adapters ship today, with genuinely different capabilities:

| Adapter | Range | Carries |
|---|---|---|
| Archived forecast | 2022+ | pressure-level winds, CAPE |
| ERA5 | 1940+ | neither of those |
| Live forecast | out to 15 days | any window that hasn't fully elapsed |

`WeatherSource.variables` reports what a dataset actually has, so consumers
degrade rather than draw an empty axis.

The live forecast exists because tasks are usually set a day or two ahead —
sometimes a whole comp is. Past its 15-day horizon (`beyondForecastHorizon`) the
read path says "not yet" rather than scheduling a fetch that can only fail into a
backoff.

### Past and future are a strict partition

Enforced in each adapter's `fetch`, **not** in `supports` (which is handed the
query and not the clock): the archives refuse a window that hasn't elapsed, the
forecast refuses one that has.

This is not tidiness. Both archive endpoints will cheerfully serve a future day,
returning the current forecast run verbatim — and it would reach the reader
stamped "archived forecast, modelled". `WeatherSource.kind` exists so a
prediction (`forecast`) can never be read as a record (`model`), and every
chart's source stamp prints it, in the title row directly above its plot.

### Capability is narrowed per answer

`deliveredVariables()`, not the provider's advertisement — coverage varies by
date *inside* one dataset. The archived forecast claims `boundary_layer` but only
populates it from about September 2024, so earlier comps get no thermal top, and
the chart says so instead of showing one line.

### Fixed units across every provider

Wind direction is degrees FROM, speeds km/h, heights metres, times ISO-UTC hour
starts.

Changing what an answer stores means bumping `WEATHER_SCHEMA_VERSION`, which
expires cached rows.

## Storage

Stale-first (`task_weather`, migration 0023), but **invalidated by query key, not
by `inputs_rev`**.

Weather is a function of a place and a past interval, and a past interval's
weather never changes — so there is deliberately **no bump at the mutation
sites**. (This is the standing exception to CLAUDE.md's "every mutation that
changes a scoring input must bump" rule: weather is not derived from competition
data.) Move the route or the date and the engine's `weatherQueryKey` stops
matching the stored row, which re-fetches on next read.

Provisional answers — fetched inside a source's publication lag — re-fetch on a
TTL; failures back off. Like task analysis, the cold path never fetches
synchronously: a page render must not depend on a third party's uptime.

## Weather notes

`task.weather_notes` — the organizer's free-text account of the day.
"Overdeveloped by 2pm, glass off at 3."

- Public to read; comp-admin or super-admin to write, through the task PATCH like
  any other task field.
- Audit-logged with an **excerpt** — it is prose, and the whole field would bury
  the log.
- Explicitly **not a scoring input**, so it must not bump scores.

They exist because the modelled numbers are a 9–25 km grid cell, and the people
who were there know what it cannot. Mark the met source on every weather chart so
the two are never confused.
