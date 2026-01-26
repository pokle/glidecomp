# Configurable Units Specification

## Overview

This feature allows users to configure display units for various measurements in the IGC Analysis Tool. Each unit type can be configured independently (not grouped into presets like "metric" or "imperial"). User preferences are persisted to localStorage via a configuration abstraction layer that can be migrated to a backend database in the future.

## Unit Types

| Unit Type | Default | Options | Internal Unit |
|-----------|---------|---------|---------------|
| **Speed** | km/h | km/h, mph, knots | m/s |
| **Altitude** | m | m, ft | m |
| **Distance** | km | km, mi, nmi | m |
| **Climb Rate** | m/s | m/s, ft/min, 100ft/min, knots | m/s |

### Unit Details

#### Speed
- **km/h** - Kilometers per hour (1 m/s = 3.6 km/h)
- **mph** - Miles per hour (1 m/s = 2.237 mph)
- **knots** - Nautical miles per hour (1 m/s = 1.944 knots)

#### Altitude
- **m** - Meters
- **ft** - Feet (1 m = 3.281 ft)

#### Distance
- **km** - Kilometers (1 m = 0.001 km)
- **mi** - Statute miles (1 m = 0.000621371 mi)
- **nmi** - Nautical miles (1 m = 0.000539957 nmi)

#### Climb Rate
- **m/s** - Meters per second
- **ft/min** - Feet per minute (1 m/s = 196.85 ft/min)
- **100ft/min** - Hundreds of feet per minute (1 m/s = 1.9685 units) - common vario display
- **knots** - Nautical miles per hour (1 m/s = 1.944 knots) - convenient because 1 knot ≈ 100 ft/min ≈ 0.5 m/s

## User Interface

### Command Menu Integration

Add a new "Units" group to the command dialog (⌘K) after "Display Options":

```
─────────────────────────────────────
Units
─────────────────────────────────────
Speed Unit                      (km/h)
Altitude Unit                      (m)
Distance Unit                     (km)
Climb Rate Unit                  (m/s)
```

Each menu item:
- Shows current unit selection in parentheses (muted text)
- Clicking cycles to the next available unit option
- Closes the command dialog after selection
- Immediately updates all displayed values

### Keywords for Search

| Menu Item | Keywords |
|-----------|----------|
| Speed Unit | speed unit km/h mph knots velocity |
| Altitude Unit | altitude unit meters feet elevation height |
| Distance Unit | distance unit kilometers miles nautical |
| Climb Rate Unit | climb rate vario sink thermal ft/min m/s knots |

## Architecture

### File Structure

```
/pages/src/
├── analysis/
│   ├── config.ts        # Configuration abstraction layer (NEW)
│   ├── units.ts         # Unit conversion module (NEW)
│   ├── main.ts          # Wire up unit preferences
│   ├── event-panel.ts   # Update to use units module
│   ├── mapbox-provider.ts # Update to use units module
│   └── glide-speed.ts   # Update to use units module
```

### Configuration Layer (`config.ts`)

Abstraction over localStorage that can be migrated to a backend database.

```typescript
/**
 * Configuration storage abstraction.
 * Currently backed by localStorage, designed for future migration to backend API.
 */

export interface UserPreferences {
  units: UnitPreferences;
  theme?: 'light' | 'dark' | 'system';
  // Future preferences can be added here
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

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        this.cache = { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) };
      } else {
        this.cache = { ...DEFAULT_PREFERENCES };
      }
    } catch {
      this.cache = { ...DEFAULT_PREFERENCES };
    }

    return this.cache;
  }

  /**
   * Update user preferences (partial update supported)
   */
  setPreferences(updates: Partial<UserPreferences>): void {
    const current = this.getPreferences();
    const merged = {
      ...current,
      ...updates,
      units: { ...current.units, ...updates.units },
    };

    this.cache = merged;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));

    // Dispatch event for reactive updates
    window.dispatchEvent(new CustomEvent('taskscore:preferences-changed', {
      detail: merged
    }));
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
    this.setPreferences({
      units: { [unitType]: value } as Partial<UnitPreferences>
    });
  }

  /**
   * Cycle to next unit option for a given unit type
   */
  cycleUnit(unitType: keyof UnitPreferences): void {
    const options: Record<keyof UnitPreferences, string[]> = {
      speed: ['km/h', 'mph', 'knots'],
      altitude: ['m', 'ft'],
      distance: ['km', 'mi', 'nmi'],
      climbRate: ['m/s', 'ft/min', '100ft/min', 'knots'],
    };

    const current = this.getUnits()[unitType];
    const opts = options[unitType];
    const currentIndex = opts.indexOf(current);
    const nextIndex = (currentIndex + 1) % opts.length;

    this.setUnit(unitType, opts[nextIndex] as UnitPreferences[typeof unitType]);
  }
}

export const config = new ConfigStore();
```

