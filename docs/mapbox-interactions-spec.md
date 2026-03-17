# MapBox Provider — Visual & Interaction Reference

Extracted from `web/frontend/src/analysis/mapbox-provider.ts` and `map-provider-shared.ts`.

## Map Controls

- **Panel toggle** — custom control (top-right, topmost), sidebar-icon SVG button, fires `onPanelToggleClick` callback
- **Navigation control** — zoom +/-, compass, pitch visualizer (top-right, below panel toggle)
- **Fullscreen control** — toggle button (top-right)
- **Scale bar** — max width 200px
- **Menu button** — custom control (top-left, topmost), hamburger-icon SVG button `(⌘K)`, fires `onMenuButtonClick` callback
- **Style selector** — `<select>` dropdown (top-left, below menu button), font 12px, white background, text `#1e293b`. Options: Outdoors (default custom style), Satellite, Streets, Light, Dark
- **Map location** — center, zoom, pitch, bearing persisted to localStorage (debounced 5s after moveend). Restored on next load. Default pitch 45, max pitch 85

## Terrain & Atmosphere

- **3D terrain** — Mapbox DEM source, exaggeration 1.5, added on every style load
- **Sky layer** — atmosphere type, sun at `[0, 90]`, intensity 15

## Flight Track

Track is rendered as individual per-segment LineString features (one per consecutive fix pair), each carrying a `normalizedAlt` property (0–1) based on the average altitude of the segment relative to the flight's min/max altitude. This enables per-segment altitude-driven styling.

- **Track line** (always altitude-colored)
  - Data-driven color via per-feature `normalizedAlt` property with `interpolate` expression
  - Colour ramp (normalizedAlt 0→1): earthy brown `#8B5A2B` → green `#43A047` → cyan `#039BE5` → sky blue `#29B6F6` → light sky `#4FC3F7`
  - Black outline behind: `#000000`, opacity 0.6
  - Both lines zoom- and altitude-adaptive width (width_mul 0.7):
    - Inner line: zoom 3 → 2–6 px, zoom 8 → 3–9 px, zoom 12 → 3–9 px (low–high altitude)
    - Outline: zoom 3 → 4–12 px, zoom 8 → 6–18 px, zoom 12 → 5–16 px (low–high altitude)
  - Higher altitude segments render wider, creating a depth/perspective effect in top-down view
  - Line join/cap: round, opacity 0.95
  - Note: `calculateAltitudeGradient()` exists in shared utils for line-progress gradient but is unused by MapBox; the per-feature approach is used instead

- **3D mode** (Threebox)
  - 2D track layers hidden; track rendered as connected 3D line segments with per-segment altitude color (same ramp as altitude mode)
  - Segment width: 3, opacity: 0.9
  - Vertical drop-lines every 1km of track distance: from track altitude to ground, color `#888888`, width 1, opacity 0.3, depth-tested (toggleable via `SHOW_DROP_LINES` constant)
  - Camera preset buttons (Side/Top/Behind/Front) created when entering 3D with a track loaded, or when a track is loaded while already in 3D; removed on `clearTrack()` — see "3D Drone Follow Camera" section below for details

- **Interactions**
  - Click/tap on track → fires `onTrackClick` callback with nearest fix index
  - Nearest-fix algorithm: when track crosses itself, prefers the latest fix (highest index) within a tolerance, since later segments are drawn on top
  - Hover → cursor changes to pointer
  - Click targets: `track-line`, `track-line-outline`, `track-line-gradient` layers

- **Fit bounds** — on track load, map fits to track bounding box with 50px padding, 1s animation

## Task

- **Optimized route line**
  - Dashed line: `#6366f1` (indigo), width 2, dash pattern `[4, 4]`, opacity 0.8
  - Line join/cap: round

- **Directional arrows on route**
  - Canvas-drawn triangle icon 20x20, filled `#6366f1`, opacity 0.8
  - Placed along line every 40px symbol spacing, icon size 0.55
  - Rotation alignment: map


