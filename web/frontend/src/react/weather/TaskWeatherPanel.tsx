/**
 * The modelled weather for a task's day — wind, sky, thermal ceiling — on one
 * shared time axis, with the provider credit and grid-cell provenance.
 *
 * Extracted from the field-analysis day panel (where it used to sit stacked
 * under the pilot-derived charts) so the same charts can front BOTH the task
 * page and the field-analysis report. The conditions are grounding a reader
 * needs BEFORE interpreting scores or metrics — on a windy day glide speed
 * decides the task, on a weak day catching every climb does — so they get
 * their own section, not an appendix inside one collapsed chart stack.
 *
 * The hosts supply the heading and the organizer's notes (WeatherNotesBlock);
 * this panel owns everything modelled. Every chart carries its source inside
 * the plot (MetSourceTag), and the full CC BY credit renders once per panel.
 */
import { useMemo, useState } from "react";
import type { TaskWeather } from "./types";
import { sourceKindLabel } from "./types";
import { zoneAbbrev } from "@/react/lib/time";
import { buildTimeAxis } from "@/react/field-analysis/charts/day-profile/time-axis";
import { PLOT_LEFT, PLOT_RIGHT } from "@/react/field-analysis/charts/day-profile/shared";
import { MetWindChart } from "@/react/field-analysis/charts/day-profile/MetWindChart";
import { MetSkyChart } from "@/react/field-analysis/charts/day-profile/MetSkyChart";
import { MetThermalChart } from "@/react/field-analysis/charts/day-profile/MetThermalChart";
import {
  sampleOffset,
  weatherInstants,
} from "@/react/field-analysis/charts/day-profile/met-shared";

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

export function TaskWeatherPanel({
  weather,
  compTimezone,
  pending = false,
}: {
  /** Modelled conditions for the task window; null while loading, when the
   * task has no route or date, or when every provider failed. */
  weather: TaskWeather | null;
  /** Competition IANA zone; the axis ticks in it (viewer-local when null). */
  compTimezone: string | null;
  /** True while an answer is still on its way (first client request, or the
   * server's background fetch) — renders a placeholder line rather than
   * nothing, so the section doesn't pop into an already-read page. */
  pending?: boolean;
}) {
  const timeZone = compTimezone ?? undefined;
  const [readout, setReadout] = useState<string | null>(null);

  const hours = weather?.hours ?? [];
  const axis = useMemo(
    () => buildTimeAxis(weatherInstants(hours), timeZone, [PLOT_LEFT, PLOT_RIGHT]),
    [hours, timeZone]
  );

  if (!weather || hours.length === 0 || !axis) {
    // Deterministic (no zone abbreviation, no dates), so it is safe to
    // server-render while the client takes over the fetch.
    return pending ? (
      <p className="text-sm text-muted-foreground">
        Fetching the day&rsquo;s weather — it will appear here in a moment.
      </p>
    ) : null;
  }

  const zone = zoneAbbrev(new Date(axis.domainStart), timeZone);

  return (
    <figure className="space-y-1">
      <MetWindChart
        hours={weather.hours}
        source={weather.source}
        terrainElevationM={weather.resolved.elevationM}
        axis={axis}
        timeZone={timeZone}
        setReadout={setReadout}
      />
      {/* Cloud sits ABOVE the ceiling chart, and its lanes run high at the
          top — so the stack reads the way the sky is stacked: cirrus, then
          the cloud base and thermal top beneath it. */}
      <MetSkyChart
        hours={weather.hours}
        source={weather.source}
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
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout ?? "Hover a chart for exact figures."}
      </p>
      <p className="text-xs text-muted-foreground">
        All charts share one time axis ({zone}). Arrows fly WITH the wind — the
        readout&rsquo;s direction figures are degrees the wind blows from.
      </p>
      {/* Full credit, once. CC BY 4.0 requires the attribution; the grid
          point requires the caveat, because a reader comparing these numbers
          against the tracklogs deserves to know the weather was sampled
          kilometres away and possibly hundreds of metres off in elevation. */}
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
        organizer&rsquo;s notes are the local ground truth.
      </p>
    </figure>
  );
}
