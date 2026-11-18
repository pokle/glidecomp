/**
 * One hour of the modelled weather, in words — the exact figures the three
 * weather charts draw.
 *
 * Pure, so the wording is unit-testable and so the two places that say it
 * cannot drift: the readout under the stack (one selected hour, all three
 * charts' figures together) and each chart's own hour columns, whose
 * accessible names are these same sentences.
 *
 * Values arrive in the provider's units (km/h, metres) and are converted
 * here, at the display boundary, with the viewer's `UnitDisplay`.
 */
import type { WeatherHour } from "../../../weather/types";
import { flyingHeightLevel } from "../../../weather/types";
import type { UnitDisplay } from "../../../lib/units";
import { degToCompass } from "./met-shared";

/**
 * "~1457 m": the mean height of the pressure level the wind chart calls
 * flying height, across the hours shown. Null when the dataset has no levels.
 */
export function flyingHeightLabel(
  hours: readonly WeatherHour[],
  terrainM: number | null,
  alt: UnitDisplay
): string | null {
  const heights = hours
    .map((h) => flyingHeightLevel(h.levels, terrainM)?.heightM ?? null)
    .filter((v): v is number => v !== null);
  if (heights.length === 0) return null;
  const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
  return `~${Math.round(mean * alt.factor)} ${alt.unit}`;
}

/** "23 km/h from 290° (WNW) at ~1457 m, surface 12 km/h from 270° (W),
 * gusting 25 km/h". Null when the hour carries no wind at all. */
export function windReading(
  hour: WeatherHour,
  terrainM: number | null,
  wind: UnitDisplay,
  heightLabel: string | null
): string | null {
  const parts: string[] = [];
  const level = flyingHeightLevel(hour.levels, terrainM);
  if (level?.windSpeedKmh != null && level.windDirectionDeg != null) {
    parts.push(
      `${(level.windSpeedKmh * wind.factor).toFixed(0)} ${wind.unit} from ` +
        `${Math.round(level.windDirectionDeg)}° (${degToCompass(level.windDirectionDeg)}) ` +
        `at ${heightLabel ?? "flying height"}`
    );
  }
  const { windSpeedKmh, windDirectionDeg, windGustKmh } = hour.surface;
  if (windSpeedKmh != null && windDirectionDeg != null) {
    parts.push(
      `surface ${(windSpeedKmh * wind.factor).toFixed(0)} ${wind.unit} from ` +
        `${Math.round(windDirectionDeg)}° (${degToCompass(windDirectionDeg)})`
    );
  }
  if (windGustKmh != null) {
    parts.push(`gusting ${(windGustKmh * wind.factor).toFixed(0)} ${wind.unit}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Low first — the pilot's order, and the order the readout has always used. */
const CLOUD_LAYERS = [
  { key: "lowPct", label: "low" },
  { key: "midPct", label: "mid" },
  { key: "highPct", label: "high" },
] as const;

/** "low 0%, mid 40%, high 20%, rain 0.2 mm". Null with no cloud data. */
export function cloudReading(hour: WeatherHour): string | null {
  const parts = CLOUD_LAYERS.filter(({ key }) => hour.cloud[key] !== null).map(
    ({ key, label }) => `${label} ${Math.round(hour.cloud[key]!)}%`
  );
  if (parts.length === 0) return null;
  const rain = hour.precipitationMm;
  if (rain && rain > 0) parts.push(`rain ${rain.toFixed(1)} mm`);
  return parts.join(", ");
}

/** "thermal top 2950 m AGL, cloud base 3100 m AGL, blue, CAPE 120 J/kg".
 * Null when the hour has neither height. */
export function heightReading(hour: WeatherHour, alt: UnitDisplay): string | null {
  const bl = hour.boundaryLayerDepthM;
  const base = hour.cloudBaseAglM;
  if (bl == null && base == null) return null;
  const parts: string[] = [];
  if (bl != null) parts.push(`thermal top ${(bl * alt.factor).toFixed(0)} ${alt.unit} AGL`);
  if (base != null) parts.push(`cloud base ${(base * alt.factor).toFixed(0)} ${alt.unit} AGL`);
  if (bl != null && base != null) parts.push(base > bl ? "blue" : "cumulus");
  if (hour.capeJkg != null) parts.push(`CAPE ${Math.round(hour.capeJkg)} J/kg`);
  return parts.join(", ");
}