### Units Module (`units.ts`)

```typescript
/**
 * Unit conversion and formatting module.
 * All internal values are in SI units (m, m/s).
 * This module handles conversion to display units.
 */

import { config, type UnitPreferences } from './config';

// Conversion factors from SI base units
const CONVERSIONS = {
  speed: {
    'km/h': { factor: 3.6, decimals: 0, label: 'km/h' },
    'mph': { factor: 2.237, decimals: 0, label: 'mph' },
    'knots': { factor: 1.944, decimals: 0, label: 'kts' },
  },
  altitude: {
    'm': { factor: 1, decimals: 0, label: 'm' },
    'ft': { factor: 3.281, decimals: 0, label: 'ft' },
  },
  distance: {
    'km': { factor: 0.001, decimals: 2, label: 'km' },
    'mi': { factor: 0.000621371, decimals: 2, label: 'mi' },
    'nmi': { factor: 0.000539957, decimals: 2, label: 'nmi' },
  },
  climbRate: {
    'm/s': { factor: 1, decimals: 1, label: 'm/s' },
    'ft/min': { factor: 196.85, decimals: 0, label: 'fpm' },
    '100ft/min': { factor: 1.9685, decimals: 1, label: '' },  // No label, just number
    'knots': { factor: 1.944, decimals: 1, label: 'kts' },
  },
} as const;

type UnitType = keyof typeof CONVERSIONS;

interface FormattedValue {
  value: number;
  formatted: string;    // e.g., "45"
  withUnit: string;     // e.g., "45km/h"
  unit: string;         // e.g., "km/h"
}

/**
 * Convert and format a value for display
 */
export function formatUnit(
  value: number,
  unitType: UnitType,
  options?: {
    unit?: string;           // Override unit preference
    decimals?: number;       // Override decimal places
    showSign?: boolean;      // Show +/- prefix
  }
): FormattedValue {
  const prefs = config.getUnits();
  const unitKey = options?.unit ?? prefs[unitType];
  const conv = CONVERSIONS[unitType][unitKey as keyof typeof CONVERSIONS[typeof unitType]];

  const converted = value * conv.factor;
  const decimals = options?.decimals ?? conv.decimals;
  const formatted = converted.toFixed(decimals);

  const sign = options?.showSign && converted > 0 ? '+' : '';
  const displayValue = sign + formatted;

  // For 100ft/min, just show the number (pilots know the context)
  const withUnit = conv.label
    ? `${displayValue}${conv.label}`
    : displayValue;

  return {
    value: converted,
    formatted: displayValue,
    withUnit,
    unit: conv.label || unitKey,
  };
}

// Convenience functions
export const formatSpeed = (mps: number, opts?: { showSign?: boolean }) =>
  formatUnit(mps, 'speed', opts);

export const formatAltitude = (m: number, opts?: { showSign?: boolean }) =>
  formatUnit(m, 'altitude', opts);

export const formatDistance = (m: number, opts?: { decimals?: number }) =>
  formatUnit(m, 'distance', opts);

export const formatClimbRate = (mps: number, opts?: { showSign?: boolean }) =>
  formatUnit(mps, 'climbRate', { ...opts, showSign: opts?.showSign ?? true });

/**
 * Get the current unit label for a unit type
 */
export function getUnitLabel(unitType: UnitType): string {
  const prefs = config.getUnits();
  const unitKey = prefs[unitType];
  return CONVERSIONS[unitType][unitKey as keyof typeof CONVERSIONS[typeof unitType]].label || unitKey;
}

/**
 * Subscribe to unit preference changes
 */
export function onUnitsChanged(callback: (units: UnitPreferences) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    callback(detail.units);
  };

  window.addEventListener('taskscore:preferences-changed', handler);
  return () => window.removeEventListener('taskscore:preferences-changed', handler);
}
```

