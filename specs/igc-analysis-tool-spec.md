# IGC Analysis Tool Specification

## TODO
- [ ] Allow users to click on the track to show details on the events panel.
  - Open the Event panel if closed
  - If the point lies within a segment, select the segment (glide, thermal, or sink)
  - Otherwise select the closest event on the event panel. 
  - Accomodations:
    - If possible, on hover, change the cursor to indicate that it's clickable.
    - If possible, on hover over a segment, highlight the segment by increasing its width.
- [ ] Add a 'Show all Events' command that's equivalent to clicking the Events button, and switching the filter to show all events. It should focus the keyboard on the event panel.
- [x] Implement 'Highest climbs' tab - show all climbs/thermals sorted by greatest altitude gain first
- [x] Implement 'Deepest sinks' tab - show all descents sorted by greatest altitude drop first
- [ ] DEFER: Add box plots to the 'Longest glides' view showing vertically stacked box plots per detail (use uPlot for plotting, and simple-statistics for the descriptive statistics)
- [x] Review code and ensure that we're using appropriate libraries for statistics and geo calculations.
- [x] Make units selectable (see `configurable-units-spec.md`)
- [ ] Add altitude chart. X axis: Time, Y axis: Altitude
- [x] Associate tasks with tracks. When we load a track, we should use the IGC file's declared task information if available. 
- [x] If the IGC file doesn't contain task information, we should try to associate the track with any known tasks in the region on the date.
- [x] USABILITY: The altitude colours should be on by default.

## Overview

The IGC Analysis Tool is a browser-based flight analysis application that allows pilots to visualize and analyze their paragliding/hanggliding flights. It parses IGC files, displays the track on an interactive 3D map, and detects flight events for analysis.

Single page app
- source `pages/src/analysis.html`
- Deployed to https://taskscore.shonky.info/analysis

## Features

### File Input
- **IGC File Upload**: Drag-and-drop or file picker for IGC files
- **XContest Task Code**: Load competition tasks by entering the task code from xcontest.org

### Map Display
- **3D Terrain**: MapBox GL JS with terrain elevation and sky atmosphere
- **Track Visualization**: Flight track displayed with altitude-based coloring (toggleable)
  - Brown: Low altitude (0-1000m) - earthy colors near the ground
  - Green: Medium altitude (1000-2000m) - transitional
  - Light Blue: High altitude (2000-3000m) - approaching sky
  - Sky Blue: Very high altitude (>3000m) - sky colors at altitude
- **Task Display**:
  - Turnpoint cylinders with color coding (green=SSS, yellow=ESS, purple=intermediate)
    - Label at center of waypoint with name, radius, altitude and role (e.g. "ELLIOT, R 5km, A 3067m, SSS")
  - Optimised line connecting turnpoints
    - Dotted
    - Label in the centre of line with distance and leg number (e.g. "Leg 1: 15.2km")

### Command Palette (⌘K)
Quick access menu for display options and actions.

**Display Options:**
- **Light/Dark/System Theme** - Switch color theme
- **Toggle Altitude Colors** - Show/hide altitude-based track coloring (on/off indicator)
- **Toggle 3D Track** - Show/hide 3D track rendering (on/off indicator)
- **Toggle Task** - Show/hide task visualization (cylinders, route lines, labels) - persisted via `?task-visible=0` URL param
- **Toggle Track** - Show/hide flight track and event markers - persisted via `?track-visible=0` URL param

**File Operations:**
- **Open IGC file** - File picker for IGC upload
- **Import XContest task** - Enter task code to load from XContest

**Sample Flights:**
- Quick load sample IGC files for testing

**Settings:**
- **Configure units...** - Opens dialog to configure display units (see below)

### Units Configuration

Users can configure display units for measurements via the "Configure units..." option in the command palette. See `configurable-units-spec.md` for full details.

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
- Accessed via command palette: Cmd+K → "Configure units..."

### Event Detection
The tool automatically detects and displays:

| Event Type | Description |
|------------|-------------|
| Takeoff | First moment of significant ground speed (>5 m/s) |
| Landing | Last moment of significant ground speed |
| Thermal Entry | Start of sustained climb (>0.5 m/s average) |
| Thermal Exit | End of thermal with altitude gain reported |
| Glide Start/End | Straight glide segments between thermals |
| Turnpoint Entry/Exit | Crossing turnpoint cylinder boundaries |
| Start Crossing | Crossing SSS cylinder (race start) |
| Goal Crossing | Crossing goal cylinder/line |
| Max/Min Altitude | Altitude extremes during flight |
| Max Climb/Sink | Maximum vertical speeds |

