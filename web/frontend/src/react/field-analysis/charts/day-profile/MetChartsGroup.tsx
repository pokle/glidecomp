/**
 * The modelled-weather chart trio (wind, sky, thermal ceiling) plus the
 * provider credit, shared by the two surfaces that show them: the task
 * page's met-only TaskWeatherPanel and the field-analysis page's combined
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
import { sampleOffset } from "./met-shared";

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
   * field-analysis page). Explicit rather than defaulted so a caller cannot
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
      organizer&rsquo;s notes are the local ground truth.
    </p>
  );
}
