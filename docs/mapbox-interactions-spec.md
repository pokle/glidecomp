# MapBox Provider — Visual & Interaction Reference

Extracted from `web/frontend/src/analysis/mapbox-provider.ts` and `map-provider-shared.ts`.

## Map Controls

- **Panel toggle** — custom control (top-right, topmost), bar-chart SVG icon plus the text label "Analysis" (label hidden on mobile via `.mapctl-label`), 36px high, fires `onPanelToggleClick` callback
- **Navigation control** — zoom +/-, compass, pitch visualizer (top-right, below panel toggle)
- **Fullscreen control** — toggle button (top-right)
- **Geolocate control** — "fly to where I am" button (top-right, below the navigation control), on EVERY map including `appControls: false` embeds, because the editors are what need it: a brand-new competition has no waypoints, so the map opens on the whole globe. One-shot (`trackUserLocation: false`), high accuracy, and `fitBoundsOptions.maxZoom` 11 — the Mapbox default of 15 lands on the user's street, which is no use for laying out a task. Browser geolocation only: no Mapbox request, no billing, and the button self-disables ("Location not available") without a secure context or permission
- **Scale bar** — max width 200px
- **Compass overlay** (`createCompass()`) — a large 160×160 `/compass.svg` image anchored bottom-right, transformed to match the map view (`rotateZ(-bearing)` plus `rotateX(pitch × 0.8)` under a 300px perspective) and draggable anywhere inside the map container (clamped to it). Analysis-page chrome only: embedded maps (score details) get `appControls: false` and rely on `NavigationControl`'s small built-in compass. Re-created after a style reload.
- **Menu button** — custom control (top-left, topmost), hamburger-icon SVG plus the visible text label "Menu" and a `<kbd>` hint (both hidden on mobile via `.mapctl-label`). The hint is platform-aware: `⌘K` on Mac/iOS, `Ctrl+K` everywhere else. The `title`/`aria-label` is always "Menu (⌘K)". Fires `onMenuButtonClick` callback
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
  - Click targets: the `trackLayers` array — `track-line` and `track-line-outline`

- **Fit bounds** — on track load, map fits to track bounding box with 50px padding, 1s animation

- **Time scrub** (`setTrackScrub(index | null)`, used by the score-details page's scrubber)
  - Clips the 2D track rendering to `fixes[0..index]` and shows a position dot at `index`: 14px circle, GPS-blue `#3b82f6` fill, 2.5px white ring, soft shadow (a DOM marker, so it survives style reloads)
  - Altitude colours stay normalised against the FULL flight's min/max so they don't shift while scrubbing
  - `null` restores the whole track and removes the dot; no-op when no track is loaded
  - Never re-fits bounds and never pans — scrubbing only redraws the line
  - Marker moves are applied immediately; geometry rebuilds are rAF-batched (at most one per frame during a drag)
  - 2D only — 3D mode has its own drone-follow scrubber; `setTrack`/`clearTrack` reset the scrub

## Multi-Track (competition view)

When multiple tracks are loaded (competition mode), single-track layers are hidden and every visible pilot's track renders at once.

- **Track lines** (`multi-track-line` over `multi-track-outline`): one LineString per track, colored by position in the *visible* set via `getRankColor()` — bright orange `#ff8c00` for the leader interpolating to grey `#888888` for last. Outline black, opacity 0.4. Zoom-adaptive widths (line 2–4 px, outline 4–6 px).
- **Pilot name labels** (`multi-track-name-labels`): each pilot's name at their landing point (the detected landing event's fix, else the final fix), so tracks are attributable when the whole field is on screen. Text size 13, anchored left of the point with offset `[0.6, 0]`, colored to match the pilot's track color, white halo 2px. Mapbox symbol collision hides overlapping names until zoomed in.
- **Interactions**: click/tap a track → `onMultiTrackClick(trackIndex, fixIndex)` → HUD with the pilot's name; hover → pointer cursor.
- **Fit bounds** to all tracks with 50px padding, 1s animation.
- In 3D mode, tracks render as Threebox polylines with the same rank colors (no name labels).