### Event Panel
Collapsible sidebar with tabbed interface for viewing flight data. Uses Basecoat tabs component.

**Tabs:**
- **Events** - Chronological list of all detected events (takeoff, thermals, glides, landing, etc.)
- **Glides** - Glides sorted by distance (longest first), combining start/end info into single entries
- **Climbs** - Thermals sorted by altitude gain (highest first), combining entry/exit info into single entries
- **Sinks** - Glides with poor L/D ratio (5:1 or worse), sorted by altitude lost (deepest first)

**Events Tab Features:**
- Two filter buttons (always visible, not a toggle):
  - **Show all** - Display all events
  - **Show visible** - Filter to events within current map bounds (one-time snapshot, not continuous)
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
When an event is selected from the panel:

- **Segment Highlighting**: For thermal and glide events, the corresponding track segment is highlighted with a bright cyan line (6px width) to clearly show the extent of the segment
- **Auto-Popup**: A popup appears showing event details (description, time, altitude) anchored to:
  - Entry/start point for thermal_entry and glide_start events
  - Exit/end point for thermal_exit and glide_end events
  - Event location for point events (takeoff, max altitude, etc.)
- **Segment Markers**: For segment events (thermals, glides), two markers are displayed:
  - **Start marker**: Ring/outline style circle at the segment start
  - **End marker**: Filled circle at the segment end
- **Point Marker**: For non-segment events, a single filled marker at the event location
- **Glide Direction Chevrons**: When a glide event is selected, chevron markers are displayed along the glide path to indicate flight direction:
  - Chevrons placed every 500m along the glide trail
  - Each chevron rotated to match the local track bearing at that point
  - Blue chevron markers with white outline for visibility
  - Performance labels displayed 250m before each chevron showing metrics for the 500m segment (MapBox only):
    - **Speed**: Average speed in km/h (e.g., "45km/h")
    - **Glide ratio**: L/D ratio for the segment (e.g., "12:1"), shows "∞:1" if climbing/level
    - **Altitude change**: Altitude difference in meters (e.g., "-42m" for descent, "+5m" for climb)
    - Example display: "45km/h" on first line, "12:1 -42m" on second line
    - Labels styled with blue text and white text shadow for readability
- **Glide Metrics Legend**: A help button appears at the bottom-right of the map when a glide event is selected:
  - Blue circular "?" button that expands on click
  - Shows explanations for: chevron spacing (500m segments), speed, L/D ratio, and altitude change
  - Automatically hidden when selecting non-glide events

**Selection Clearing**: Event selection and all associated visualizations (segment highlight, markers, legend) are automatically cleared when:
- Loading a new IGC file
- Toggling 3D track mode
- Toggling altitude colors mode
- Anything else that results in the visualisation or information presented being unrelated to the track or task being shown.

This visual system helps pilots quickly identify and understand the spatial extent of flight phases.

## Technical Architecture

```
/pages/src/
├── analysis.html       # Main HTML page with Tailwind/Basecoat layout
├── styles.css          # Global styles (Tailwind, Basecoat, MapBox CSS)
└── analysis/
    ├── main.ts           # Application entry point and orchestration
    ├── igc-parser.ts     # IGC file format parser
    ├── xctsk-parser.ts   # XContest task format parser
    ├── event-detector.ts # Flight event detection algorithms
    ├── event-panel.ts    # Event list UI component (Tailwind classes)
    ├── map-provider.ts   # Map provider interface
    ├── mapbox-provider.ts # MapBox GL JS implementation
    ├── geo.ts            # Geographic calculations (Turf.js wrapper)
    └── glide-speed.ts    # Glide segment visualization
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
- **Thermals**: Rolling window analysis of vertical speed, minimum duration threshold
- **Glides**: Segments between thermals with calculated L/D ratio
- **Cylinder crossings**: Haversine distance checks against turnpoint radii
- **Vario extremes**: Smoothed vertical speed analysis

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
- **basecoat-css**: Lightweight UI component library
- **@turf/***: Geographic calculations (distance, bearing, etc.)
- **vite**: TypeScript bundling and dev server with HMR

## URL

Available at `/analysis.html`

## Future Enhancements

- [ ] Altitude profile chart
- [ ] Speed/vario charts
- [ ] Task validation and scoring
- [ ] Multiple flight comparison
- [ ] Export analysis report
- [ ] Thermal map aggregation
