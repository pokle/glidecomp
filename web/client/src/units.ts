/**
 * Pure unit helpers shared by the website and the app. The formatters
 * themselves live in the engine (`formatAltitude`, `formatCylinderRadius`, …);
 * how a preference is STORED differs per client (localStorage on the website,
 * the app's own store), so that stays with each.
 */
import { TO_SI, formatCylinderRadius, type UnitPreferences } from "@glidecomp/engine";

/**
 * A cylinder radius as a list row writes it: "400 m", "5 km".
 *
 * Takes what a form field holds (a string) and gives back whatever it was
 * handed when that is not a number, so a half-typed radius shows as typed
 * rather than as NaN. Metric whatever the reader prefers, like
 * {@link formatCylinderRadius} it wraps and for the same reason: a cylinder
 * radius is the task's own number, stated in metres by the FAI, the `.xctsk`
 * and the briefing alike (see the altitude rule in CLAUDE.md).
 */
export function radiusLabel(radius: string): string {
  const n = Number(radius);
  return Number.isFinite(n) ? formatCylinderRadius(n).withUnit : radius;
}

/**
 * The two directions an altitude *input* needs.
 *
 * Everything stored is metres — the xctsk files, the waypoint records, the
 * engine — but a reader whose preference is feet reads feet everywhere the app
 * PRINTS an altitude. An input hard-labelled "(m)" left them converting in
 * their head, and the number they typed came back multiplied by 3.28 in the
 * turnpoint list beside it (issue #662). So the input speaks their unit too,
 * and these convert at its edge; nothing behind it changes.
 *
 * Both round to a whole unit, matching how altitudes are stored (whole metres,
 * from files and from the terrain DEM). The round trip is stable in both
 * directions — a foot is finer than a metre, so metres → feet → metres always
 * lands back on the same metre, and an untouched value can never drift.
 *
 * NaN passes through: it is how a blank altitude is spelled in these fields.
 */
export function toAltitudeInput(metres: number, prefs: UnitPreferences): number {
  if (!Number.isFinite(metres)) return NaN;
  return prefs.altitude === "ft" ? Math.round(metres / TO_SI.ft) : Math.round(metres);
}

/** Metres from a value typed in the reader's altitude unit. */
export function fromAltitudeInput(value: number, prefs: UnitPreferences): number {
  if (!Number.isFinite(value)) return NaN;
  return prefs.altitude === "ft" ? Math.round(value * TO_SI.ft) : Math.round(value);
}

/**
 * Display conversion for one engine metric unit under the viewer's preferred
 * units. The engine always computes and stores metric units; the UI converts
 * numbers at the display boundary. Horizontal speeds ('km/h') follow the
 * speed preference, vertical rates ('m/s') the climb preference, heights
 * ('m') the altitude preference, ground distances ('km') the distance
 * preference; everything else ('pct', 's', 'min', …) is dimensionless or time
 * and passes through.
 *
 * Every factor is derived from the engine's canonical TO_SI table, so a value
 * displayed here can never disagree with the same value formatted by the
 * engine's own formatUnit.
 */
export interface UnitDisplay {
  /** Display token in the metric-unit vocabulary ('mph', 'kts', 'fpm', 'ft',
   * or the engine unit itself when no conversion applies). */
  unit: string;
  /** Multiply an engine-unit value by this to get the display value. */
  factor: number;
}

export function unitDisplay(engineUnit: string, units: UnitPreferences): UnitDisplay {
  switch (engineUnit) {
    case "km/h":
      if (units.speed === "mph") return { unit: "mph", factor: TO_SI["km/h"] / TO_SI.mph };
      if (units.speed === "knots") return { unit: "kts", factor: TO_SI["km/h"] / TO_SI.knots };
      return { unit: "km/h", factor: 1 };
    case "m/s":
      if (units.climbRate === "ft/min") return { unit: "fpm", factor: 1 / TO_SI["ft/min"] };
      if (units.climbRate === "knots") return { unit: "kts", factor: 1 / TO_SI.knots };
      return { unit: "m/s", factor: 1 };
    case "m":
      if (units.altitude === "ft") return { unit: "ft", factor: 1 / TO_SI.ft };
      return { unit: "m", factor: 1 };
    case "km":
      if (units.distance === "mi") return { unit: "mi", factor: 1000 / TO_SI.mi };
      if (units.distance === "nmi") return { unit: "nmi", factor: 1000 / TO_SI.nmi };
      return { unit: "km", factor: 1 };
    default:
      return { unit: engineUnit, factor: 1 };
  }
}
