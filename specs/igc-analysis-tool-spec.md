# IGC Analysis Tool Specification

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
- **3D Terrain**: MapLibre GL JS with hillshade and terrain elevation
- **Track Visualization**: Flight track displayed with altitude-based coloring
  - Blue: Low altitude (0-1000m)
  - Green: Medium altitude (1000-2000m)
  - Yellow: High altitude (2000-3000m)
  - Red: Very high altitude (>3000m)
- **Task Display**:
  - Turnpoint cylinders with color coding (green=SSS, yellow=ESS, purple=intermediate)
    - Label at center of waypoint with name, radius, altitude and role (e.g. "ELLIOT, R 5km, A 3067m, SSS")
  - Optimised line connecting turnpoints
    - Dotted
    - Label in the centre of line with distance and leg number (e.g. "Leg 1: 15.2km")

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
- Collapsible sidebar listing all detected events (Take off, thermal, landing, etc...)
- Filter toggle to show only events visible in current map view
- Click on an event: Pan to event location
- Double-click on an event: Pan and zoom in on the event location

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
  - Speed labels displayed 250m before each chevron showing average speed for the 500m segment (MapBox only)
    - Example: "45km/h" displayed at 250m, chevron at 500m, "42km/h" at 750m, chevron at 1000m, etc.
    - Speed calculated from time taken to cover each 500m segment
    - Labels styled with blue text and white text shadow for readability

This visual system helps pilots quickly identify and understand the spatial extent of flight phases.

## Technical Architecture

```
/pages/src/analysis/
├── main.ts           # Application entry point and orchestration
├── igc-parser.ts     # IGC file format parser
├── xctsk-parser.ts   # XContest task format parser
├── event-detector.ts # Flight event detection algorithms
├── event-panel.ts    # Event list UI component
└── map-renderer.ts   # MapLibre GL JS wrapper
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

- **maplibre-gl**: Map rendering with terrain and hillshade
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
