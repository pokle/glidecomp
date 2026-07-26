// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Sunrise and sunset for a point and a day — the standard sunrise equation
 * (NOAA/Meeus simplification), sun centre at −0.833° to fold in atmospheric
 * refraction and the solar semi-diameter.
 *
 * Exists so the UI can clamp a whole-day weather answer to the hours a
 * free-flying pilot could actually have been airborne: a task with no
 * launch-window or deadline times falls back to a full-day weather query
 * (see task-query.ts), and charting that answer raw draws an axis out to
 * midnight. Accuracy is a minute or three, which is far inside an hourly
 * chart's resolution; this is presentation, not astronomy.
 *
 * Pure math — no Date-zone dependence (everything is epoch ms / UTC), so it
 * behaves identically in workerd, the browser and a test.
 */

const DAY_MS = 86_400_000;
/** Epoch ms of the J2000.0 reference (2000-01-01T12:00:00Z). */
const J2000_MS = 946_728_000_000;
const RAD = Math.PI / 180;

export interface SunTimes {
  /** Epoch ms of sunrise (sun centre crosses −0.833° going up). */
  sunriseMs: number;
  /** Epoch ms of sunset. */
  sunsetMs: number;
}

/**
 * Sunrise/sunset for the UTC day containing `dayMs`, at `lat`/`lon`
 * (degrees, east-positive). Returns null in polar day or polar night, where
 * the sun never crosses the horizon — callers should then skip clamping
 * rather than invent a window.
 *
 * The returned instants belong to the LOCAL solar day nearest that UTC day's
 * noon at this longitude, so for far-eastern or far-western longitudes the
 * sunrise can fall on the neighbouring UTC date — which is exactly what a
 * caller filtering hour-by-hour wants.
 */
export function sunTimes(lat: number, lon: number, dayMs: number): SunTimes | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(dayMs)) return null;

  // Whole days since the J2000 noon epoch: dayMs is a midnight, which sits
  // at k − 0.5 days from that epoch, so +0.5 recovers the integer day. The
  // longitude enters only through jStar below — putting it here too would
  // shift far-east/far-west longitudes onto the wrong day.
  const n = Math.round((dayMs - J2000_MS) / DAY_MS + 0.5);
  // Mean solar noon (in days since J2000) at this longitude.
  const jStar = n - lon / 360;

  // Solar mean anomaly, centre correction, ecliptic longitude (degrees).
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;

  // True solar transit (days since J2000), then declination.
  const jTransit = jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDecl = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDecl = Math.cos(Math.asin(sinDecl));

  // Hour angle of the −0.833° crossing; |cos| > 1 means it never happens.
  const cosOmega =
    (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDecl) /
    (Math.cos(lat * RAD) * cosDecl);
  if (cosOmega > 1 || cosOmega < -1) return null;
  const omegaDays = Math.acos(cosOmega) / RAD / 360;

  const toMs = (jDays: number) => J2000_MS + jDays * DAY_MS;
  return { sunriseMs: toMs(jTransit - omegaDays), sunsetMs: toMs(jTransit + omegaDays) };
}

/**
 * The ONE daylight window (sunrise..sunset of a single local day) that
 * overlaps [fromMs, toMs) the most, or null when the sun never crosses the
 * horizon there (polar day/night) — callers should then skip clamping
 * rather than invent a window.
 *
 * One window rather than "any daylight", deliberately: a whole-UTC-day
 * weather answer for an Australian task runs from late morning through
 * local midnight into the NEXT day's dawn. Filtering hour-by-hour against
 * all daylight would keep that next morning too — a gap in the axis and a
 * chunk of a day the task wasn't flown on. The flying day is one sunrise
 * to one sunset; this picks it.
 */
export function bestDaylightWindow(
  lat: number,
  lon: number,
  fromMs: number,
  toMs: number
): SunTimes | null {
  // A day each side covers longitudes where the solar day straddles the
  // UTC date.
  const firstDay = Math.floor(fromMs / DAY_MS) - 1;
  const lastDay = Math.floor(toMs / DAY_MS) + 1;
  let best: SunTimes | null = null;
  let bestOverlap = 0;
  for (let d = firstDay; d <= lastDay; d++) {
    const sun = sunTimes(lat, lon, d * DAY_MS);
    if (!sun) continue;
    const overlap =
      Math.min(toMs, sun.sunsetMs) - Math.max(fromMs, sun.sunriseMs);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = sun;
    }
  }
  return best;
}