## Task

- **Optimized route line**
  - Dashed line: `#f97316` (orange), width 2, dash pattern `[4, 4]`, opacity 0.8
  - Line join/cap: round

- **Directional arrows on route**
  - Canvas-drawn triangle icon 20x20, filled `#f97316`, opacity 0.8
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

- **Exit-turnpoint arrowheads** (issue #347)
  - An inferred exit turnpoint — a cylinder the optimized route reaches
    from inside (`computeTurnpointDirections()` in the engine), crossed by
    flying OUT of it — carries three solid outward-pointing triangles on
    its ring: one anchored at the optimized route's tag bearing (where the
    route crosses the boundary), the others at ±120°
  - Geometry from `exitTurnpointArrowFeatures()` (map-provider-shared):
    apex at `radius + len` from the centre, base on the ring; `len =
    clamp(radius × 0.12, 80 m, 600 m)`
  - Fill: `#a855f7` (purple, the plain-turnpoint color), opacity 0.9
    (mapbox layer `task-exit-arrows`)
  - The declared-EXIT start is NOT decorated — an exit start is the normal
    case on race tasks and is described by the start summary text; the
    arrowheads flag the unusual cylinder only
  - Decorative reinforcement: the authoritative carrier of direction is the
    task turnpoint table (Direction column) on the task page & route editor
  - 3D globe / Threebox providers: out of scope (not drawn)

- **Goal line** (tasks with `goal.type === 'LINE'`, S7F §6.3.1)
  - The last turnpoint's circle is replaced by two features:
    - The goal line itself: `task-goal-line` layer, solid line in the type
      color (purple `#a855f7`), width 4, opacity 0.9, round caps — endpoints
      from the engine's `computeGoalLine()` (perpendicular to the final leg,
      the turnpoint radius to each side)
    - The control semicircle behind the line: a `task-cylinders` polygon
      (same fill/stroke as a cylinder) from `goalSemicirclePoints()`
  - Cylinder goals are unaffected

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
  - Color: `#f97316` (orange), halo: `#eeeeee`, 2px width
  - Content: `"Leg N (X.Xkm)"`

- **Interactions**
  - Click/tap on turnpoint dot → fires `onTurnpointClick` callback with turnpoint index
  - Hover on turnpoint dot → cursor changes to pointer
  - `panToTurnpoint()` → flyTo turnpoint center, keeps current zoom, 1s animation

- **Fit bounds** — if no track loaded, map fits to task turnpoint bounds with 50px padding, 1s animation

## Pickable Waypoint Markers (task route editor)

Loaded from a competition waypoint file (`.wpt` / `.cup` / `.csv`) so the route editor can show turnpoints on the map and let the user pick them. Set via `setWaypoints(waypoints)` / cleared via `clearWaypoints()`; each `MapWaypoint` carries `{ id, code, name, lat, lon }` — `code` is the short label (e.g. `"A01"`), `name` the long descriptive one (e.g. `"BORDANO LANDING"`). Re-applied on style reload (Mapbox `restoreData()`).

