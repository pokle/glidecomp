/**
 * The one line of this-task fact each box on the contents page carries.
 *
 * They are strings rather than markup because that is all a box wants: a
 * reader is choosing between sections, and the fact is there to tell them
 * whether this one has anything in it for them. Every one of these used to be
 * a tile in the basis box at the top, where four readings sat together with
 * nothing to say which section each belonged to — the working band next to the
 * thermals it describes says more than either did in a row of tiles.
 *
 * Unit-aware at the edge, like everything else a reader reads: altitudes and
 * wind speeds arrive from the engine in metres and km/h and are converted
 * here against the viewer's preferences.
 */
import { formatTimeRange } from "@/react/lib/time";
import { formatAltitude, type UnitPreferences } from "@/react/lib/units";
import { windLabel } from "./charts/day-profile/shared";
import { unitDisplay } from "./units";
import type { FieldAnalysisBasis, MetricReport } from "./types";

/**
 * "37 pilots · 82h (13:05–18:40 AEDT)" — the size of the field and how much
 * flying the correlations rest on.
 *
 * Sub-10-hour totals keep a decimal: a thin day (7 pilots, 5.6 h) is exactly
 * when a reader needs to distrust what the section claims, and "6h" hides
 * that where "5.6h" does not.
 */
export function fieldFact(
  basis: FieldAnalysisBasis,
  timeZone: string | undefined
): string {
  const parts = [`${basis.pilotCount} pilots`];
  const seconds = basis.airtimeSplit?.airborneSeconds;
  const window = basis.analysisWindow;
  // Both halves are optional (a v12-or-earlier row, served while it
  // revalidates), so fall back to whichever half is there.
  if (seconds !== undefined) {
    const hours = seconds / 3600;
    const total = `${hours < 10 ? hours.toFixed(1) : hours.toFixed(0)}h`;
    parts.push(
      window ? `${total} (${formatTimeRange(window.from, window.to, timeZone)})` : total
    );
  } else if (window) {
    parts.push(formatTimeRange(window.from, window.to, timeZone));
  }
  return parts.join(" · ");
}

/**
 * "182 thermals, 51 shared by 2+ · 894–2,575 m" — how much lift the day gave
 * up, and the band it happened in.
 *
 * "51 of 182 multi-pilot" read as though 51 pilots were meant. The count of
 * thermals is the fact; how many had company in them is the qualifier.
 */
export function thermalsFact(
  basis: FieldAnalysisBasis,
  units: UnitPreferences
): string {
  const band =
    `${formatAltitude(basis.workingBandFloor, { prefs: units }).formatted}–` +
    `${formatAltitude(basis.workingBandCeiling, { prefs: units }).withUnit}` +
    (basis.workingBandFallback ? " (estimated)" : "");
  return (
    `${basis.sharedThermalCount} thermals, ` +
    `${basis.multiPilotThermalCount} shared by 2+ · ${band}`
  );
}

/**
 * "15 km/h NW" — the whole-task wind, in the same words the wind charts use.
 *
 * Null whenever no circle produced an estimate: on a task where nobody
 * thermalled there is no wind to report, and a box that said so anyway would
 * be reporting the absence of a measurement as a calm day.
 */
export function windFact(
  dayMetrics: MetricReport[],
  units: UnitPreferences
): string | null {
  const whole = dayMetrics
    .flatMap((m) => m.extraSeries ?? [])
    .find((s) => s.kind === "wind-hourly")?.wholeTask;
  if (!whole) return null;
  const wind = unitDisplay("km/h", units);
  return windLabel(whole.speedKmh * wind.factor, wind.unit, whole.directionDeg);
}
