# Configurable Units Specification

## Overview

This feature allows users to configure display units for various measurements in the IGC Analysis Tool. Each unit type can be configured independently (not grouped into presets like "metric" or "imperial"). User preferences are persisted to localStorage via a configuration abstraction layer that can be migrated to a backend database in the future.

## Unit Types

| Unit Type | Default | Options | Internal Unit |
|-----------|---------|---------|---------------|
| **Speed** | km/h | km/h, mph, knots | m/s |
| **Altitude** | m | m, ft | m |
| **Distance** | km | km, mi, nmi | m |
| **Climb Rate** | m/s | m/s, ft/min, knots | m/s |

### Unit Details

#### Speed
- **km/h** - Kilometers per hour (1 m/s = 3.6 km/h)
- **mph** - Miles per hour (1 m/s = 2.237 mph)
- **knots** - Nautical miles per hour (1 m/s = 1.944 knots, label: "kts")

#### Altitude
- **m** - Meters
- **ft** - Feet (1 m = 3.281 ft)

#### Distance
- **km** - Kilometers (1 m = 0.001 km)
- **mi** - Statute miles (1 m = 0.000621371 mi)
- **nmi** - Nautical miles (1 m = 0.000539957 nmi, label: "NM")

#### Climb Rate
- **m/s** - Meters per second
- **ft/min** - Feet per minute (1 m/s = 196.85 ft/min, label: "fpm")
- **knots** - Nautical miles per hour (1 m/s = 1.944 knots, label: "kts")

## User Interface

### Command Menu Integration

A "Configure units..." menu item is available under the "Settings" group in the command dialog (Cmd+K):

```
─────────────────────────────────────
Settings
─────────────────────────────────────
⚙  Configure units...
```

Keywords for search: `units configure settings speed altitude distance climb rate vario`

### Units Configuration Dialog

Clicking "Configure units..." opens a modal dialog with dropdown selects for each unit type:

- **Speed**: km/h, mph, knots
- **Altitude**: meters (m), feet (ft)
- **Distance**: kilometers (km), miles (mi), nautical miles (nmi)
- **Climb Rate**: m/s, ft/min, knots

The dialog has a "Save" button that applies all changes at once.

### Reactive Updates

When units are changed:

1. Flight events are **re-detected** to regenerate descriptions with the new units
2. Event panel is re-rendered with updated values
3. Map event markers are re-rendered
4. Task labels (leg distances, turnpoint radius/altitude) are re-rendered
5. Flight info header (max altitude) is updated
6. **No page refresh required** - all updates happen immediately

## Architecture

### File Structure

```
/web/engine/src/
├── units.ts              # Unit conversion and formatting module
├── event-detector.ts     # Uses units module for event descriptions
└── glide-speed.ts        # Provides speed in m/s for formatting at display layer

/web/frontend/src/analysis/
├── config.ts             # Configuration storage abstraction
├── units-browser.ts      # Browser-side unit formatting helpers
├── main.ts               # Wire up unit preferences and reactive updates
├── analysis-panel.ts     # Uses units module for display
└── mapbox-provider.ts    # Uses units module for map labels
```

### Configuration Layer (`config.ts`)

The `ConfigStore` class provides an abstraction over localStorage:

**Key Features:**
- Stores preferences under `taskscore:preferences` localStorage key
- Provides `getPreferences()`, `setPreferences()`, `getUnits()`, `setUnit()` methods
- Dispatches `taskscore:preferences-changed` custom event when preferences change
- Designed for future migration to backend API (same interface)

**Types:**
```typescript
export type SpeedUnit = 'km/h' | 'mph' | 'knots';
export type AltitudeUnit = 'm' | 'ft';
export type DistanceUnit = 'km' | 'mi' | 'nmi';
export type ClimbRateUnit = 'm/s' | 'ft/min' | 'knots';

export interface UnitPreferences {
  speed: SpeedUnit;
  altitude: AltitudeUnit;
  distance: DistanceUnit;
  climbRate: ClimbRateUnit;
}
```

### Units Module (`units.ts`)

Provides conversion and formatting functions:

**Core Functions:**
- `formatUnit(value, unitType, options)` - Convert and format any value
- `formatSpeed(mps)` - Format speed from m/s
- `formatAltitude(m)` - Format altitude from meters
- `formatDistance(m)` - Format distance from meters
- `formatClimbRate(mps)` - Format climb rate from m/s (shows + sign by default)
- `formatAltitudeChange(m)` - Format altitude change (always shows sign)
- `formatRadius(m)` - Format turnpoint radius with appropriate precision
- `onUnitsChanged(callback)` - Subscribe to unit preference changes

**FormattedValue Interface:**
```typescript
interface FormattedValue {
  value: number;      // Converted numeric value
  formatted: string;  // Formatted string without unit (e.g., "45")
  withUnit: string;   // Formatted string with unit (e.g., "45km/h")
  unit: string;       // Unit label (e.g., "km/h")
}
```

## Display Locations

Units are applied in the following locations:

### Event Panel
- Glide speed and L/D ratio
- Altitude values (start/end, gain/loss)
- Distance values
- Climb/sink rates

### Map Labels
- Task leg distances (e.g., "Leg 1: 15.2km")
- Turnpoint radius (e.g., "R 5km")
- Turnpoint altitude (e.g., "A 3067m")
- Glide segment speed labels
- Glide segment altitude change labels

### Event Descriptions
- Max/min altitude (e.g., "Max altitude: 2767m")
- Max climb/sink (e.g., "Max climb: +3.2m/s")
- Thermal entry (e.g., "Thermal entry (+2.4m/s avg)")
- Thermal exit (e.g., "Thermal exit (+178m gained)")
- Glide end (e.g., "Glide end (5.2km)")

### Flight Info Header
- Max altitude display

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

### Manual Testing Checklist

1. Open command menu (Cmd+K)
2. Search "units" - verify "Configure units..." appears
3. Open the units dialog
4. Change each unit type and click Save
5. Verify all displayed values update immediately:
   - Event panel entries
   - Flight info header
   - Map leg distance labels
   - Map turnpoint labels
   - Glide markers (when a glide is selected)
6. Reload page - verify preferences persist
7. Clear localStorage - verify defaults restored
