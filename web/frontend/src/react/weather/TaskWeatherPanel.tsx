/**
 * The modelled weather for a task's day — wind, sky, thermal ceiling — on one
 * shared time axis, with the provider credit and grid-cell provenance.
 *
 * This is the TASK PAGE's weather surface: modelled charts alone, because the
 * task page has no pilot-derived series to set them against. The
 * field-analysis page instead stacks the same charts (via MetChartsGroup)
 * under the flown, track-derived ones on a single axis — see
 * field-analysis/charts/day-profile/DayProfilePanel.tsx — so a reader there
 * can compare the predicted day against the day the field actually flew.
 */
import { useMemo, useState } from "react";
import type { TaskWeather } from "./types";
import { zoneAbbrev } from "@/react/lib/time";
import { buildTimeAxis } from "@/react/field-analysis/charts/day-profile/time-axis";
import { PLOT_LEFT, PLOT_RIGHT } from "@/react/field-analysis/charts/day-profile/shared";
import {
  MetChartsGroup,
  MetAttribution,
} from "@/react/field-analysis/charts/day-profile/MetChartsGroup";
import { weatherInstants } from "@/react/field-analysis/charts/day-profile/met-shared";

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
      <MetChartsGroup weather={weather} axis={axis} timeZone={timeZone} setReadout={setReadout} />
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout ?? "Hover a chart for exact figures."}
      </p>
      <p className="text-xs text-muted-foreground">
        All charts share one time axis ({zone}). Arrows fly WITH the wind — the
        readout&rsquo;s direction figures are degrees the wind blows from.
      </p>
      <MetAttribution weather={weather} />
    </figure>
  );
}