## Display Updates

### Locations Requiring Updates

1. **event-panel.ts** - Event list display
   - Glide speed: `speedKmh` → `formatSpeed(speed).withUnit`
   - Altitude values: `${altitude.toFixed(0)}m` → `formatAltitude(altitude).withUnit`
   - Distance values: `${(distance/1000).toFixed(2)} km` → `formatDistance(distance).withUnit`
   - Climb/sink rates: `+${rate.toFixed(1)} m/s` → `formatClimbRate(rate).withUnit`

2. **mapbox-provider.ts** - Map labels
   - Turnpoint labels: radius display
   - Glide segment markers: speed and altitude change

3. **glide-speed.ts** - Glide visualization
   - Speed labels on chevron markers
   - Altitude change labels

4. **main.ts** - Task distance display
   - Optimized distance: `${(distance/1000).toFixed(2)} km` → `formatDistance(distance).withUnit`

### Reactive Updates

When units change via the command menu:
1. `config.setUnit()` dispatches `taskscore:preferences-changed` event
2. Components listening via `onUnitsChanged()` re-render affected displays
3. No page reload required

## Command Menu HTML

Add to `analysis.html` after the Display Options separator:

```html
<hr role="separator">

<!-- Units -->
<div role="group" aria-labelledby="units-heading">
    <div role="heading" id="units-heading">Units</div>
    <div role="menuitem" id="menu-unit-speed" data-keywords="speed unit km/h mph knots velocity">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 17H5c-1.1 0-2-.9-2-2V7c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2z"/>
            <path d="M12 17v4"/>
            <path d="M8 21h8"/>
        </svg>
        <span>Speed Unit</span>
        <span class="text-muted-foreground" id="unit-speed-status">(km/h)</span>
    </div>
    <div role="menuitem" id="menu-unit-altitude" data-keywords="altitude unit meters feet elevation height">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
        </svg>
        <span>Altitude Unit</span>
        <span class="text-muted-foreground" id="unit-altitude-status">(m)</span>
    </div>
    <div role="menuitem" id="menu-unit-distance" data-keywords="distance unit kilometers miles nautical">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h13l4-3.5L18 6z"/>
            <path d="M12 13v8"/>
            <path d="M12 3v3"/>
        </svg>
        <span>Distance Unit</span>
        <span class="text-muted-foreground" id="unit-distance-status">(km)</span>
    </div>
    <div role="menuitem" id="menu-unit-climbrate" data-keywords="climb rate vario sink thermal ft/min m/s knots">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V5"/>
            <path d="M5 12l7-7 7 7"/>
        </svg>
        <span>Climb Rate Unit</span>
        <span class="text-muted-foreground" id="unit-climbrate-status">(m/s)</span>
    </div>
</div>
```

## Migration Path to Backend

The `ConfigStore` class is designed for future migration:

1. **Phase 1 (current)**: localStorage only
2. **Phase 2**: Add optional backend sync
   - On load: fetch from API, fallback to localStorage
   - On save: write to both API and localStorage
   - Offline support via localStorage cache
3. **Phase 3**: Full backend with user accounts
   - Replace localStorage calls with API calls
   - Keep localStorage as offline cache only

The interface remains unchanged for consuming code.

## Testing

### Unit Tests

- `units.ts`: Verify conversion accuracy for all unit combinations
- `config.ts`: Verify storage/retrieval, defaults, cycling

### Manual Testing

1. Open command menu (⌘K)
2. Search "units" - verify all 4 unit options appear
3. Click each unit type - verify it cycles through options
4. Verify status text updates immediately
5. Verify all displayed values update (event panel, map labels)
6. Reload page - verify preferences persist
7. Clear localStorage - verify defaults restored

## Implementation Order

1. Create `config.ts` with storage abstraction
2. Create `units.ts` with conversion functions
3. Add unit menu items to `analysis.html`
4. Wire up menu handlers in `main.ts`
5. Update `event-panel.ts` to use `formatUnit()`
6. Update `mapbox-provider.ts` to use `formatUnit()`
7. Update `glide-speed.ts` to use `formatUnit()`
8. Update `main.ts` task distance display
9. Add reactive update listeners
10. Write tests
