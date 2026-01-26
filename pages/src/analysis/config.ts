/**
 * Configuration storage abstraction.
 * Currently backed by localStorage, designed for future migration to backend API.
 */

export interface UserPreferences {
  units: UnitPreferences;
  theme?: 'light' | 'dark' | 'system';
}

export interface UnitPreferences {
  speed: SpeedUnit;
  altitude: AltitudeUnit;
  distance: DistanceUnit;
  climbRate: ClimbRateUnit;
}

export type SpeedUnit = 'km/h' | 'mph' | 'knots';
export type AltitudeUnit = 'm' | 'ft';
export type DistanceUnit = 'km' | 'mi' | 'nmi';
export type ClimbRateUnit = 'm/s' | 'ft/min' | '100ft/min' | 'knots';

const STORAGE_KEY = 'taskscore:preferences';

const DEFAULT_PREFERENCES: UserPreferences = {
  units: {
    speed: 'km/h',
    altitude: 'm',
    distance: 'km',
    climbRate: 'm/s',
  },
};

class ConfigStore {
  private cache: UserPreferences | null = null;

  /**
   * Get all user preferences
   */
  getPreferences(): UserPreferences {
    if (this.cache) return this.cache;

    let prefs: UserPreferences;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        prefs = {
          ...DEFAULT_PREFERENCES,
          ...parsed,
          units: { ...DEFAULT_PREFERENCES.units, ...parsed.units },
        };
      } else {
        prefs = { ...DEFAULT_PREFERENCES };
      }
    } catch {
      prefs = { ...DEFAULT_PREFERENCES };
    }

    this.cache = prefs;
    return prefs;
  }

  /**
   * Update user preferences (partial update supported)
   */
  setPreferences(updates: Partial<UserPreferences>): void {
    const current = this.getPreferences();
    const merged: UserPreferences = {
      ...current,
      ...updates,
      units: { ...current.units, ...updates.units },
    };

    this.cache = merged;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

    // Dispatch event for reactive updates
    window.dispatchEvent(
      new CustomEvent('taskscore:preferences-changed', {
        detail: merged,
      })
    );
  }

  /**
   * Get unit preferences
   */
  getUnits(): UnitPreferences {
    return this.getPreferences().units;
  }

  /**
   * Update a single unit preference
   */
  setUnit<K extends keyof UnitPreferences>(
    unitType: K,
    value: UnitPreferences[K]
  ): void {
    const current = this.getUnits();
    this.setPreferences({
      units: { ...current, [unitType]: value },
    });
  }

  /**
   * Cycle to next unit option for a given unit type
   */
  cycleUnit(unitType: keyof UnitPreferences): void {
    const options: Record<keyof UnitPreferences, readonly string[]> = {
      speed: ['km/h', 'mph', 'knots'] as const,
      altitude: ['m', 'ft'] as const,
      distance: ['km', 'mi', 'nmi'] as const,
      climbRate: ['m/s', 'ft/min', '100ft/min', 'knots'] as const,
    };

    const current = this.getUnits()[unitType];
    const opts = options[unitType];
    const currentIndex = opts.indexOf(current);
    const nextIndex = (currentIndex + 1) % opts.length;

    this.setUnit(unitType, opts[nextIndex] as UnitPreferences[typeof unitType]);
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cache = null;
  }
}

export const config = new ConfigStore();
