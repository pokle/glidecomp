/**
 * The modelled-weather chart trio (wind, sky, thermal ceiling) plus the
 * provider credit, shared by the two surfaces that show them: the task
 * page's met-only TaskWeatherPanel and the task-analysis page's combined
 * flown-vs-modelled stack (DayProfilePanel). One implementation so the
 * charts and their CC BY attribution can never drift apart between pages.
 *
 * Callers own the time axis, the frame the charts are drawn in and the
 * selected hour — that is the point of the split: the combined stack folds
 * these charts onto the same axis as the pilot-derived ones, while the task
 * page builds an axis from the weather hours alone. {@link MetReadout} prints
 * the selected hour's figures; the caller decides where it sits.
 */
import type { TaskWeather, WeatherHour } from "@/react/weather/types";
import { sourceKindLabel } from "@/react/weather/types";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { unitDisplay } from "../../units";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { MetWindChart } from "./MetWindChart";
import { MetSkyChart } from "./MetSkyChart";
import { MetThermalChart } from "./MetThermalChart";
import { cloudReading, flyingHeightLabel, heightReading, windReading } from "./met-readout";
import { sampleProvenance } from "./met-shared";

const HOUR_MS = 3_600_000;

export function MetChartsGroup({
  weather,
  hours,
  axis,
  frame,
  timeZone,
  selectedMs,
  onSelect,
}: {
  weather: TaskWeather;
  /** The hours to draw — the caller's clamp of `weather.hours` to its own
   * display window (daylight on the task page, the flown window on the
   * task-analysis page). Explicit rather than defaulted so a caller cannot
   * accidentally chart hours its axis was not built for. */
  hours: WeatherHour[];
  axis: TimeAxis;
  /** The stack's geometry — the same object for every chart in it. */
  frame: ChartFrame;
  timeZone: string | undefined;
  /** Start of the selected hour (epoch ms), drawn as a band through all
   * three charts; null when none is. */
  selectedMs: number | null;
  onSelect: (tMs: number | null) => void;
}) {
  const shared = { hours, source: weather.source, axis, frame, timeZone, selectedMs, onSelect };
  return (
    <div className="space-y-3">
      <MetWindChart {...shared} terrainElevationM={weather.resolved.elevationM} />
      {/* Cloud sits ABOVE the ceiling chart, and its lanes run high at the
          top — so the stack reads the way the sky is stacked: cirrus, then
          the cloud base and thermal top beneath it. */}
      <MetSkyChart {...shared} />
      <MetThermalChart {...shared} />
    </div>
  );
}

/**
 * The selected hour's exact figures, all three charts together — what the
 * hover line used to print one chart at a time, and only for a mouse.
 *
 * `aria-hidden`, as the hover line was: every hour column on every chart is
 * already named with its own figures, so a live region here would say each
 * one twice. Hidden in print, where there is no hour to select.
 */
export function MetReadout({
  weather,
  hours,
  timeZone,
  selectedMs,
}: {
  weather: TaskWeather;
  hours: WeatherHour[];
  timeZone: string | undefined;
  selectedMs: number | null;
}) {
  const wind = unitDisplay("km/h", useUnits());
  const alt = unitDisplay("m", useUnits());
  const hour =
    selectedMs === null ? null : hours.find((h) => new Date(h.t).getTime() === selectedMs);

  if (!hour) {
    return (
      <p
        aria-hidden
        data-met-readout
        className="min-h-24 text-xs text-muted-foreground sm:min-h-16 print:hidden"
      >
        Select an hour on a chart to see its exact figures.
      </p>
    );
  }

  // Same datum as the wind chart: the task's terrain before the grid's.
  const terrainM = weather.resolved.elevationM ?? weather.source.pointElevationM;
  const lines: [string, string | null][] = [
    ["Wind", windReading(hour, terrainM, wind, flyingHeightLabel(hours, terrainM, alt))],
    ["Cloud", cloudReading(hour)],
    ["Height", heightReading(hour, alt)],
  ];
  return (
    <div
      aria-hidden
      data-met-readout
      className="min-h-24 text-xs text-muted-foreground sm:min-h-16 print:hidden"
    >
      <p className="font-medium text-foreground">
        {formatTimeRange(
          hour.t,
          new Date(new Date(hour.t).getTime() + HOUR_MS).toISOString(),
          timeZone
        )}
      </p>
      {lines.map(([name, text]) =>
        text ? (
          <p key={name}>
            {name}: {text}
          </p>
        ) : null
      )}
    </div>
  );
}


/** Full credit, once per surface. CC BY 4.0 requires the attribution; the
 * grid point requires the caveat, because a reader comparing these numbers
 * against the tracklogs deserves to know the weather was sampled kilometres
 * away and possibly hundreds of metres off in elevation. */
export function MetAttribution({ weather }: { weather: TaskWeather }) {
  return (
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
      organiser&rsquo;s notes are the local ground truth.
    </p>
  );
}
