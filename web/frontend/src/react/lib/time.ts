/**
 * Comp-local time helpers (#269 / #274).
 *
 * A competition's `timezone` (an IANA name stored in comp settings) is
 * purely presentational — gates, fixes and all scoring run on UTC. These
 * helpers convert between the xctsk file's UTC times of day and the comp's
 * wall clock for display and editing. All conversions anchor to the task
 * date so DST offsets are the ones in force on the day.
 *
 * Kept DOM-free so it's unit-testable (see time.test.ts).
 */

/**
 * Minutes the zone is ahead of UTC at `utc` (AEDT → +660). Computed from
 * Intl.formatToParts, so it follows the runtime's tz database including DST.
 */
function zoneOffsetMinutes(utc: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(utc)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - utc.getTime()) / 60_000);
}

const HHMM = /^(\d{1,2}):(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The comp-zone wall clock ("HH:MM") for a UTC time of day on the task
 * date, e.g. ("2026-02-07", "01:30", "Australia/Melbourne") → "12:30".
 * Returns null for malformed input or a zone the runtime doesn't know.
 */
export function utcToZonedHHMM(
  taskDate: string,
  hhmmUtc: string,
  timeZone: string
): string | null {
  if (!HHMM.test(hhmmUtc.trim())) return null;
  const utc = new Date(`${taskDate}T${hhmmUtc.trim()}:00Z`);
  if (Number.isNaN(utc.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).format(utc);
  } catch {
    return null;
  }
}

/**
 * The UTC time of day ("HH:MM") for a comp-zone wall clock on the task
 * date — the inverse of utcToZonedHHMM. The result may fall on the
 * previous/next UTC calendar day (Melbourne mornings are the previous UTC
 * evening); only the time of day is returned, which is all the xctsk
 * format stores. Runs the offset lookup twice so a wall time near a DST
 * transition converges on the offset actually in force. Storing a bare
 * time of day is inherently ambiguous in the small hours of a transition
 * day (the xctsk format's own limitation); daytime gates are exact.
 */
export function zonedToUtcHHMM(
  taskDate: string,
  hhmmZone: string,
  timeZone: string
): string | null {
  const m = HHMM.exec(hhmmZone.trim());
  if (!m) return null;
  const wallAsUtc = new Date(`${taskDate}T${pad2(Number(m[1]))}:${m[2]}:00Z`);
  if (Number.isNaN(wallAsUtc.getTime())) return null;
  try {
    let utc = new Date(
      wallAsUtc.getTime() - zoneOffsetMinutes(wallAsUtc, timeZone) * 60_000
    );
    utc = new Date(wallAsUtc.getTime() - zoneOffsetMinutes(utc, timeZone) * 60_000);
    return `${pad2(utc.getUTCHours())}:${pad2(utc.getUTCMinutes())}`;
  } catch {
    return null;
  }
}

/**
 * Short zone label for display next to times — "AEST", "GMT+11", or the
 * viewer's zone when `timeZone` is undefined. Computed at `refDate` so the
 * DST offset matches the comp date. Falls back to "local" when the zone is
 * unknown to the runtime.
 */
export function zoneAbbreviation(refDate: Date, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
      timeZone,
    }).formatToParts(refDate);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

/**
 * Wall-clock HH:MM:SS for an instant in the comp zone (or the viewer's
 * zone when undefined) — the narrative-time formatter for score details.
 * An unknown zone falls back to the viewer's rather than throwing.
 */
export function formatTimeInZone(d: Date, timeZone?: string): string {
  try {
    return d.toLocaleTimeString(undefined, { hour12: false, timeZone });
  } catch {
    return d.toLocaleTimeString(undefined, { hour12: false });
  }
}
