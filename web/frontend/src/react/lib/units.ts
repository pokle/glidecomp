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
import { DEFAULT_UNITS, type UnitPreferences } from "@glidecomp/engine";
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
// The pure helpers moved to @glidecomp/client, shared with the app (mobile
// plan, stage 2); re-exported so the website's imports do not change.
export { radiusLabel, toAltitudeInput, fromAltitudeInput } from "@glidecomp/client/units";

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
