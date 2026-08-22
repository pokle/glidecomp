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
import { DEFAULT_UNITS, TO_SI, type UnitPreferences } from "@glidecomp/engine";
import { config } from "../../analysis/config";

export {
  formatSpeed,
  formatAltitude,
  formatAltitudeChange,
  formatDistance,
  formatClimbRate,
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
