# MapBox Provider — Visual & Interaction Reference

Extracted from `web/frontend/src/analysis/mapbox-provider.ts` and `map-provider-shared.ts`.

## Map Controls

- **Navigation control** — zoom +/-, compass, pitch visualizer (top-right default)
- **Scale bar** — max width 200px
- **Fullscreen control** — toggle button
- **Style selector** — `<select>` dropdown (top-left), font 12px, white background, text `#1e293b`. Options: Outdoors (default custom style), Satellite, Streets, Light, Dark
- **Map location** — center, zoom, pitch, bearing persisted to localStorage (debounced 5s after moveend). Restored on next load. Default pitch 45, max pitch 85

## Terrain & Atmosphere

- **3D terrain** — Mapbox DEM source, exaggeration 1.5, added on every style load
- **Sky layer** — atmosphere type, sun at `[0, 90]`, intensity 15

## Flight Track

- **Flat-color mode** (default)
  - Solid line: `#f97316` (bright orange), opacity 0.95
  - Black outline behind: `#000000`, opacity 0.6
  - Both lines zoom-adaptive width (width_mul 0.7): zoom 3 → 5.6/4 px inner, zoom 8 → 4.2/8.4 px, zoom 12 → 4.2/7 px
  - Line join/cap: round
  - Source tolerance 0.1 (minimal simplification)

- **Altitude-color mode**
  - Gradient along line-progress, replaces flat-color line (outline remains)
  - Same zoom-adaptive width as flat mode
  - Colour ramp (normalized 0→1): earthy brown `#8B5A2B` → green `#43A047` → cyan `#039BE5` → sky blue `#29B6F6` → light sky `#4FC3F7`
  - ~100 sampled gradient stops max

- **3D mode** (Threebox)
  - 2D track layers hidden; track rendered as connected 3D line segments with per-segment altitude color (same ramp as altitude mode)
  - Segment width: 3, opacity: 0.9
  - Vertical drop-lines every ~N points (N = fixes/50): from track altitude to ground, color `#888888`, width 1, opacity 0.3

- **Interactions**
  - Click/tap on track → fires `onTrackClick` callback with nearest fix index
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
  - Rendered as 64-point polygons via `getCirclePoints()`

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
  - Text size: 20, rotated to follow leg bearing (normalized so never upside-down)
  - Color: `#6366f1` (indigo), halo: `#eeeeee`, 2px width
  - Content: `"Leg N (X.Xkm)"`

- **Interactions**
  - Click/tap on turnpoint dot → fires `onTurnpointClick` callback with turnpoint index
  - Hover on turnpoint dot → cursor changes to pointer
  - `panToTurnpoint()` → flyTo turnpoint center, keeps current zoom, 1s animation

- **Fit bounds** — if no track loaded, map fits to task turnpoint bounds with 50px padding, 1s animation

## Event Markers

- Shown only for key event types: takeoff, landing, start_crossing, goal_crossing, max_altitude, turnpoint_entry
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
| max_altitude | `#06b6d4` (cyan) |
| min_altitude | `#64748b` (slate) |
| max_climb | `#22c55e` (green) |
| max_sink | `#ef4444` (red) |
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
    - Font: `'Atkinson Hyperlegible Next', sans-serif`, 16px, weight 600, color `#3b82f6`
    - White text-shadow outline (4-direction 1px)
    - Content: speed (formatted), glide ratio (`N:1`), altitude change
    - Line-height: 1.3, centered, no-wrap
    - Zoom-dependent visibility:
      - Below zoom 11: hidden entirely
      - Zoom 11–13: speed only
      - Zoom 13+: speed + glide ratio + altitude change
  - Glide legend `?` button appears (bottom of map container)

- **Pan** — `flyTo` event location, maintains current zoom, 1s duration (skippable via `skipPan` option)

## Visibility Toggles

- **Task visibility** — toggles all 6 task layers (line, arrows, cylinder fill/stroke, points, labels, segment labels)
- **Track visibility** — toggles all track layers + 3D objects + event markers (markers hidden via `display: none`); clears highlights when hiding
