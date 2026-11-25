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
 * page builds an axis from the weather hours alone. Each chart prints its
 * own figures for the selected hour in its legend row.
 */
import type { TaskWeather, WeatherHour } from "@/react/weather/types";
import { sourceKindLabel } from "@/react/weather/types";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { MetWindChart } from "./MetWindChart";
import { MetSkyChart } from "./MetSkyChart";
import { MetThermalChart } from "./MetThermalChart";
import { Explain } from "@/react/rac/explain";
import { sampleOffset, sampleProvenance } from "./met-shared";

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
    <div className="space-y-5">
      <MetWindChart {...shared} terrainElevationM={weather.resolved.elevationM} />
      {/* Cloud sits ABOVE the ceiling chart, and its lanes run high at the
          top — so the stack reads the way the sky is stacked: cirrus, then
          the cloud base and thermal top beneath it. */}
      <MetSkyChart {...shared} />
      <MetThermalChart {...shared} />
    </div>
  );
}

/** Full credit, once per surface. CC BY 4.0 requires the attribution; the
 * grid point requires the caveat, because a reader comparing these numbers
 * against the tracklogs deserves to know the weather was sampled kilometres
 * away and possibly hundreds of metres off in elevation.
 *
 * The sentence says how far away; the coordinates, the cell size and its
 * elevation are behind the ⓘ, and printed in its place on paper. */
export function MetAttribution({ weather }: { weather: TaskWeather }) {
  const { distanceKm } = sampleOffset(weather);
  const cell =
    distanceKm !== null && distanceKm >= 0.1
      ? `A grid cell ${distanceKm.toFixed(1)} km from the task centre`
      : "A grid cell";
  const where = `Sampled at ${weather.source.pointLat.toFixed(3)}, ${weather.source.pointLon.toFixed(3)}${sampleProvenance(weather)}`;
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
      ({weather.source.model}, {weather.source.license}). {cell}, not a reading
      at launch — the organiser&rsquo;s notes are the local ground truth.
      <Explain label="The grid cell" className="ml-0.5 align-middle">
        <p>{where}</p>
      </Explain>
      <span className="hidden print:inline"> {where}</span>
    </p>
  );
}
