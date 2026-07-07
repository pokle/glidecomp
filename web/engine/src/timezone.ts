/**
 * Competition-local timezone derivation (#269).
 *
 * Maps a task's location to an IANA zone name with tz-lookup — a pure-JS
 * coordinate→zone table that runs in Workers, bun and the browser alike
 * (no native deps, no filesystem). The zone is purely presentational:
 * gates, fixes and all scoring run on UTC.
 *
 * Deliberately NOT re-exported from the engine's index: tz-lookup embeds a
 * ~70 KB data table that browser bundles importing `@glidecomp/engine`
 * must not pay for. Import via the `@glidecomp/engine/timezone` subpath.
 */
import tzLookup from "tz-lookup";

/**
 * Best-effort IANA zone for a coordinate, e.g. (-36.55, 147.89) →
 * "Australia/Melbourne". Returns undefined for out-of-range input.
 * tz-lookup is coarse near zone borders — callers must keep an explicit
 * override available (the comp settings `timezone` field).
 */
export function timezoneForCoords(lat: number, lon: number): string | undefined {
  try {
    return tzLookup(lat, lon);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort IANA zone for a task: the zone at its first turnpoint.
 * Accepts the stored xctsk JSON string or an already-parsed task object;
 * returns undefined when there is no readable turnpoint coordinate.
 */
export function timezoneForXctsk(xctsk: unknown): string | undefined {
  let task: unknown = xctsk;
  if (typeof task === "string") {
    try {
      task = JSON.parse(task);
    } catch {
      return undefined;
    }
  }
  if (task === null || typeof task !== "object") return undefined;
  const turnpoints = (task as { turnpoints?: unknown }).turnpoints;
  if (!Array.isArray(turnpoints) || turnpoints.length === 0) return undefined;
  const waypoint = (turnpoints[0] as { waypoint?: unknown })?.waypoint;
  if (waypoint === null || typeof waypoint !== "object") return undefined;
  const { lat, lon } = waypoint as { lat?: unknown; lon?: unknown };
  if (typeof lat !== "number" || typeof lon !== "number") return undefined;
  return timezoneForCoords(lat, lon);
}

/**
 * True when `zone` is a timezone identifier the runtime's Intl accepts —
 * IANA names plus (per modern ECMA-402) bare offsets like "+11:00". Every
 * consumer is Intl itself, so "Intl accepts it" is the correct contract.
 */
export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
