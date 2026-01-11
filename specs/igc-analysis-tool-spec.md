# IGC Analysis Tool Specification

## Overview

The IGC Analysis Tool is a browser-based flight analysis application that allows pilots to visualize and analyze their paragliding/hanggliding flights. It parses IGC files, displays the track on an interactive 3D map, and detects flight events for analysis.

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
  - Task line connecting turnpoints
  - Waypoint labels

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
- Collapsible sidebar listing all detected events
- Filter toggle to show only events visible in current map view
- Events grouped by category (Key Events, Thermals, Glides, Turnpoints, Statistics)
- Click-to-pan: clicking an event centers the map on that location

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
- **esbuild**: TypeScript bundling for browser

## URL

Available at `/analysis.html`

## Future Enhancements

- [ ] Altitude profile chart
- [ ] Speed/vario charts
- [ ] Task validation and scoring
- [ ] Multiple flight comparison
- [ ] Export analysis report
- [ ] Thermal map aggregation
