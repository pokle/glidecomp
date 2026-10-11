/**
 * The modelled-weather chart trio (wind, sky, thermal ceiling) plus the
 * provider credit, shared by the two surfaces that show them: the task
 * page's met-only TaskWeatherPanel and the task-analysis page's combined
 * flown-vs-modelled stack (DayProfilePanel). One implementation so the
 * charts and their CC BY attribution can never drift apart between pages.
 *
 * Callers own the time axis and the shared readout line — that is the point
 * of the split: the combined stack folds these charts onto the same axis as
 * the pilot-derived ones, while the task page builds an axis from the
 * weather hours alone.
 */
import type { TaskWeather, WeatherHour } from "@/react/weather/types";
import { sourceKindLabel } from "@/react/weather/types";
import type { TimeAxis } from "./time-axis";
import { MetWindChart } from "./MetWindChart";
import { MetSkyChart } from "./MetSkyChart";
import { MetThermalChart } from "./MetThermalChart";
import { sampleProvenance } from "@glidecomp/client/met";

export function MetChartsGroup({
  weather,
  hours,
  axis,
  timeZone,
  setReadout,
}: {
  weather: TaskWeather;
  /** The hours to draw — the caller's clamp of `weather.hours` to its own
   * display window (daylight on the task page, the flown window on the
   * task-analysis page). Explicit rather than defaulted so a caller cannot
   * accidentally chart hours its axis was not built for. */
  hours: WeatherHour[];
  axis: TimeAxis;
  timeZone: string | undefined;
  setReadout: (text: string | null) => void;
}) {
  return (
    <>
      <MetWindChart
        hours={hours}
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
        hours={hours}
        source={weather.source}
        axis={axis}
        timeZone={timeZone}
        setReadout={setReadout}
      />
      <MetThermalChart
        hours={hours}
        source={weather.source}
        axis={axis}
        timeZone={timeZone}
        setReadout={setReadout}
      />
    </>
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
