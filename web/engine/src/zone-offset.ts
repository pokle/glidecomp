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