- **Turnpoint cylinders**
  - Fill: 15% opacity, stroke: width 2, 80% opacity
  - Colors by type:
    - SSS (start): `#22c55e` (green)
    - ESS (end speed): `#eab308` (yellow)
    - TAKEOFF: `#3b82f6` (blue)
    - Other: `#a855f7` (purple)
  - Rendered as 64-point polygons via `createCirclePolygon()`

- **Turnpoint dots**
  - Circle radius: 6px
  - Fill color: same type-based scheme as cylinders
  - Stroke: 2px white

- **Turnpoint labels**
  - Text size: 20, offset `[0, 1.5]`, anchor: top
  - Color: `#1e293b` (dark slate), halo: white, 2px width
  - Content: `"NAME, R Xkm, A Ym, ROLE"` (with non-breaking spaces)
  - Font: `'Atkinson Hyperlegible Next', sans-serif` (map-wide `localFontFamily`)

- **Segment distance labels**
  - Positioned at midpoint of each leg
  - Text size: 16, rotated to follow leg bearing (normalized so never upside-down)
  - Color: `#6366f1` (indigo), halo: `#eeeeee`, 2px width
  - Content: `"Leg N (X.Xkm)"`

- **Interactions**
  - Click/tap on turnpoint dot → fires `onTurnpointClick` callback with turnpoint index
  - Hover on turnpoint dot → cursor changes to pointer
  - `panToTurnpoint()` → flyTo turnpoint center, keeps current zoom, 1s animation

- **Fit bounds** — if no track loaded, map fits to task turnpoint bounds with 50px padding, 1s animation

## Event Markers

- Shown only for key event types: takeoff, landing, start_reaching, turnpoint_reaching, ess_reaching, goal_reaching, max_altitude
- Circle: 20x20px, 50% border-radius
- Fill: event-type color (see below), border: 2px solid white, box-shadow: `0 2px 4px rgba(0,0,0,0.3)`, cursor: pointer
- Click → popup with event description (bold) + time, offset 25px

### Event Colors
| Event | Color |
|---|---|
| takeoff | `#22c55e` (green) |
| landing | `#ef4444` (red) |
| thermal_entry / thermal_exit | `#f97316` (orange) |
| glide_start / glide_end | `#3b82f6` (blue) |
| turnpoint_entry / turnpoint_exit | `#a855f7` (purple) |
| start_crossing | `#22c55e` (green) |
| goal_crossing | `#eab308` (yellow) |
| start_reaching | `#16a34a` (green-700) |
| turnpoint_reaching | `#7c3aed` (violet) |
| ess_reaching | `#dc2626` (red-600) |
| goal_reaching | `#ca8a04` (yellow-700) |
| max_altitude | `#06b6d4` (cyan) |
| min_altitude | `#64748b` (slate) |
| max_climb | `#22c55e` (green) |
| max_sink | `#ef4444` (red) |
| circle_complete | `#8b5cf6` (violet-500) |
| default | `#64748b` (slate) |

## Event Highlight (panToEvent)

- **Segment highlight line**: `#00ffff` (cyan), width 6, opacity 0.9

- **Endpoint markers** (for events with a segment)
  - Start marker: 14x14px circle, transparent fill, 3px border in event color, box-shadow `0 2px 6px rgba(0,0,0,0.4)`
  - End marker: 14x14px circle, filled event color, 3px white border, same shadow
  - One of the two throbs (the start marker for entry events like `thermal_entry`/`glide_start`; otherwise the end marker)

- **Point marker** (for events without a segment)
  - 16x16px circle, filled event color, 3px white border, same shadow
  - Always throbs

- **Throb animation**: `@keyframes throb` — pulsing box-shadow, 0.5s ease-in-out, repeats 4 times

