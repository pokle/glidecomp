// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Time-of-day formatting for the CLI's plain-text field-analysis report.
 *
 * The metrics emit times as machine-readable instants (ReportCell `{ t: ISO }`)
 * and never bake a zone; the CLI renderer (report.ts) formats them here in the
 * zone it was given (the task's local zone, derived from its location — see
 * cli/score-task.ts). The web UI formats the same instants with `comp.timezone`
 * on the frontend instead. When no zone is given the output is UTC.
 *
 * DOM-free and Intl-only, so it is safe in the engine (no `@glidecomp/engine/
 * timezone` / tz-lookup dependency — the zone STRING is resolved upstream and
 * passed in; here we only format with it).
 *
 * The zone-token logic mirrors `web/frontend/src/react/lib/time.ts`
 * (`zoneLabel`); it is duplicated rather than shared because the engine and
 * the frontend are separate packages and this must stay tz-lookup-free.
 */

// "GMT+10" / "UTC-7" / "GMT+5:30" — a numeric offset, i.e. `short` gave us no
// real abbreviation, just the offset back.
const NUMERIC_OFFSET = /^(?:GMT|UTC)[+-]\d/;
// A bare zero offset: "GMT", "UTC", "GMT+0", "GMT+00:00".
const ZERO_OFFSET = /^(?:GMT|UTC)(?:[+-]0(?::00)?)?$/;
// Probed in order for a named abbreviation — no single locale names every
// zone (en-AU knows AEST/AEDT, en-US knows PST/EDT, en-GB knows BST/GMT).
const ABBR_LOCALES = ['en-AU', 'en-US', 'en-GB'];

/** The `timeZoneName` token for `date` in a locale/style, or null. */
function zoneNameToken(
  date: Date,
  timeZone: string,
  locale: string,
  style: 'short' | 'shortOffset',
): string | null {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style })
        .formatToParts(date)
        .find((p) => p.type === 'timeZoneName')?.value ?? null
    );
  } catch {
    return null;
  }
}

/**
 * A compact zone token for an instant: the abbreviated name when the runtime
 * knows one ("AEDT", "PST", "UTC"), else the numeric offset ("GMT+5:30"),
 * else "UTC" for a bare zero offset. `timeZone` undefined → "UTC". Resolved
 * for `refMs` itself so DST is the one in force on the day.
 */
export function zoneToken(refMs: number, timeZone?: string): string {
  const tz = timeZone ?? 'UTC';
  const date = new Date(refMs);
  const offset = zoneNameToken(date, tz, 'en-GB', 'shortOffset');
  for (const loc of ABBR_LOCALES) {
    const s = zoneNameToken(date, tz, loc, 'short');
    if (s && !NUMERIC_OFFSET.test(s)) return s;
  }
  return !offset || ZERO_OFFSET.test(offset) ? 'UTC' : offset;
}

/**
 * "HH:MM" wall clock for an instant in `timeZone` (UTC when undefined),
 * 24-hour, zero-padded — e.g. (…, "Australia/Melbourne") → "14:00". Falls
 * back to UTC for a zone the runtime doesn't know.
 */
export function hhmmInZone(tMs: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone ?? 'UTC',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(tMs));
  } catch {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(tMs));
  }
}

/**
 * A time-of-day label: the instant's wall clock in the zone plus the zone
 * token — "14:00 AEDT", or "13:00 UTC" when no zone is given. Used by the CLI
 * renderer for every `{ t }` report cell (hour buckets and takeoff clocks
 * alike).
 */
export function timeWithZone(tMs: number, timeZone?: string): string {
  return `${hhmmInZone(tMs, timeZone)} ${zoneToken(tMs, timeZone)}`;
}

/**
 * A time-of-day range with a single trailing zone token — "13:05–14:30 AEDT"
 * (or "…–… UTC" with no zone). Both ends share the token; the zone is resolved
 * for the end instant so DST is the one in force.
 */
export function timeRangeWithZone(fromMs: number, toMs: number, timeZone?: string): string {
  return `${hhmmInZone(fromMs, timeZone)}–${hhmmInZone(toMs, timeZone)} ${zoneToken(toMs, timeZone)}`;
}
