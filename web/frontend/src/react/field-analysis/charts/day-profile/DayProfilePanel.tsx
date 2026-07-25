/**
 * The day at a glance: the day family's charting series composed onto ONE
 * shared time axis — wind by hour on top, the climb quantile fan (with the
 * day-timing overlays) in the middle, the per-leg wind Gantt at the bottom.
 * A vertical scan through the stack reads "at 2pm: wind 18 km/h NW, climbs
 * at their best, most of the field on leg 3" — which no single chart or
 * table can say.
 *
 * The series come from THREE different metrics (day.wind,
 * day.climb_by_hour, day.airtime_quality); this panel is why SeriesChart
 * deliberately doesn't render them per-metric. Each chart is a labelled
 * `role="img"`; the metrics' tables below the panel remain the exact,
 * screen-reader-navigable reading, and one shared readout line voices
 * whatever the pointer is over.
 *
 * Below those sits a SECOND group on the same axis: what the meteorology
 * says the day did (wind, cloud, thermal ceiling), from an outside provider
 * — see the engine's weather/ module. Stacked rather than overlaid onto the
 * pilot-derived charts, deliberately: the two answer the same questions from
 * incompatible evidence (a field of tracklogs versus a grid cell kilometres
 * wide), and overlaying them would imply one is a correction of the other.
 * Side by side on a shared clock, a disagreement stays legible as a
 * disagreement. Every weather chart carries its source inside the plot, and
 * the group is fronted by the organizer's own notes, which are the only
 * local ground truth on the page.
 */
import { useMemo, useState } from "react";
import type {
  ClimbHourlySeries,
  DayTimingSeries,
  MetricReport,
  WindHourlySeries,
  WindLegsSeries,
} from "../../types";
import type { TaskWeather } from "@/react/weather/types";
import { sourceKindLabel } from "@/react/weather/types";
import { zoneAbbrev } from "@/react/lib/time";
import { buildTimeAxis } from "./time-axis";
import { PLOT_LEFT, PLOT_RIGHT } from "./shared";
import { WindHourlyChart } from "./WindHourlyChart";
import { ClimbHourlyChart } from "./ClimbHourlyChart";
import { WindLegsGantt } from "./WindLegsGantt";
import { MetWindChart } from "./MetWindChart";
import { MetSkyChart } from "./MetSkyChart";
import { MetThermalChart } from "./MetThermalChart";
import { sampleOffset, weatherInstants } from "./met-shared";
import { WeatherNotesBlock } from "@/react/weather/WeatherNotesBlock";

const HOUR_MS = 3_600_000;

/**
 * Every instant a set of day-profile series mentions, as epoch ms.
 *
 * The weather hours are included, so the whole stack — pilot-derived and
 * modelled alike — shares one domain. Excluding them would be the subtle
 * kind of wrong: each chart would still LOOK aligned while a weather hour
 * sat at a different x than the flight hour beside it. The cost is that the
 * task's ±1 h of weather padding widens the axis a little, which is a fair
 * trade for showing the morning that set the day up.
 */
function collectInstants(
  wind: WindHourlySeries | null,
  climb: ClimbHourlySeries | null,
  legs: WindLegsSeries | null,
  timing: DayTimingSeries | null,
  weatherHours: readonly { t: string }[] = []
): number[] {
  const out: number[] = [];
  const push = (iso: string | null | undefined) => {
    if (!iso) return;
    const t = new Date(iso).getTime();
    if (Number.isFinite(t)) out.push(t);
  };
  for (const h of wind?.hours ?? []) {
    push(h.t);
    out.push(new Date(h.t).getTime() + HOUR_MS);
  }
  for (const h of climb?.hours ?? []) {
    push(h.t);
    out.push(new Date(h.t).getTime() + HOUR_MS);
  }
  for (const l of legs?.legs ?? []) {
    push(l.from);
    push(l.to);
  }
  if (timing) {
    timing.takeoffs.forEach(push);
    timing.startGates.forEach(push);
    push(timing.launchOpen);
    push(timing.deadline);
    push(timing.bestHour?.from);
    push(timing.bestHour?.to);
  }
  out.push(...weatherInstants(weatherHours));
  return out.filter((t) => Number.isFinite(t));
}

