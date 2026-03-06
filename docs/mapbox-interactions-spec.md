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

- **Flat-color mode** (default)
  - Solid line: `#f97316` (bright orange), opacity 0.95
  - Black outline behind: `#000000`, opacity 0.6
  - Both lines zoom- and altitude-adaptive width (width_mul 0.7):
    - Inner line: zoom 3 → 1.4–4.2 px, zoom 8 → 2.1–6.3 px, zoom 12 → 2.1–6.3 px (low–high altitude)
    - Outline: zoom 3 → 2.8–8.4 px, zoom 8 → 4.2–12.6 px, zoom 12 → 3.5–11.2 px (low–high altitude)
  - Higher altitude segments render wider, creating a depth/perspective effect in top-down view
  - Line join/cap: round
  - Source tolerance 0.1 (minimal simplification)

- **Altitude-color mode**
  - Data-driven color via per-feature `normalizedAlt` property with `interpolate` expression, replaces flat-color line (outline remains)
  - Same zoom- and altitude-adaptive width as flat mode
  - Colour ramp (normalizedAlt 0→1): earthy brown `#8B5A2B` → green `#43A047` → cyan `#039BE5` → sky blue `#29B6F6` → light sky `#4FC3F7`
  - Note: `calculateAltitudeGradient()` exists in shared utils for line-progress gradient but is unused by MapBox; the per-feature approach is used instead

- **3D mode** (Threebox)
  - 2D track layers hidden; track rendered as connected 3D line segments with per-segment altitude color (same ramp as altitude mode)
  - Segment width: 3, opacity: 0.9
  - Vertical drop-lines every ~N points (N = fixes/50): from track altitude to ground, color `#888888`, width 1, opacity 0.3

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

## Visibility Toggles

- **Task visibility** — toggles 7 task layers (cylinder fill/stroke, points, labels, segment labels, line, line arrows)
- **Track visibility** — toggles all track layers (`track-line`, `track-line-outline`, `track-line-gradient`, `highlight-segment`) + 3D objects + event markers (markers hidden via `display: none`); clears highlights when hiding

## Layer Ordering (bottom to top)

1. `task-line` — dashed route line
2. `task-line-arrows` — directional arrows on route
3. `task-cylinders-fill` — turnpoint cylinder fills
4. `task-cylinders-stroke` — turnpoint cylinder strokes
5. `track-line-outline` — black track shadow
6. `track-line` — orange track (flat mode)
7. `track-line-gradient` — altitude-colored track (altitude mode, hidden by default)
8. `highlight-segment` — cyan highlight for selected events
9. `task-points` — turnpoint dots
10. `task-labels` — turnpoint name labels
11. `task-segment-labels` — leg distance labels
12. `threebox-layer` — 3D custom rendering layer (Threebox)

## Style Reload Behaviour

On style change, all custom sources/layers are re-added and current track/task/event data is restored via `restoreData()`. Terrain and sky layer are also re-added on every `style.load` event.