- **Marker dots** (`waypoints` layer): circle radius 5, fill slate `#64748b` opacity 0.9, 1.5px white stroke — deliberately secondary to the type-coloured turnpoint dots (radius 6) so a loaded database reads as "available to pick", not "part of the route".
- **Marker labels** (`waypoint-labels` layer): the waypoint **code** (`text-field: ['get', 'code']` — the short form, so a dense database stays readable; the long name is hover/table material), text size 11, offset `[0, 1.1]`, top anchor, colour `#475569`, white halo 1.5px. Shown only at **zoom ≥ 10** so a whole regional database doesn't clutter when zoomed out.
- **Picking (select mode = `view`)**: a map tap picks the **nearest** loaded waypoint within a **44 px** tolerance (a finger width — no exact aim at the small marker, which is what made picking impossible on touch) and fires `onWaypointClick(waypoint)`. A tap with no waypoint inside the tolerance does nothing (you can't accidentally drop a point). The nearest is computed by projecting each waypoint to screen space.
- **Placing a new point (`add-waypoint` mode)**: a tap reports its ground coordinates via `onMapClick(lat, lon, details?)` — the editor opens a dialog to name it, set an altitude, and adjust the coordinates before adding. Crosshair cursor. `details` (`MapPickDetails`) carries best-effort pre-fill context: Mapbox supplies `elevation` (metres AMSL from the terrain DEM, queried `{ exaggerated: false }`; omitted — never 0 — when the DEM tile isn't loaded) and `placeName` (nearest named `Point`-geometry label rendered within **56 px** of the tap; on classic styles these are the streets-v8 source layers `natural_label` / `poi_label` / `place_label` / `airport_label`, on Mapbox-Standard-based styles they're featureset results with no source — app-added layers, which always carry a source id, are excluded; best-effort by design — only labels the current style renders at the current zoom).
- **Snap to peak (`add-waypoint` mode)**: when the nearest label in that same 56 px search is a **peak** (`natural-point`/`landform` — classic `natural_label` points with `class: 'landform'`, or Standard featuresets with `group: 'natural-point'`; towns/POIs contribute names but never snap), `details.peak` carries `{ name, lat, lon, distanceM, elevation?, withinTapPx }` — the summit's own Point geometry, the ground distance tap→summit (engine `andoyerDistance`), the surveyed `elevation_m` where the style has it else the terrain DEM re-read *at the summit*, and whether the label sat within the **44 px** auto-snap tolerance (`PEAK_AUTO_SNAP_RADIUS_PX`, the same finger width as picking). The dialog **auto-snaps** — adopts the summit coordinates + elevation, revertible via a "Use tapped point" link — only when *both* guards pass: `withinTapPx` **and** ground distance ≤ **300 m** (`AUTO_SNAP_MAX_DISTANCE_M`, route-editor's `peakSnapMode`); each covers the other's blind spot (the metre cap stops multi-km snaps 44 px allows when zoomed out; the pixel guard stops snapping a deliberate 200 m-off tap when zoomed in). A peak that clears the 56 px search but fails the auto rule becomes an opt-in **offer** ("Snap to <peak> summit (650 m away)") under the Coordinates field instead. The coordinates field stays a plain editable input — the snap only sets its initial value; typing, or a later table edit, always wins, and nothing commits until Add.
- **Locate from the table**: each waypoint row in the editor has a map-pin button that flies the map to that waypoint's coordinates via `panTo(lat, lon, minZoom)` — it centres the point and zooms in to at least `minZoom` (13) so it's legible, but never zooms further out than the current level. Repeat clicks on the same row re-centre (a bumped key), and it's a no-op while the row's coordinates are invalid.
- **Fit on load**: `fitToWaypoints()` fits the view to the whole set (40 px padding, `maxZoom` 12 so a single point doesn't zoom to the max). The editor calls it whenever a file is loaded, so all the waypoints come into view.
- **Place search** (`RouteMap`'s `placeSearch` prop, `comp/PlaceSearchField.tsx`): a RAC ComboBox in a row **above** the map — not floating over it, because both top corners already carry controls and a popover in normal flow can't be clipped by the container's `overflow-hidden`. Typing a town or region and picking a result flies the view there: `fitToBounds(bounds)` when the geocoder gave the feature an extent (40 px padding, `maxZoom` 12), else `panTo(lat, lon, 10)`. It answers the case the two fits above can't — a competition with no waypoints yet, whose map therefore opens on the whole globe. Off by default and passed only on editing surfaces (the route editor; the waypoints page for admins), because each search is a billed Geocoding request; see `react/lib/geocode.ts` for the API choice, the 300 ms debounce, and the temporary-tier rule that keeps a result on the camera and out of any record.

## Open Distance Line

Shown for open-distance tasks (single TAKEOFF turnpoint): one line per visible pilot from the point they exit the take-off cylinder to the furthest fix they reached — the geometry of the scored distance.

- **Line** (`open-distance-line` layer): `#f97316` (orange), width 2, dash `[4, 4]`, opacity 0.8 — same style as the task route line
- **Distance label** (`open-distance-labels` layer): the scored distance (e.g. `"42.3 km"`), placed along the line (`symbol-placement: line-center`, offset `[0, -0.8]`), text size 16, color `#f97316`, halo `#eeeeee` 2px
- Pilots who never leave the take-off cylinder score 0 and have no line
- Set via `setOpenDistanceLines(lines)` / cleared via `clearOpenDistanceLines()`; re-applied on style reload
- With multiple pilots selected, one line + label is drawn per selected pilot (Mapbox symbol collision hides overlapping labels)

## Best-Progress Route (landed-out distance to goal)

A landed-out pilot's routed remaining distance, drawn on the report card's map (`ScoreDetailMap`) so the "measured along the task, X km short of goal" wording is visible rather than implied by a lone pin. The polyline runs from the pilot's best-progress point, through each un-reached turnpoint's optimal tag point, to goal.

- Set via `setBestProgressRoute(route)` / cleared via `clearBestProgressRoute()`; `BestProgressRoute` carries `coords` (ordered `{ lat, lon }` vertices) and `distanceToGoal` (metres). Fewer than two vertices renders nothing. Re-applied on style reload
- **Line** (`best-progress-route-line` layer): solid amber `#f59e0b`, width 2.5, opacity 0.9, round join/cap — solid and amber so it reads as distinct from the dashed orange task line it runs alongside
- **Label** (`best-progress-route-label` layer): `"X.X km short of goal"`, placed along the line (`symbol-placement: line-center`, offset `[0, -0.8]`), text size 15, colour `#b45309`, white halo 2px

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
  - Chevron markers along segment, one per **display distance unit** — the spacing is `getSegmentLengthMeters(config.getUnits().distance)`, so 1000 m under `km`, 1609.344 m under `mi`, 1852 m under `nmi`. It is not a fixed 1 km
    - SVG 20x12: single `<path>` chevron, stroke `#3b82f6`, stroke-width 3, rounded caps/joins, rotated to bearing
  - Speed labels between chevrons
    - Font: `'Atkinson Hyperlegible Next', sans-serif`, 20px, weight 600
    - Colour `#333` — the **label** is dark grey, not blue. Only the chevrons are `#3b82f6`. (The speed overlay's fastest label is the one exception; see "Speed Overlay" below)
    - White glow outline: `GLIDE_LABEL_TEXT_SHADOW` in `map-provider-shared.ts` — four *stacked blurred* shadows, not a 4-direction 1px offset outline: three at `0 0 4px rgba(255,255,255,0.9)` plus one at `0 0 6px rgba(255,255,255,0.9)`
    - Content: speed (formatted), glide ratio (`↘N:1`), altitude change, required glide ratio to next turnpoint (`↘N:1 to NAME`)
    - Line-height: 1.3, centered, no-wrap
    - Zoom-dependent visibility (`GLIDE_LABEL_*_MIN_ZOOM` in `map-provider-shared.ts`):
      - Below zoom 10 (`GLIDE_LABEL_SPARSE_MIN_ZOOM`): hidden entirely
      - Zoom 10–11: sparse — only every 3rd label is drawn (`isSparseHidden`); the fastest glide is exempt and always shown
      - Zoom 11–13 (`GLIDE_LABEL_SPEED_MIN_ZOOM`): every label, speed + altitude change only
      - Zoom 13+ (`GLIDE_LABEL_DETAILS_MIN_ZOOM`): speed + glide ratio + altitude change + required GR (if applicable)
  - Glide legend `?` button appears (bottom of map container)
  - **Screen-space collision detection** — labels are projected to screen coordinates and hidden if they overlap higher-priority labels:
    - Priority: fastest glide first, then by original index (earlier in flight = higher priority)
    - Label bounding boxes are zoom-dependent, on the same `GLIDE_LABEL_DETAILS_MIN_ZOOM` threshold as the text: 160×30px compact (zoom <13), 180×65px detail (zoom ≥13), with 10px horizontal / 6px vertical padding
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

  The averaging window is a **fixed 1000 m** whatever the display units — unlike
  the glide chevrons, whose spacing follows the distance unit. Only the group's
  heading converts: it reads `${formatRadius(1000).withUnit} avg`, so the same
  1000 m window is titled "1km avg", "0.6mi avg" or "0.5NM avg".

- **Data computation** (`buildTrackPointHUDData`)
  - Uses `calculatePointMetrics()` with a 1000 m averaging window
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
- **The fastest label is the odd one out.** For that one marker the chevron stroke AND the label colour are both `FASTEST_COLOR` `#ef4444`, its speed text gains a `" (fastest)"` suffix, and its marker element is given `z-index: 1` so it wins the stacking order against neighbouring labels. Every other marker uses `NORMAL_COLOR` `#3b82f6` for the chevron and `#333` for the label text — the same pair as the event-highlight glide labels
- The fastest label also carries `data-fastest="true"`, which exempts it from the zoom 10–11 sparse-hiding rule and gives it top priority in the collision sort

## Visibility Toggles

- **Task visibility** — toggles 9 task layers (cylinder fill/stroke, exit arrows, goal line, points, labels, segment labels, line, line arrows)
- **Track visibility** — toggles all track layers (`track-line`, `track-line-outline`, `highlight-segment`) + 3D objects + event markers and the time-scrub position dot (markers hidden via `display: none`); clears highlights when hiding

## Layer Ordering (bottom to top)

1. `task-line` — dashed route line
2. `task-line-arrows` — directional arrows on route
3. `task-cylinders-fill` — turnpoint cylinder fills
4. `task-cylinders-stroke` — turnpoint cylinder strokes
5. `task-exit-arrows` — outward arrowheads on exit-turnpoint rings
6. `task-goal-line` — goal line (LINE goals only)
7. `track-line-outline` — black track shadow
8. `track-line` — altitude-colored track
9. `multi-track-outline` — black shadow behind every pilot's track (competition view)
10. `multi-track-line` — rank-colored per-pilot tracks (competition view)
11. `highlight-segment` — cyan highlight for selected events
12. `speed-fastest-segment` — red overlay for fastest speed segment
13. `task-points` — turnpoint dots
14. `task-labels` — turnpoint name labels
15. `waypoints` — pickable waypoint marker dots (route editor)
16. `waypoint-labels` — pickable waypoint code labels (route editor, zoom ≥ 10)
17. `task-segment-labels` — leg distance labels
18. `open-distance-line` — dashed scored open-distance line per pilot
19. `open-distance-labels` — distance label along each open-distance line
20. `best-progress-route-line` — solid amber routed line from the best-progress point to goal
21. `best-progress-route-label` — remaining-distance label along that line
22. `multi-track-name-labels` — pilot name at each track's landing point
23. `annotation-strokes-layer` — committed annotation strokes
24. `annotation-live-layer` — in-progress annotation stroke preview
25. `threebox-layer` — 3D custom rendering layer (Threebox)

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

## 3D Multi-Track Scrubber (competition view)

`createMultiTrackScrubber()` replaces the single-track altitude scrubber when
`setMultiTrack()` runs **while 3D mode is already on** (`is3DMode && tb`) — it is
the field-wide equivalent of the drone-follow scrubber, and answers "who was where
at the same point in their own race". Entering 3D later does not build it; the
tracks must be (re-)set in 3D.

- **Overlay** — full-width strip pinned to the bottom of the map container, height
  **15%**, background `rgba(0,0,0,0.65)`, `z-index: 10`, crosshair cursor,
  `touch-action: none`. A 40px y-axis gutter on the left and a 16px x-axis strip at
  the bottom frame the chart area. The track-point HUD is pushed up to
  `calc(15% + 40px)` so the two don't overlap
- **Every pilot on one chart** — a single SVG (`viewBox="0 0 1000 100"`,
  `preserveAspectRatio="none"`) carries one `<path>` per loaded track: the pilot's
  whole altitude profile, stroke-width 1.5 with `vector-effect: non-scaling-stroke`,
  opacity 0.85, coloured by position in the *visible* set via `getRankColor()` (the
  same ramp as the 2D multi-track lines). Altitudes are normalised against the
  **global** min/max across all tracks, so the profiles are directly comparable
- **Aligned by the start, not by the clock** — each track's x origin is that pilot's
  **SSS crossing time** (`turnpointResult.sssReaching`, matched to the track by
  pilot name), falling back to the pilot's first fix when there is no SSS crossing.
  The x extent is the longest of those elapsed durations, so a pilot who started
  late is not pushed off to the right — everyone's race begins at x = 0
- **Position indicator** — a 2px full-height bar, `#ff8c00` (the same orange as the
  leader's rank colour), `pointer-events: none`
- **Scrubbing** — `pointerdown` on the chart area captures the pointer and scrubs;
  `pointermove` while held keeps scrubbing; `pointerup` releases. The x position is
  clamped to 0–1 of the chart width and read as a fraction of the maximum duration
- **Top-3 rank labels** — a `pointer-events: none` container (`#multi-scrubber-labels`,
  80px tall, sitting immediately above the strip, `z-index: 11`) redrawn on every
  scrub. For each of the first three `PilotScore` entries it finds that pilot's fix
  nearest to `startTime + fraction × maxDuration` and places `"1. Name"` at the fix's
  **projected screen x**, centred, 11px, white, with a `0 1px 3px rgba(0,0,0,0.8)`
  text-shadow
- **Per-pilot 3D position markers** — for those same top three, a short Threebox
  vertical line is added at the fix (from the fix altitude to +50 m, both scaled by
  `TERRAIN_EXAGGERATION`), width 8, opacity 1, coloured by rank via `getRankColor()`.
  They are pushed onto `multiTrack3DObjects` beside the track polylines, so they go
  away with `clearMulti3DTracks()` — on the next `renderMulti3DTracks()` or
  `clearMultiTrack()`. (The label container is emptied on every scrub; the 3D markers
  are not, despite the code comment saying they are)

## Annotation Overlay

Freehand drawing overlay for scrawling on the map. Strokes are geo-anchored (persist through pan/zoom/pitch/bearing) and stored server-side in D1. Rendered as native Mapbox GeoJSON line layers so they sit flat on the map surface (including terrain).

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
  - Buttons: Draw (D), Erase (E), Undo, Redo, Clear All (red trash icon), Close (✕ with a small "esc" hint, `title="Close (Esc)"`) — thin separators between the groups
  - Active tool highlighted with `#e8e8e8` background
  - Appears/disappears with annotation mode toggle

- **Map interaction** — when annotation mode is active, `dragPan`, `scrollZoom`, `doubleClickZoom`, `dragRotate`, `touchZoomRotate`, and `keyboard` are disabled; re-enabled on deactivation

- **Keyboard shortcuts** (Excalidraw-compatible)
  | Action | Shortcut |
  |--------|----------|
  | Toggle annotation mode | `D` |
  | Switch to eraser | `E` |
  | Exit annotation mode | `Escape` or `V` |
  | Undo | `Cmd/Ctrl+Z` (annotation mode only) |
  | Redo | `Cmd/Ctrl+Shift+Z` or `Cmd/Ctrl+Y` (annotation mode only) |
  | Clear all | `Cmd/Ctrl+Shift+Delete` (annotation mode only) |

- **Persistence** — strokes are scoped to a (user, track) pair and stored in **D1 via the API**, not in the browser: `map-annotations.ts` calls `storage.storeAnnotation` / `listAnnotations` / `deleteAnnotation` / `clearAnnotations`, which are HTTP calls to `/api/user/tracks/:id/annotations` (read-only `/api/u/:username/track/:id/annotations` in public-link mode, where writes are no-ops). Loaded on map initialization; anonymous or track-less sessions persist nothing. See `docs/browser-storage-spec.md` for the superseded IndexedDB design

- **Command palette** — "Annotate Map" item in Display Options group, toggles annotation mode, shows `(on)/(off) D` status

## Style Reload Behaviour

On style change, all custom sources/layers are re-added and current track/task/event data is restored via `restoreData()` (including an active time-scrub clip, re-applied after `setTrack`). Terrain and sky layer are also re-added on every `style.load` event.
