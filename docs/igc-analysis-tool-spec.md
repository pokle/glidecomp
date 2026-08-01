# IGC Analysis Tool Specification

## Overview

The IGC Analysis Tool is a browser-based flight analysis application that allows pilots to visualize and analyze their paragliding/hanggliding flights. It parses IGC files, displays the track on an interactive 3D map, and detects flight events for analysis.

Single page app
- source `web/frontend/src/analysis.html`
- Deployed to https://glidecomp.com/analysis

## Features

### File Input
- **IGC File Upload**: Drag-and-drop or file picker for IGC files
- **XContest Task Code**: Load competition tasks by entering the task code from xcontest.org

### Map Display
All map visual details (colors, widths, fonts, interactions) are defined in [`mapbox-interactions-spec.md`](mapbox-interactions-spec.md) — the single source of truth for all map providers.

### Track Interaction
Users can click directly on the flight track to view event details:

- **Click on Track**: Clicking anywhere on the track selects the corresponding event
  - If the clicked point is within a segment (glide, thermal, or sink), that segment is selected
  - The event panel opens automatically if closed
  - The panel switches to the appropriate tab (Glides, Climbs, or Sinks) based on segment type
  - The map pans to the event location with segment highlighting
- **Hover Feedback**: Cursor changes to pointer when hovering over the track to indicate it's clickable

This provides an alternative to browsing the event panel - pilots can click directly on interesting parts of the track to see details.

### Command Palette (⌘K)
Quick access menu for display options and actions.

**Display Options:**
- **Toggle 3D Track** - Show/hide 3D track rendering with drone follow camera (on/off indicator)
- **Toggle Task** - Show/hide task visualization (cylinders, route lines, labels) - persisted via `?task-visible=0` URL param
- **Toggle Track** - Show/hide flight track and event markers - persisted via `?track-visible=0` URL param
- **Show Track Metrics** - Show/hide speed overlay with glide chevrons and labels for all glide segments (on/off indicator)
- **Annotate Map** (`menu-annotate`) - Toggle the freehand annotation overlay (on/off indicator, shortcut `D`)
- **Text Shadow Tuner** (`menu-text-shadow-tuner`) - Debug tool for tuning the glide-label text shadow

**File:**
- **Load track (IGC) / task (XCTSK) file** (`menu-open-igc`) - File picker for IGC/XCTSK upload
- **Load XContest task** (`menu-import-task`) - Enter task code to load from XContest
- **Load AirScore task** (`menu-import-airscore`) - Import a task (and its tracks) from an AirScore competition
- **Download task (.xctsk)** (`menu-download-task`) - Export the loaded task; hidden until a task is loaded
- **Unload all (task & track)** (`menu-clear-session`) - Clear the session back to an empty map

**Sample Flights:**
- Quick load sample IGC files for testing

**Sample Competitions:**
- Quick load a bundled competition task with its whole field of tracks (enters multi-track mode)

**Settings:**
- **Competition Settings...** (`menu-competition-settings`) - Opens `#competition-settings-dialog` for the GAP scoring parameters (PG/HG, nominal distance/goal/time, minimum distance, leading/arrival toggles)
- **Settings...** (`menu-configure-settings`) - Opens `#settings-dialog`, which covers display units *and* the event-detection thresholds (see below)

### Settings Dialog

Opened from the command palette's "Settings..." item (`menu-configure-settings` → `#settings-dialog`). Collapsible sections: **Units**, **Thermal Detection**, **Glide Detection**, **Vario Extremes**, **Takeoff / Landing**, **Circle Detection** — so the same dialog configures how values are displayed and the thresholds the detectors run with (`resolveThresholds` in `web/engine/src/thresholds.ts`). See `configurable-units-spec.md` (in this directory) for full details on the units half.

**Configurable Units:**
| Unit Type | Options | Default |
|-----------|---------|---------|
| Speed | km/h, mph, knots | km/h |
| Altitude | m, ft | m |
| Distance | km, mi, nmi | km |
| Climb Rate | m/s, ft/min, knots | m/s |

**Key Features:**
- All values update immediately when units are changed (no page refresh required)
- Preferences persist in localStorage
- Accessed via command palette: Cmd+K → "Settings..."

### Event Detection
The tool automatically detects the events below. Not everything detected is *listed* in the panel: the raw cylinder crossings are superseded by the scored `*_reaching` events, and individual circles would swamp the list, so `analysis-panel.ts` filters them out of the events list (`hiddenEventTypes`). They still exist on the event array for other consumers.