- **Glide event extras** (glide_start / glide_end)
  - Chevron markers along segment (~1km intervals)
    - SVG 20x12: single `<path>` chevron, stroke `#3b82f6`, stroke-width 3, rounded caps/joins, rotated to bearing
  - Speed labels between chevrons
    - Font: `'Atkinson Hyperlegible Next', sans-serif`, 20px, weight 600, color `#3b82f6`
    - White text-shadow outline (4-direction 1px)
    - Content: speed (formatted), glide ratio (`↘N:1`), altitude change, required glide ratio to next turnpoint (`↘N:1 to NAME`)
    - Line-height: 1.3, centered, no-wrap
    - Zoom-dependent visibility:
      - Below zoom 11: hidden entirely
      - Zoom 11–13: speed only
      - Zoom 13+: speed + glide ratio + altitude change + required GR (if applicable)
  - Glide legend `?` button appears (bottom of map container)
  - **Screen-space collision detection** — labels are projected to screen coordinates and hidden if they overlap higher-priority labels:
    - Priority: fastest glide first, then by original index (earlier in flight = higher priority)
    - Label bounding boxes are zoom-dependent: 160×30px compact (zoom <15), 180×65px detail (zoom ≥15), with 10px horizontal / 6px vertical padding
    - Paired chevron markers are also hidden when their label is hidden
    - Recalculated on every viewport change (zoom, pan, rotate)

- **Pan** — `flyTo` event location, maintains current zoom, 1s duration (skippable via `skipPan` option)

## Track Point HUD (showTrackPointHUD)

Displayed when user clicks on a non-glide track point. Combines a map marker with a data overlay.

- **Crosshair marker** — SVG placed at the clicked fix position, white with drop-shadow, pointer-events disabled
  - SVG 24x24: circle (r=4, stroke 1.5) + 4 crosshair lines (stroke 2, round caps)

- **HUD overlay** — positioned in the map container, created lazily on first use
  - Minimizable via toggle button (`−`/`+`)
  - Three collapsible `<details>` groups:
    1. **Point** — altitude + time (e.g., `1234m at 14:32:05`)
    2. **1 km avg** — speed + altitude change (e.g., `45km/h  −120m`), optional required glide ratio line (`↘28:1 to TP3`)
    3. **Last Thermal** — max altitude + time from most recent climbing circles, wind arrow + speed if wind data available

- **Data computation** (`buildTrackPointHUDData`)
  - Uses `calculatePointMetrics()` with 1km averaging window
  - **Terrain elevation querying**: `map.queryTerrainElevation()` for target turnpoint altitude, falling back to waypoint `altSmoothed`
  - Resolves next turnpoint via `buildNextTurnpointContext()` using cached turnpoint sequence and optimized path
  - **Last thermal data** (`findLastThermalData`): finds up to 3 most recent climbing circles before the fix, averages wind (circular mean for direction), tracks max altitude

- **Wind estimation** (`estimateWindFromNearbyCircles`)
  - Prefers ground-speed wind from circle_complete events
  - Falls back to drift wind
  - Circular mean averaging for direction

## Speed Overlay (Track Metrics)

When enabled via the "Show Track Metrics" command palette option, displays glide chevrons and speed labels for **all** glide segments simultaneously (unlike event highlight which shows one glide at a time).

- **Fastest segment** — highlighted with a red overlay line (`speed-fastest-segment` layer, `#ef4444`, width 6, opacity 0.9)
- **All glide labels** — same chevron and speed label styling as event highlight glide extras, with screen-space collision detection to prevent overlap

## Visibility Toggles

- **Task visibility** — toggles 7 task layers (cylinder fill/stroke, points, labels, segment labels, line, line arrows)
- **Track visibility** — toggles all track layers (`track-line`, `track-line-outline`, `highlight-segment`) + 3D objects + event markers (markers hidden via `display: none`); clears highlights when hiding

## Layer Ordering (bottom to top)

1. `task-line` — dashed route line
2. `task-line-arrows` — directional arrows on route
3. `task-cylinders-fill` — turnpoint cylinder fills
4. `task-cylinders-stroke` — turnpoint cylinder strokes
5. `track-line-outline` — black track shadow
6. `track-line` — altitude-colored track
7. `highlight-segment` — cyan highlight for selected events
8. `speed-fastest-segment` — red overlay for fastest speed segment
9. `task-points` — turnpoint dots
10. `task-labels` — turnpoint name labels
11. `task-segment-labels` — leg distance labels
12. `annotation-strokes-layer` — committed annotation strokes
13. `annotation-live-layer` — in-progress annotation stroke preview
14. `threebox-layer` — 3D custom rendering layer (Threebox)

