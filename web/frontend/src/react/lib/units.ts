/**
 * React access to the user's preferred display units.
 *
 * The store is the same one the analysis page and 3D replay use — the
 * `glidecomp:preferences` localStorage blob owned by analysis/config, which
 * cloud-syncs to the account (auth-api /api/auth/preferences) when signed in.
 * Changing units anywhere (Settings, the replay's Units menu, the analysis
 * page) updates every subscriber via the `glidecomp:preferences-changed`
 * event, including across tabs.
 *
 * SSR: the server snapshot is always DEFAULT_UNITS (metric), so the eight
 * SSR'd comp pages render deterministically; a signed-in visitor with other
 * units gets a repaint right after hydration.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_UNITS, TO_SI, formatCylinderRadius, type UnitPreferences } from "@glidecomp/engine";
import { config } from "../../analysis/config";

export {
  formatSpeed,
  formatAltitude,
  formatAltitudeChange,
  formatDistance,
  formatClimbRate,
  formatCylinderRadius,
  formatRadius,
  getUnitLabel,
  DEFAULT_UNITS,
  type UnitPreferences,
  type FormattedValue,
} from "@glidecomp/engine";

function subscribe(callback: () => void): () => void {
  window.addEventListener("glidecomp:preferences-changed", callback);
  return () =>
    window.removeEventListener("glidecomp:preferences-changed", callback);
}

// config caches the preferences object, so the snapshot is referentially
// stable until a write (or cross-tab sync) replaces it — exactly what
// useSyncExternalStore needs to avoid render loops.
function getSnapshot(): UnitPreferences {
  return config.getUnits();
}

function getServerSnapshot(): UnitPreferences {
  return DEFAULT_UNITS;
}

/** The current unit preferences, re-rendering on any change. */
export function useUnits(): UnitPreferences {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Persist one unit preference (localStorage + cloud sync when signed in). */
export function setUnit<K extends keyof UnitPreferences>(
  unitType: K,
  value: UnitPreferences[K]
): void {
  config.setUnit(unitType, value);
}

// ── Pure helpers for typed and listed lengths ─────────────────────────────

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
