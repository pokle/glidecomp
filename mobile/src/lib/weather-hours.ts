/**
 * The day's modelled weather as rows a reader can scan: one per daylight
 * hour, in the comp's zone. Stage 3 brings the charts (react-native-svg);
 * until then this is the readout, and it stays as the exact reading under
 * them, as the website's tables do.
 */
import { bestDaylightWindow, formatAltitude, formatSpeed, type UnitPreferences } from '@glidecomp/engine';
import { usableCeilingM } from '@glidecomp/client/met';
import { formatTimeInZone } from '@glidecomp/client/time';
import type { TaskWeather } from '@glidecomp/client/weather';

const HOUR_MS = 3_600_000;

export interface WeatherRow {
  key: string;
  time: string;
  wind: string;
  detail: string;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function kmh(prefs: UnitPreferences, value: number): string {
  return formatSpeed(value / 3.6, { prefs }).withUnit;
}

export function weatherRows(
  weather: TaskWeather,
  timeZone: string | null,
  prefs: UnitPreferences,
): WeatherRow[] {
  const { lat, lon, fromMs, toMs } = weather.resolved;
  const win = bestDaylightWindow(lat, lon, fromMs, toMs);
  const hours = win
    ? weather.hours.filter((h) => {
        const t = new Date(h.t).getTime();
        return Number.isFinite(t) && t + HOUR_MS > win.sunriseMs && t < win.sunsetMs;
      })
    : weather.hours;
  return hours.map((h) => {
    const s = h.surface;
    const wind =
      s.windSpeedKmh == null
        ? '—'
        : `${kmh(prefs, s.windSpeedKmh)}${s.windDirectionDeg == null ? '' : ` ${compass(s.windDirectionDeg)}`}`;
    const ceiling = usableCeilingM(h.boundaryLayerDepthM, h.cloudBaseAglM);
    const parts = [
      s.windGustKmh == null ? null : `gusts ${kmh(prefs, s.windGustKmh)}`,
      h.cloud.totalPct == null ? null : `cloud ${Math.round(h.cloud.totalPct)}%`,
      ceiling == null ? null : `ceiling ${formatAltitude(ceiling, { prefs }).withUnit} above ground`,
    ].filter(Boolean);
    return {
      key: h.t,
      time: formatTimeInZone(new Date(h.t), timeZone ?? undefined).slice(0, 5),
      wind,
      detail: parts.join(' · '),
    };
  });
}
