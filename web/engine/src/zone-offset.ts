/**
 * Zone-aware date machinery, built on Intl only — deliberately: the engine
 * must not pull in a tz-lookup database (see the note in
 * field-analysis/format-time.ts).
 */

const DAY_MS = 86_400_000;

/**
 * UTC offset of an IANA time zone at a given instant.
 *
 * Derived by formatting the instant in the target zone with
 * `Intl.DateTimeFormat.formatToParts` and reading the wall-clock fields back
 * as if they were UTC: the difference between that reconstruction and the
 * instant itself IS the zone's offset. This is the robust way to ask the
 * question in pure JavaScript — the tempting alternative,
 * `new Date(date.toLocaleString('en-US', { timeZone }))`, hands a
 * locale-formatted string back to `Date.parse`, which is never promised to
 * understand it and quietly differs between runtimes.
 *
 * Handles daylight saving correctly because it asks about a specific
 * instant, not a date: either side of a transition simply reads different
 * wall-clock fields.
 */
export function zoneOffsetMs(atMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(atMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    // Some ICU builds render midnight as "24" under hour12: false.
    parts.hour === 24 ? 0 : parts.hour,
    parts.minute,
    parts.second
  );
  // Compare at whole-second precision: the formatter carries no milliseconds,
  // so flooring the instant keeps sub-second inputs from skewing the offset.
  return asUTC - Math.floor(atMs / 1000) * 1000;
}

/**
 * Epoch ms of local midnight starting `dateISO` ("YYYY-MM-DD") in `timeZone`,
 * or the UTC midnight when the zone is null or unknown to the runtime.
 *
 * Guess the instant as if the zone were UTC, read the zone's ACTUAL offset
 * at that guess via {@link zoneOffsetMs}, correct, then re-probe once — the
 * second pass fixes the ±1 h error when the first guess lands on the far
 * side of a DST transition.
 */
export function zonedDayStartMs(dateISO: string, timeZone: string | null): number | null {
  const utcGuess = Date.parse(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(utcGuess)) return null;
  if (timeZone === null) return utcGuess;
  try {
    let ms = utcGuess;
    for (let pass = 0; pass < 2; pass++) {
      const offset = zoneOffsetMs(ms, timeZone);
      const corrected = utcGuess - offset;
      if (corrected === ms) return ms;
      ms = corrected;
    }
    return ms;
  } catch {
    return utcGuess;
  }
}

/** The ISO date ("YYYY-MM-DD") of the calendar day after `dateISO`. */
export function nextDayISO(dateISO: string): string {
  const ms = Date.parse(`${dateISO}T00:00:00Z`);
  return new Date(ms + DAY_MS).toISOString().slice(0, 10);
}