## 3D Drone Follow Camera

Activated when 3D track mode is enabled. Provides a cinematic perspective that follows the flight.

- **Camera behaviour** — fixed-altitude 3D perspective (75° pitch) tracking the glider position, with momentum-based smooth animation (lerped each frame)
- **Camera presets** — four dynamic angles that track flight direction:
  - "side" (default): 90° perpendicular to flight path
  - "behind": follow directly behind the glider
  - "front": look from ahead toward the glider
  - "top": orthographic overhead view
- **Altitude scrubber** — SVG-based interactive timeline overlay at the bottom of the 3D view:
  - Filled area graph with gradient coloring (altitude-based color ramp)
  - Y-axis: nicely-rounded altitude labels with grid ticks
  - X-axis: time labels snapped to round minute intervals (5, 10, 15, 30, 60 min steps)
  - Vertical orange indicator line showing current position
- **Scrubbing interaction** — click/drag horizontally on the scrubber to move along the flight:
  - Updates HUD with current fix info (altitude, speed, bearing)
  - Updates glider marker position on the 3D map
  - Re-targets camera with smooth momentum-based animation
  - Camera preset bearing stays aligned with flight direction

## Annotation Overlay

Freehand drawing overlay for scrawling on the map. Strokes are geo-anchored (persist through pan/zoom/pitch/bearing) and stored in IndexedDB. Rendered as native Mapbox GeoJSON line layers so they sit flat on the map surface (including terrain).

- **Rendering** — native Mapbox `line` layers over GeoJSON sources (no canvas overlay)
  - `annotation-strokes` source/layer: committed strokes with round caps/joins
  - `annotation-live` source/layer: in-progress stroke preview (lower opacity)
  - Sources/layers re-added on `style.load` to survive style changes
  - Transparent `<div>` input overlay (`z-index: 10`) captures pointer events

- **Drawing model**
  - Draw phase: freehand input captured in screen coordinates, converted to geo on each move for live preview
  - Commit phase: screen points simplified via Ramer-Douglas-Peucker (2px tolerance), then converted to `[lng, lat]` via `map.unproject()`
  - Render phase: Mapbox renders GeoJSON line layers natively — strokes follow terrain

- **Line style** — `line-width: 3`, `line-color: #e03131` (red), `line-opacity: 0.85`, round caps and joins

- **Modes**
  - **Draw** (default): crosshair cursor, freehand strokes
  - **Erase**: pointer cursor, strokes within 12px of eraser path are removed

- **Toolbar** — floating bar (bottom-left, above scale bar, `z-index: 11`), white semi-transparent background, 8px border-radius
  - Buttons: Draw (P), Erase (E), Undo, Redo, Clear All (red trash icon)
  - Active tool highlighted with `#e8e8e8` background
  - Appears/disappears with annotation mode toggle

- **Map interaction** — when annotation mode is active, `dragPan`, `scrollZoom`, `doubleClickZoom`, `dragRotate`, `touchZoomRotate`, and `keyboard` are disabled; re-enabled on deactivation

- **Keyboard shortcuts** (Excalidraw-compatible)
  | Action | Shortcut |
  |--------|----------|
  | Toggle annotation mode | `P` |
  | Switch to eraser | `E` |
  | Exit annotation mode | `Escape` or `V` |
  | Undo | `Cmd/Ctrl+Z` (annotation mode only) |
  | Redo | `Cmd/Ctrl+Shift+Z` or `Cmd/Ctrl+Y` (annotation mode only) |
  | Clear all | `Cmd/Ctrl+Shift+Delete` (annotation mode only) |

- **Persistence** — strokes stored in IndexedDB `annotations` store, independent of tracks/tasks; loaded on map initialization

- **Command palette** — "Annotate Map" item in Display Options group, toggles annotation mode, shows `(on)/(off) P` status

## Style Reload Behaviour

On style change, all custom sources/layers are re-added and current track/task/event data is restored via `restoreData()`. Terrain and sky layer are also re-added on every `style.load` event.
