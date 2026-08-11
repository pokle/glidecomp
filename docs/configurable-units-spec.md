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

A "Settings..." menu item (`menu-configure-settings`) is available under the "Settings" group in the command dialog (Cmd+K):

```
─────────────────────────────────────
Settings
─────────────────────────────────────
🏆  Competition Settings...
⚙  Settings...
```

Keywords for search: `units configure settings speed altitude distance climb rate vario thresholds detection thermal glide circle`

The neighbouring "Competition Settings..." item (`menu-competition-settings`) is a separate dialog for the GAP scoring parameters — nothing to do with display units.

### Settings Dialog

Clicking "Settings..." opens the `#settings-dialog` modal. Units are one collapsible section of it; the same dialog also carries the event-detection thresholds (Thermal Detection, Glide Detection, Vario Extremes, Takeoff / Landing, Circle Detection). The Units section has a dropdown select for each unit type:

- **Speed**: km/h, mph, knots
- **Altitude**: meters (m), feet (ft)
- **Distance**: kilometers (km), miles (mi), nautical miles (nmi)
- **Climb Rate**: m/s, ft/min, knots

The Units section header also carries a **"Reset to defaults"** button
(`#units-reset-btn` in `analysis.html`). It repopulates the four selects with
km/h, m, km and m/s — it does not save on its own, so the reset only takes effect
when you press Save (and is abandoned if you close the dialog instead).

Each threshold section has its own "Reset to defaults" button
(`.threshold-reset-btn`, keyed by `data-group`), working the same way: it fills
that group's inputs from `DEFAULT_THRESHOLDS` and Save commits them. Note this
writes the default *values* back as explicit overrides. `config.ts` also carries
`resetThresholdGroup(group)` and `resetAllThresholds()`, which instead **remove**
the stored overrides so the defaults apply implicitly — neither is wired to a
button today.

The dialog has a "Save" button that applies all changes at once.

### Reactive Updates

When units are changed:

1. Flight events are **re-detected** (`redetectEvents()` from the `onUnitsChanged` handler). Note this does not restate the event descriptions in the new units — see "Event Descriptions" below
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
- Stores preferences under `glidecomp:preferences` localStorage key
- Provides `getPreferences()`, `setPreferences()`, `getUnits()`, `setUnit()` methods
- Dispatches `glidecomp:preferences-changed` custom event when preferences change
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
- `onUnitsChanged(callback)` - Subscribe to unit preference changes (browser-side, lives in `web/frontend/src/analysis/units-browser.ts`, not the engine's `units.ts`)

**Spacing:** `formatUnit` joins the value and the label with a **non-breaking
space** (`U+00A0`), so `withUnit` reads `"45 km/h"`, `"15.2 km"`, `"2767 m"` — the
number and its unit never break across a line. Everything built on `formatUnit`
(`formatSpeed`, `formatAltitude`, `formatDistance`, `formatClimbRate`,
`formatAltitudeChange`) inherits that.

`formatRadius` is the one exception: it builds `withUnit` itself and stays tight —
`"400m"`, `"5km"`, `"2.5km"` — because a radius is quoted the way a task briefing
states it. (It also has its own precision rule: whole metres under a kilometre in
metric, otherwise one decimal, dropped when the value is whole.)

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
- Task leg distances (e.g., "Leg 1 (15.2 km)")
- Turnpoint radius (e.g., "R 5km" — `formatRadius`, so no space)
- Turnpoint altitude (e.g., "A 3067 m")
- Glide segment speed and altitude labels (e.g., "45 km/h") — `formatGlideLabel` splits `formatted` from `unit` and joins them with the same non-breaking space, so it can render the unit at 0.7em
- Glide segment altitude change labels, always signed (e.g., "-120 m")

### Event Descriptions

These do **not** go through `formatUnit` — the engine's detectors write them as
hardcoded SI with a tight unit, so they stay metric and unspaced whatever the
display preference:

- Max/min altitude (e.g., "Max altitude: 2767m")
- Max climb/sink (e.g., "Max climb: +3.2m/s")
- Thermal entry (e.g., "Thermal entry (+2.4m/s avg)")
- Thermal exit (e.g., "Thermal exit (+178m gained)")
- Glide end (e.g., "Glide end (5.2km)")

### Flight Info Header
- Max altitude display

## Migration Path to Backend

1. **Phase 1**: localStorage only — done
2. **Phase 2 (current)**: optional backend sync, layered on without changing the
   `ConfigStore` interface. `config.ts`'s own header states it: localStorage is the
   **synchronous read cache** (no startup flicker, works offline and signed out),
   and the cloud is the source of truth across devices when signed in.
   `web/frontend/src/auth/preferences-sync.ts` does the work:
   - **On startup**: fetch the cloud copy and reconcile against local. Cloud wins
     where it has data; fields missing from the cloud are uploaded from local (a
     one-time migration for existing users). It then calls `config.clearCache()` so
     the next `getPreferences()` re-reads the reconciled localStorage value
   - **On save**: `setPreferences()` writes localStorage, dispatches
     `glidecomp:preferences-changed`, and calls `preferencesSync.schedulePush()`.
     Pushes are debounced 2 s and `PUT` the whole current value, with retries
   - **Conflict resolution** is last-write-wins — no CAS, no version field
   - **Device-local fields never sync**: `LOCAL_ONLY_PREF_KEYS` currently holds
     `mapLocation`, because a viewport saved on a phone should not dictate what a
     laptop opens to (and pan events would generate constant sync noise)
   - `config.ts` imports `preferences-sync` statically; `preferences-sync` imports
     `config` only through a dynamic `import()` inside async paths, so there is no
     init-time module cycle
3. **Phase 3**: full backend with user accounts — replace localStorage reads with
   API calls, keeping localStorage as an offline cache only

The interface remains unchanged for consuming code.

## Testing

### Manual Testing Checklist

1. Open command menu (Cmd+K)
2. Search "units" - verify "Settings..." appears
3. Open the settings dialog and expand the Units section
4. Change each unit type and click Save
5. Verify all displayed values update immediately:
   - Event panel entries
   - Flight info header
   - Map leg distance labels
   - Map turnpoint labels
   - Glide markers (when a glide is selected)
6. Reload page - verify preferences persist
7. Clear localStorage - verify defaults restored