/**
 * The provenance clause after the grid coordinates: cell size, how far the
 * sample sits from the task, and how far its terrain is from the real
 * terrain.
 *
 * Assembled here rather than inline because each part is independently
 * omittable — a provider that cannot honestly state its resolution (see
 * `WeatherSource.resolutionKm`) simply doesn't get that clause, rather than
 * printing a guess.
 */
function sampleProvenance(weather: TaskWeather): string {
  const { distanceKm, elevationDeltaM } = sampleOffset(weather);
  const parts: string[] = [];

  if (weather.source.resolutionKm !== null) {
    parts.push(`~${weather.source.resolutionKm} km grid`);
  } else {
    // Honest about the gap: best-match picks a model per location and the
    // API does not say which, so the cell size genuinely isn't knowable here.
    parts.push("grid size varies by location");
  }
  if (distanceKm !== null && distanceKm >= 0.1) {
    parts.push(`${distanceKm.toFixed(1)} km from the task centre`);
  }
  if (weather.source.pointElevationM !== null) {
    const grid = Math.round(weather.source.pointElevationM);
    if (elevationDeltaM !== null && Math.abs(elevationDeltaM) >= 50) {
      // The caveat worth spelling out: heights on the thermal chart are AGL
      // from THIS datum, which a smoothed grid can put hundreds of metres
      // below the ground the pilots actually flew over.
      const delta = Math.round(elevationDeltaM);
      parts.push(
        `grid elevation ${grid} m, ${Math.abs(delta)} m ${delta < 0 ? "below" : "above"} the task's terrain`
      );
    } else {
      parts.push(`grid elevation ${grid} m`);
    }
  }

  return parts.length > 0 ? ` (${parts.join("; ")}).` : ".";
}