| Event Type | Description | In the events list |
|------------|-------------|--------------------|
| Takeoff | First moment of significant ground speed (>5 m/s) | Yes |
| Landing | Last moment of significant ground speed | Yes |
| Thermal Entry | Start of sustained climb (>0.5 m/s average) | Yes |
| Thermal Exit | End of thermal with altitude gain reported | Yes |
| Glide Start/End | Straight glide segments between thermals | Yes |
| Start Reaching | The scored SSS tag — the fix the start is taken at | Yes |
| Turnpoint Reaching | The scored tag of each turnpoint in sequence | Yes |
| ESS Reaching | The scored end-of-speed-section tag | Yes |
| Goal Reaching | The scored goal tag | Yes |
| Max/Min Altitude | Altitude extremes during flight | Yes |
| Max Climb/Sink | Maximum vertical speeds | Yes |
| Turnpoint Entry/Exit | Crossing turnpoint cylinder boundaries | No — superseded by Turnpoint Reaching |
| Start Crossing | Crossing SSS cylinder (race start) | No — superseded by Start Reaching |
| Goal Crossing | Crossing goal cylinder/line | No — superseded by Goal Reaching |
| Circle Complete | One completed circle (with wind estimate) | No — too numerous to list; feeds the HUD's wind/last-thermal data |

Map markers are a further narrowing again: only `KEY_EVENT_TYPES` (takeoff, landing, the four `*_reaching` events, max altitude) get a marker — see [`mapbox-interactions-spec.md`](mapbox-interactions-spec.md).

### Event Panel
Sidebar panel with a tabbed interface for viewing flight data. There is **one flat tab row** — no Track tab, no sub-tabs (`PanelTabType` in `analysis-panel.ts`). Which row is shown depends on the mode; the active tab is remembered in localStorage (`glidecomp-active-tab`).

**Single-track tab row** (`#tab-row-single`, default — Events is the initial tab):
- **Task** - Task turnpoints with optimized distances, radii, and altitudes
- **Score** - Scoring breakdown for this pilot (when a scored task is loaded)
- **Events** - Chronological list of the detected events (takeoff, thermals, glides, the `*_reaching` tags, landing, etc.)
- **Glides** - Glides sorted by distance (longest first), combining start/end info into single entries
- **Climbs** - Thermals sorted by altitude gain (highest first), combining entry/exit info into single entries
- **Sinks** - Glides with poor L/D ratio (5:1 or worse), sorted by altitude lost (deepest first)

**Multi-track tab row** (`#tab-row-multi`, shown by `setMultiTrackMode(true)` when a whole competition field is loaded — e.g. from the Sample Competitions group or an AirScore import). The single-track row is hidden and the panel switches to Competition Score:
- **Competition Score** - The whole field's scores for the task: GAP breakdown or the open-distance table depending on `setCompetitionScoringFormat()`. Selecting pilots here drives which tracks the map draws (`setPilotSelection` / `onPilotSelectionChanged`)
- **Task** - The same task view as single-track mode

Leaving multi-track mode restores the single row and falls back to Events.

**Hiding the panel:** a close button (`#sidebar-close`) in the flight-info banner collapses the sidebar to show the full map; the map's "Analysis" panel-toggle control reopens it.

**Task Tab Features:**
- Lists all turnpoints in order with:
  - Turnpoint number and name
  - Type badge (Takeoff/Start/Turnpoint/Goal) with color coding
  - Cylinder radius
  - Altitude (if available)
  - Leg distance (from previous turnpoint)
  - Cumulative distance from start
- Updates automatically when a task is loaded

**Events Tab Features:**
- Click on an event: Pan to event location and highlight on map

