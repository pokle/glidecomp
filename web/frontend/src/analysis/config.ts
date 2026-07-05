/**
 * Configuration storage abstraction.
 *
 * localStorage is the synchronous read cache; cloud sync (when signed in)
 * is layered on top via auth/preferences-sync, which observes mutations
 * through schedulePush() and reconciles on startup via clearCache().
 */

import { resolveThresholds, DEFAULT_GAP_PARAMETERS, type DetectionThresholds, type PartialThresholds, type GAPParameters } from '@glidecomp/engine';
import { preferencesSync } from '../auth/preferences-sync';

export interface MapLocation {
  center: [lng: number, lat: number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface UserPreferences {
  units: UnitPreferences;
  thresholds?: PartialThresholds;
  theme?: 'light' | 'dark' | 'system';
  mapLocation?: MapLocation;
  mapStyle?: string;
  mapProvider?: 'mapbox' | 'leaflet';
  gapParameters?: Partial<GAPParameters>;
  /** Nominal distance as percentage of task distance (default 70). Stored separately
   *  from gapParameters.nominalDistance because it's resolved at scoring time. */
  nominalDistancePct?: number;
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
export type ClimbRateUnit = 'm/s' | 'ft/min' | 'knots';

const STORAGE_KEY = 'glidecomp:preferences';

const DEFAULT_PREFERENCES: UserPreferences = {
  units: {
    speed: 'km/h',
    altitude: 'm',
    distance: 'km',
    climbRate: 'm/s',
  },
};

/** Session-only scoring config seeded from a competition's GAP parameters. */
interface CompScoringSeed {
  gapParameters: Partial<GAPParameters>;
  nominalDistancePct: number;
}

class ConfigStore {
  private cache: UserPreferences | null = null;

  /** Active when a competition task is loaded: a what-if scoring layer that
   * the GAP getters/setters read and write instead of saved preferences.
   * Never persisted or cloud-synced, so comp links are deterministic (always
   * start from the comp's official configuration) and can't clobber the
   * viewer's own saved GAP settings. Holds the seed for reset. */
  private compScoring: (CompScoringSeed & { seed: CompScoringSeed }) | null = null;

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
      new CustomEvent('glidecomp:preferences-changed', {
        detail: merged,
      })
    );

    preferencesSync.schedulePush();
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
      climbRate: ['m/s', 'ft/min', 'knots'] as const,
    };

    const current = this.getUnits()[unitType];
    const opts = options[unitType];
    const currentIndex = opts.indexOf(current);
    const nextIndex = (currentIndex + 1) % opts.length;

    this.setUnit(unitType, opts[nextIndex] as UnitPreferences[typeof unitType]);
  }

  /**
   * Get saved map location, if any
   */
  getMapLocation(): MapLocation | undefined {
    return this.getPreferences().mapLocation;
  }

  /**
   * Save map location
   */
  setMapLocation(location: MapLocation): void {
    this.setPreferences({ mapLocation: location });
  }

  /**
   * Get resolved thresholds (defaults merged with user overrides)
   */
  getThresholds(): DetectionThresholds {
    return resolveThresholds(this.getPreferences().thresholds);
  }

  /**
   * Get partial thresholds (only user overrides, no defaults)
   */
  getPartialThresholds(): PartialThresholds | undefined {
    return this.getPreferences().thresholds;
  }

  /**
   * Set thresholds for a specific group
   */
  setThresholdGroup<K extends keyof DetectionThresholds>(
    group: K,
    values: Partial<DetectionThresholds[K]>
  ): void {
    const current = this.getPreferences().thresholds || {};
    this.setPreferences({
      thresholds: {
        ...current,
        [group]: { ...current[group], ...values },
      },
    });
  }

  /**
   * Reset a threshold group to defaults (remove user overrides)
   */
  resetThresholdGroup(group: keyof DetectionThresholds): void {
    const current = this.getPreferences().thresholds;
    if (!current) return;
    const updated = { ...current };
    delete updated[group];
    this.setPreferences({ thresholds: updated });
  }

  /**
   * Reset all thresholds to defaults
   */
  resetAllThresholds(): void {
    this.setPreferences({ thresholds: undefined });
  }

  /**
   * Enter competition scoring mode: a session-only what-if layer seeded from
   * a competition's GAP parameters. While active, the GAP getters/setters
   * read and write this layer (saved preferences are untouched) and
   * resetGAPParameters() restores the seed.
   */
  enterCompScoringMode(seed: CompScoringSeed): void {
    this.compScoring = {
      gapParameters: { ...seed.gapParameters },
      nominalDistancePct: seed.nominalDistancePct,
      seed: {
        gapParameters: { ...seed.gapParameters },
        nominalDistancePct: seed.nominalDistancePct,
      },
    };
  }

  /**
   * Whether a session-only competition scoring config is active
   */
  isCompScoringMode(): boolean {
    return this.compScoring !== null;
  }

  /**
   * Get GAP scoring parameters (defaults merged with the session comp config,
   * or with user overrides outside competition mode).
   * Note: nominalDistance here is the raw default/override — callers should
   * use getNominalDistancePct() and compute actual meters from task distance.
   */
  getGAPParameters(): GAPParameters {
    if (this.compScoring) {
      return { ...DEFAULT_GAP_PARAMETERS, ...this.compScoring.gapParameters };
    }
    return { ...DEFAULT_GAP_PARAMETERS, ...this.getPreferences().gapParameters };
  }

  /**
   * Set GAP scoring parameters (partial update supported)
   */
  setGAPParameters(params: Partial<GAPParameters>): void {
    if (this.compScoring) {
      this.compScoring.gapParameters = { ...this.compScoring.gapParameters, ...params };
      return;
    }
    const current = this.getPreferences().gapParameters || {};
    this.setPreferences({ gapParameters: { ...current, ...params } });
  }

  /**
   * Get nominal distance as a percentage of task distance (default 70)
   */
  getNominalDistancePct(): number {
    if (this.compScoring) return this.compScoring.nominalDistancePct;
    return this.getPreferences().nominalDistancePct ?? 70;
  }

  /**
   * Set nominal distance percentage
   */
  setNominalDistancePct(pct: number): void {
    if (this.compScoring) {
      this.compScoring.nominalDistancePct = pct;
      return;
    }
    this.setPreferences({ nominalDistancePct: pct });
  }

  /**
   * Reset GAP parameters — to the comp-seeded values in competition mode,
   * otherwise to the stock defaults (removing user overrides)
   */
  resetGAPParameters(): void {
    if (this.compScoring) {
      this.compScoring.gapParameters = { ...this.compScoring.seed.gapParameters };
      this.compScoring.nominalDistancePct = this.compScoring.seed.nominalDistancePct;
      return;
    }
    this.setPreferences({ gapParameters: undefined, nominalDistancePct: undefined });
  }

  /**
   * Clear cache (useful for testing)
   */
  clearCache(): void {
    this.cache = null;
  }
}

export const config = new ConfigStore();