export function DayProfilePanel({
  metrics,
  compTimezone,
  weather = null,
  weatherNotes = "",
}: {
  metrics: MetricReport[];
  /** Competition IANA zone; the axis ticks in it (viewer-local when null). */
  compTimezone: string | null;
  /** Modelled conditions for the task window; null while loading, when the
   * task has no route, or when every provider failed. The panel degrades to
   * the pilot-derived charts alone rather than showing an empty section. */
  weather?: TaskWeather | null;
  /** The organizer's account of the day. Shown above the weather charts
   * because a human who was there outranks a grid cell. */
  weatherNotes?: string;
}) {
  const timeZone = compTimezone ?? undefined;
  const [readout, setReadout] = useState<string | null>(null);

  const { wind, climb, legs, timing } = useMemo(() => {
    const all = metrics.flatMap((m) => m.extraSeries ?? []);
    return {
      wind: (all.find((s) => s.kind === "wind-hourly") ?? null) as WindHourlySeries | null,
      climb: (all.find((s) => s.kind === "climb-hourly") ?? null) as ClimbHourlySeries | null,
      legs: (all.find((s) => s.kind === "wind-legs") ?? null) as WindLegsSeries | null,
      timing: (all.find((s) => s.kind === "day-timing") ?? null) as DayTimingSeries | null,
    };
  }, [metrics]);

  const weatherHours = weather?.hours ?? [];

  const axis = useMemo(
    () =>
      buildTimeAxis(
        collectInstants(wind, climb, legs, timing, weatherHours),
        timeZone,
        [PLOT_LEFT, PLOT_RIGHT]
      ),
    [wind, climb, legs, timing, weatherHours, timeZone]
  );

  const showWind = wind !== null && wind.hours.length > 0;
  const showClimb = climb !== null && climb.hours.length > 0;
  const showLegs = legs !== null && legs.legs.some((l) => l.n > 0);
  const showWeather = weather !== null && weatherHours.length > 0;
  if (!axis || (!showWind && !showClimb && !showLegs && !showWeather)) return null;

  const zone = zoneAbbrev(new Date(axis.domainStart), timeZone);

  // The ⓘ text of every metric whose series is actually drawn, inline under
  // the heading — the panel composes several metrics, so each line carries
  // its metric's name. Reads with the charts on screen and in print alike.
  const shownKinds = new Set<string>([
    ...(showWind ? ["wind-hourly"] : []),
    ...(showClimb ? ["climb-hourly", "day-timing"] : []),
    ...(showLegs ? ["wind-legs"] : []),
  ]);
  const contributors = metrics.filter((m) =>
    (m.extraSeries ?? []).some((s) => shownKinds.has(s.kind))
  );

  return (
    <figure className="space-y-1">
      <figcaption className="text-sm font-medium">The day at a glance</figcaption>
      {contributors.length > 0 ? (
        <div className="space-y-0.5 pb-1">
          {contributors.map((m) => (
            <p key={m.id} className="text-xs text-muted-foreground">
              <span className="font-medium">{m.label}.</span> {m.explanation}
            </p>
          ))}
        </div>
      ) : null}
      {showWind ? (
        <WindHourlyChart series={wind} axis={axis} timeZone={timeZone} setReadout={setReadout} />
      ) : null}
      {showClimb ? (
        <ClimbHourlyChart
          series={climb}
          timing={timing}
          axis={axis}
          timeZone={timeZone}
          setReadout={setReadout}
        />
      ) : null}
      {showLegs && legs ? (
        <WindLegsGantt series={legs} timing={timing} axis={axis} timeZone={timeZone} setReadout={setReadout} />
      ) : null}

      {/* ── What the meteorology says, on the same clock ──────────────────
          A labelled break, because everything above is measured from the
          pilots' own tracks and everything below is not. */}
      {weatherNotes.trim() || showWeather ? (
        <div className="space-y-1 border-t pt-3">
          <h4 className="text-sm font-medium">What the weather did</h4>
          <WeatherNotesBlock notes={weatherNotes} />
          {showWeather && weather ? (
            <>
              <MetWindChart
                hours={weather.hours}
                source={weather.source}
                terrainElevationM={weather.resolved.elevationM}
                axis={axis}
                timeZone={timeZone}
                setReadout={setReadout}
              />
              <MetThermalChart
                hours={weather.hours}
                source={weather.source}
                axis={axis}
                timeZone={timeZone}
                setReadout={setReadout}
              />
              <MetSkyChart
                hours={weather.hours}
                source={weather.source}
                axis={axis}
                timeZone={timeZone}
                setReadout={setReadout}
              />
            </>
          ) : null}
        </div>
      ) : null}

      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout ?? "Hover a chart for exact figures."}
      </p>
      <p className="text-xs text-muted-foreground">
        All charts share one time axis ({zone}). Arrows fly WITH the wind — the tables' direction
        figures are degrees the wind blows from; arrow length and opacity track speed and sample
        count. Exact numbers are in the tables below.
      </p>
      {/* Full credit, once. CC BY 4.0 requires the attribution; the grid
          point requires the caveat, because a reader comparing these
          numbers against the tracklogs above deserves to know the weather
          was sampled kilometres away and possibly hundreds of metres off in
          elevation. */}
      {showWeather && weather ? (
        <p className="text-xs text-muted-foreground">
          Weather charts: {sourceKindLabel(weather.source.kind)} data from{" "}
          <a
            href={weather.source.attributionUrl}
            className="underline"
            target="_blank"
            rel="noreferrer"
          >
            {weather.source.attribution}
          </a>{" "}
          ({weather.source.model}, {weather.source.license}). Sampled at{" "}
          {weather.source.pointLat.toFixed(3)}, {weather.source.pointLon.toFixed(3)}
          {sampleProvenance(weather)} A grid cell, not a reading at launch — the
          notes above are the local ground truth.
        </p>
      ) : null}
    </figure>
  );
}