**Glides Tab Features:**
- Header: "Sorted by distance (longest first)"
- Each glide shows: rank (#1, #2...), distance (km), time range, and stats:
  - **L/D** - Glide ratio
  - **Spd** - Average speed (km/h)
  - **Alt** - Altitude lost (m)
  - **Dur** - Duration (mm:ss)
- Start/end altitudes displayed

**Climbs Tab Features:**
- Header: "Sorted by altitude gain (highest first)"
- Each climb shows: rank (#1, #2...), altitude gain (m), time range, and stats:
  - **Avg** - Average climb rate (m/s)
  - **Dur** - Duration (mm:ss)
- Start/end altitudes displayed
- Green accent color for climb items to distinguish from glides

**Sinks Tab Features:**
- Header: "Glides with L/D ≤ 5:1, sorted by altitude lost"
- Only shows glides with L/D ratio of 5:1 or worse (indicating strong sink)
- Each sink shows: rank (#1, #2...), altitude lost (m), time range, and stats:
  - **L/D** - Glide ratio (always ≤5:1)
  - **Avg** - Average sink rate (m/s)
  - **Dist** - Distance covered (km)
  - **Spd** - Average speed (km/h)
  - **Dur** - Duration (mm:ss)
- Start/end altitudes displayed
- Red accent color for sink items to indicate descent

**Cross-Tab Selection Sync:**
- Selecting a glide_start or glide_end event in Events tab → switching to Glides or Sinks highlights the corresponding item
- Selecting a thermal_entry or thermal_exit event in Events tab → switching to Climbs highlights the corresponding climb
- Selecting a glide in Glides tab → switching to Events highlights the corresponding glide_start event
- Selecting a climb in Climbs tab → switching to Events highlights the corresponding thermal_entry event
- Selecting a sink in Sinks tab → switching to Events highlights the corresponding glide_start event
- Selected item automatically scrolls into view when switching tabs

### Event Selection Visualization
When an event is selected from the panel, the map highlights the event location with segment lines, endpoint markers, glide chevrons, and speed labels. Full visual details (colors, sizes, throb animation, zoom-dependent label visibility) are defined in the "Event Highlight" section of [`mapbox-interactions-spec.md`](mapbox-interactions-spec.md).

**Selection Clearing**: Event selection and all associated visualizations (segment highlight, markers, legend) are automatically cleared when:
- Loading a new IGC file
- Toggling 3D track mode
- Anything else that results in the visualisation or information presented being unrelated to the track or task being shown.

## Technical Architecture

```
/web/engine/src/               # Shared analysis library (key modules; not exhaustive)
├── igc-parser.ts                # IGC file format parser
├── xctsk-parser.ts              # XContest task format parser
├── event-detector.ts            # Flight event detection orchestration
├── flight-phase-detectors.ts    # Thermal and glide segment detection
├── circle-detector.ts           # Circling flight detection and wind estimation
├── cluster-detector.ts          # Cross-pilot gaggle detection
├── turnpoint-sequence.ts        # Turnpoint sequencing and best-progress scoring
├── task-optimizer.ts            # Optimized task line calculation (golden section search)
├── gap-scoring.ts               # CIVL GAP multi-track task scoring (FAI Section 7F)
├── open-distance-scoring.ts     # Open-distance task scoring
├── field-analysis/              # Per-pilot behavioural metrics across a whole field of
│                                # tracks, ranked by Spearman correlation vs GAP rank
│                                # (see docs/2026-07-18-field-analysis-plan.md)
├── segment-extractors.ts        # Data extraction for glides, climbs, sinks
├── event-styles.ts              # Event type colors and visual styles
├── geo.ts                       # Geographic calculations (WGS84: Andoyer-Lambert distance, Vincenty destination, Turf.js bearing/bbox)
├── glide-speed.ts               # Glide segment speed calculations
├── units.ts                     # Unit conversion
├── sanitize.ts                  # Text sanitization (HTML escaping)
├── waypoints.ts                 # Waypoint handling
└── index.ts                     # Library exports

/web/engine/cli/
├── detect-events.ts             # Detect flight events from an IGC file
├── get-xcontest-task.ts         # Download a task from XContest by code
├── score-task.ts                # Score multiple pilots against a task (CIVL GAP);
│                                # --field-analysis / --comp print the behavioural
│                                # field-analysis report after the scores
└── comp-manifest.ts             # Bundled-comp manifest reading for --comp mode

/web/frontend/src/          # (key modules; not exhaustive)
├── analysis.html                # Main HTML page with Tailwind layout
├── analysis.css                 # Page styles (Tailwind, design tokens, MapBox CSS)
└── analysis/
    ├── main.ts                  # Application entry point and orchestration
    ├── analysis-panel.ts        # Sidebar panel UI (single- and multi-track tab rows)
    ├── command-menu.ts          # Command palette (⌘K) wiring
    ├── task-editor.ts           # Task route editing (turnpoint add/edit/reorder)
    ├── map-provider.ts          # Map provider interface
    ├── map-provider-shared.ts   # Shared map utilities (HUD, glide markers, collision detection)
    ├── mapbox-provider.ts       # MapBox GL JS implementation
    ├── map-annotations.ts       # Freehand annotation overlay (strokes persisted via storage.ts)
    ├── elevation.ts             # Terrain elevation lookups
    ├── airscore-client.ts       # AirScore API client
    ├── config.ts                # Configuration storage abstraction
    ├── units-browser.ts         # Browser-side unit formatting
    ├── storage.ts               # Tracks/tasks/annotations via the /api/user/... endpoints (R2 + D1)
    ├── storage-menu.ts          # Storage command menu integration
    ├── waypoint-loader.ts       # Waypoint file loading
    └── xctsk-fetch.ts           # XContest task fetching
```

### IGC Parser
Parses standard IGC files according to FAI specification:
- A record (device ID)
- H records (header info: date, pilot, glider)
- B records (GPS fixes with timestamp, position, altitude)
- C records (task declaration)
- E records (events)

### XContest Task Parser
Supports both v1 (full JSON) and v2 (compact QR code) formats:
- Fetches tasks from `tools.xcontest.org/api/xctsk/load/{code}`
- Parses turnpoint definitions, SSS/ESS markers, cylinder radii
- Handles both WGS84 and FAI Sphere earth models
- See https://tools.xcontest.org/xctsk for api documentation

### Event Detection Algorithms
- **Thermals**: Rolling window analysis of vertical speed, minimum duration threshold (see `event-detection/thermal-detection-spec.md` for detailed algorithm documentation)
- **Glides**: Segments between thermals with calculated L/D ratio (see `event-detection/glide-detection-spec.md` for detailed algorithm documentation)
- **Circle detection**: Cumulative heading change to detect individual thermal circles, with wind estimation from circle drift (see `event-detection/circling-flight-and-thermal-analysis-research.md`)
- **Turnpoint sequencing**: Cylinder crossing detection and CIVL GAP-compliant turnpoint sequence resolution, including SSS direction validation and best-progress scoring
- **Cylinder crossings**: WGS84 ellipsoid distance checks (Andoyer-Lambert) against turnpoint radii
- **Vario extremes**: Smoothed vertical speed analysis
- **GAP scoring**: Multi-track task scoring implementing the CIVL GAP formula (FAI Sporting Code Section 7F). Calculates task validity, weight distribution, distance/time/leading/arrival points. Supports both PG and HG scoring with configurable competition parameters (nominal distance/goal/time, minimum distance, leading/arrival toggles).

## Data Formats

### IGC B Record Format
```
BHHMMSSDDMMMMMN/SDDDMMMMMMMMWVPPPPPGGGGGext
B       - Record type
HHMMSS  - UTC time
DDMMMMM - Latitude degrees, minutes (3 decimals)
N/S     - North/South
DDDMMMMM- Longitude degrees, minutes (3 decimals)
E/W     - East/West
V       - Fix validity (A=3D, V=2D)
PPPPP   - Pressure altitude (meters)
GGGGG   - GNSS altitude (meters)
ext     - Optional extensions
```

### XCTSK v1 Format
```json
{
  "taskType": "CLASSIC",
  "version": 1,
  "earthModel": "WGS84",
  "turnpoints": [
    {
      "type": "SSS",
      "radius": 400,
      "waypoint": {
        "name": "Start",
        "lat": 47.0,
        "lon": 11.0,
        "altSmoothed": 1500
      }
    }
  ],
  "sss": { "type": "RACE", "direction": "ENTER" },
  "goal": { "type": "CYLINDER" }
}
```

## Dependencies

- **mapbox-gl**: Map rendering with 3D terrain and sky atmosphere
- **threebox-plugin**: 3D track rendering on MapBox
- **tailwindcss**: Utility-first CSS framework
- **@turf/***: Geographic utilities (bearing, bounding box). Distance and destination use custom WGS84 implementations (Andoyer-Lambert, Vincenty direct)
- **vite**: TypeScript bundling and dev server with HMR

## URL

Available at `/analysis.html`

## Future Enhancements

- [x] Altitude sparkline (see `sparkline-spec.md`)
- [ ] Speed/vario charts
- [ ] Task validation and scoring
- [ ] Multiple flight comparison
- [ ] Export analysis report
- [ ] Thermal map aggregation
- [ ] **Flying area features** (planned):
  - Common waypoints used in tasks
  - Map polygons for danger/no-landing areas
  - Lift generators (hot rocks, ridges, etc.)
  - Historical thermal hotspots
  - Links to competitions flown in the area
