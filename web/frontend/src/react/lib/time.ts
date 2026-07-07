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
 * Zone label for display next to times: the IANA name plus its UTC offset
 * at `refDate` — "Australia/Melbourne (GMT+11)" — so the DST offset matches
 * the comp date. Uses the viewer's zone when `timeZone` is undefined. Falls
 * back to the bare name (or "local") when the zone is unknown to the runtime.
 */
export function zoneNameWithOffset(refDate: Date, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZoneName: "shortOffset",
      timeZone,
    }).formatToParts(refDate);
    const offset = parts.find((p) => p.type === "timeZoneName")?.value;
    const name = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return offset ? `${name} (${offset})` : name;
  } catch {
    return timeZone ?? "local";
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

// A "GMT+10" / "UTC-7" / "GMT+5:30" style numeric offset — i.e. `short` gave
// us no real abbreviation for the zone, just the offset back again.
const NUMERIC_OFFSET = /^(?:GMT|UTC)[+-]\d/;
// A bare zero offset: "GMT", "UTC", "GMT+0", "GMT+00:00".
const ZERO_OFFSET = /^(?:GMT|UTC)(?:[+-]0(?::00)?)?$/;
// Locales probed (in order) for a named abbreviation. No single locale names
// every zone — en-AU knows AEST/AEDT/ACST/AWST, en-US knows PST/EDT/…, en-GB
// knows BST/GMT — so we take the first that yields a name rather than an
// offset, which surfaces the abbreviation regardless of the viewer's own
// locale. Kept to English to stay consistent with the rest of the app.
const ABBR_LOCALES = ["en-AU", "en-US", "en-GB"];

/** The `timeZoneName` token for `date` in a given locale/style, or null. */
function zoneToken(
  date: Date,
  timeZone: string | undefined,
  locale: string,
  style: "short" | "shortOffset"
): string | null {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? null
    );
  } catch {
    return null;
  }
}

/**
 * A human zone label for `date` in `timeZone` (viewer-local when undefined):
 * the abbreviated name plus its numeric offset when both are available —
 * "AEST (GMT+10)", "PDT (GMT-7)" — or just the offset when the zone has no
 * named abbreviation ("GMT+5:30"), or "UTC" for zero offset. The offset is
 * resolved for `date` itself so DST is the one in force on the day.
 */
export function zoneLabel(date: Date, timeZone: string | undefined): string {
  const offset = zoneToken(date, timeZone, "en-GB", "shortOffset");
  let abbr: string | null = null;
  for (const loc of ABBR_LOCALES) {
    const s = zoneToken(date, timeZone, loc, "short");
    if (s && !NUMERIC_OFFSET.test(s)) {
      abbr = s;
      break;
    }
  }
  const zero = !offset || ZERO_OFFSET.test(offset);
  if (abbr) {
    // Named zone (AEST/PDT/BST/UTC/GMT…). Pair it with the numeric offset
    // unless that would be redundant (identical strings, or UTC/GMT at +0).
    if (!offset || abbr === offset || ((abbr === "UTC" || abbr === "GMT") && zero)) {
      return abbr;
    }
    return `${abbr} (${offset})`;
  }
  // No named abbreviation in our locales: show the offset, rendering a bare
  // zero as the familiar "UTC".
  return zero ? "UTC" : (offset as string);
}

/**
 * Absolute timestamp for `date` in `timeZone` (viewer-local when undefined)
 * with a fixed en-GB, 24-hour date/time and a {@link zoneLabel} — e.g.
 * "8 Jul 2026, 00:32 AEST (GMT+10)". Always absolute (never a relative
 * "2 min ago"); the en-GB date shape keeps the look consistent for every
 * viewer while the zone adapts.
 */
export function formatInstant(date: Date, timeZone: string | undefined): string {
  const dateTime = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${dateTime} ${zoneLabel(date, timeZone)}`;
}

/** True when the runtime recognises `tz` as an IANA zone. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One selectable rendering of an instant, used by the Timestamp component. */
export interface ZoneChoice {
  kind: "comp" | "local" | "utc";
  /** Human description of the zone for tooltips/aria. */
  kindLabel: string;
  timeZone: string | undefined;
  /** The fully rendered timestamp in this zone. */
  text: string;
}

const KIND_LABELS: Record<ZoneChoice["kind"], string> = {
  comp: "competition time zone",
  local: "your local time zone",
  utc: "UTC",
};

/**
 * The time-zone choices a Timestamp cycles through for `date`: the competition
 * zone (when the instant relates to a comp and the zone is valid), the
 * viewer's own local zone, then UTC — de-duplicated by what they actually
 * render, so a viewer already in the comp zone never sees the same value
 * twice. The first choice is the default shown (comp when present, else the
 * viewer's local zone). Empty when `date` is invalid.
 */
export function buildZoneCycle(date: Date, compTimezone: string | null): ZoneChoice[] {
  if (Number.isNaN(date.getTime())) return [];
  const candidates: Array<Pick<ZoneChoice, "kind" | "timeZone">> = [];
  if (compTimezone && isValidTimeZone(compTimezone)) {
    candidates.push({ kind: "comp", timeZone: compTimezone });
  }
  candidates.push({ kind: "local", timeZone: undefined });
  candidates.push({ kind: "utc", timeZone: "UTC" });

  const seen = new Set<string>();
  const choices: ZoneChoice[] = [];
  for (const { kind, timeZone } of candidates) {
    const text = formatInstant(date, timeZone);
    if (seen.has(text)) continue;
    seen.add(text);
    choices.push({ kind, kindLabel: KIND_LABELS[kind], timeZone, text });
  }
  return choices;
}
