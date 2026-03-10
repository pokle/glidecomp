# Glide Detection Algorithm

Specification for glide detection and sink classification in `web/engine/src/event-detector.ts`, with downstream visualization in `web/engine/src/glide-speed.ts` and `web/frontend/src/analysis/event-panel.ts`.

## Overview

Glides are the segments of flight **between thermals**. Rather than detecting glides independently, the algorithm defines them as the gaps left over after thermal detection. This means thermal boundaries directly determine glide boundaries.

Glides serve three purposes in the UI:
- **Glides tab** — all glides ranked by distance (longest first)
- **Sinks tab** — subset of glides with poor L/D (5:1 or worse), ranked by altitude lost
- **Map visualization** — chevrons and per-kilometer speed/L:D labels along the selected glide

## Algorithm

### Detection (`detectGlides`)

The function takes the flight fixes array and the array of detected thermals (see `thermal-detection-spec.md` in this directory).

**Steps:**

1. Sort thermals by `startIndex`.
2. Initialize `prevEnd = 0` (start of flight data, i.e. takeoff).
3. For each thermal, check the gap from `prevEnd` to `thermal.startIndex`:
   - If the gap is more than 10 fixes, create a candidate glide.
   - The glide spans from `prevEnd` to `thermal.startIndex - 1` (the `-1` avoids timestamp overlap with the thermal entry).
4. After processing, set `prevEnd = thermal.endIndex` for the next iteration.

```
Flight track:  [takeoff]---glide 1---[thermal 1]---glide 2---[thermal 2]---???
Indices:        0          prevEnd    startIndex    endIndex   startIndex    endIndex → end
```

### Filters

| Filter | Value | Rationale |
|--------|-------|-----------|
| Minimum gap | 10 fixes | Gaps smaller than this are too short to be meaningful glides — likely just a brief transition between thermals. |
| Minimum duration | 30 seconds | Filters noise. A pilot needs at least half a minute of straight flight for the glide statistics to be meaningful. |

### Statistics

For each accepted glide:

| Statistic | Calculation |
|-----------|-------------|
| `startIndex` / `endIndex` | Fix indices defining the segment |
| `startAltitude` / `endAltitude` | GNSS altitude at boundary fixes |
| `distance` | Sum of haversine distances between consecutive fixes (path distance, not straight line) |
| `glideRatio` | `distance / altitudeLoss` where `altitudeLoss = startAltitude - endAltitude`. Set to `Infinity` if the pilot gained altitude or stayed level. |
| `duration` | Time from start to end fix (seconds) |

### Event Generation

Each glide produces two `FlightEvent` entries:

- **`glide_start`** — positioned at the glide's start fix, carries all statistics in `details` (distance, glideRatio, duration, averageSpeed) and the segment indices.
- **`glide_end`** — positioned at the glide's end fix, carries the same segment reference.

Both events share the same `segment` object, enabling segment highlighting on the map when either is selected.

## Downstream: Sink Classification

Sinks are not separately detected — they are glides filtered by poor glide ratio in the event panel (`event-panel.ts`).

**Criteria:** A glide qualifies as a sink if `glideRatio <= 5` (L/D of 5:1 or worse).

**Additional statistics computed for sinks:**
- `avgSinkRate` — `altitudeLost / duration` (m/s)

**Sorting:** Sinks are sorted by altitude lost (deepest first), not by L/D ratio.

**Tab routing:** When a user clicks on the track within a glide segment, the panel checks `glideRatio` to decide whether to open the Glides tab or the Sinks tab.

## Downstream: Map Visualization (`glide-speed.ts`)

When a glide is selected, the map shows chevrons and speed labels along the path.

### Layout

Positions are calculated at 1km intervals along the glide path using linear interpolation between fixes. Labels and chevrons alternate at each 1km boundary:

| Distance | Marker Type | Content |
|----------|-------------|---------|
| 1km | Speed label | Average speed, L/D, and altitude change for the 0–2km segment |
| 2km | Chevron | Flight direction indicator |
| 3km | Speed label | Stats for the 2–4km segment |
| 4km | Chevron | |
| ... | alternating | |

**Speed labels** show three metrics for each 1km segment:
- Speed in the user's configured units
- L/D ratio for that segment (only shown when descending)
- Altitude change in meters

**Chevrons** are rotated to match the local flight bearing at that point.

### Interpolation

Positions between fixes are linearly interpolated for lat, lon, altitude, and time. The algorithm handles:
- Variable fix rates (positions are based on distance, not fix count)
- Short glides (fewer markers, partial final segment)
- Floating point precision at exact distance boundaries (0.1m epsilon)

## Boundary Interactions

### Thermal → Glide Boundary

The glide starts at `thermal.endIndex` (the previous thermal's end) and ends at `thermal.startIndex - 1` (one fix before the next thermal starts). This design:

- **Avoids overlap:** No fix belongs to both a thermal and a glide.
- **Preserves continuity:** The altitude at the glide start matches the thermal exit altitude, giving consistent altitude-lost calculations.

### First Glide

The first glide starts at index 0 of the flight fixes array (the takeoff point). If the pilot enters a thermal immediately after takeoff (within 10 fixes), no initial glide is created.

### Trailing Glide

After the loop processes all thermals, the algorithm creates a final glide from the last thermal's `endIndex` to the end of the flight track (the last fix). The same minimum gap (10 fixes) and minimum duration (30 seconds) filters apply.

This ensures:
- The final glide to landing is shown in the Glides and Sinks tabs.
- The track segment after the last thermal is selectable as a glide on the map.

### No-Thermal Flights

If no thermals are detected (e.g., a sled ride), `prevEnd` remains at 0 and the trailing glide logic creates a single glide spanning the entire flight from the first to the last fix. The flight appears as one glide segment with full statistics (distance, L/D, duration).

## Edge Cases

### Ascending Glides

If the pilot gains altitude during a "glide" (flying through lift without circling), `altitudeLoss` is zero or negative, and `glideRatio` is set to `Infinity`. These segments:
- Appear in the Glides tab with "∞:1" displayed for L/D
- Never appear in the Sinks tab (since `Infinity > 5`)
- Have valid distance and duration stats

### Short Gaps Between Thermals

Gaps of 10 or fewer fixes between thermals are silently dropped. These typically occur when the pilot briefly straightens out between thermal turns. The gap is too short to compute meaningful glide statistics.

### Overlapping Concerns with Thermal Detection

Since glide boundaries depend entirely on thermal boundaries:
- If thermal detection is too aggressive (detecting thermals in straight climbs), glides will be artificially shortened.
- If thermal detection misses a real thermal, the "glide" will include circling segments, inflating its distance and degrading its L/D ratio.
- The known "climbing glide" issue (see `thermal-detection-spec.md` in this directory) creates segments that are neither thermal nor glide.

## Known Limitations

1. **Path distance vs. straight-line distance** — glide distance is the sum of fix-to-fix haversine distances (the path walked), not the straight-line distance. For straight glides these are nearly equal, but for glides with course changes the path distance will be longer.
2. **L/D uses path distance** — the glide ratio uses path distance in the numerator. This slightly overstates L/D compared to the straight-line convention, especially for glides with significant course changes.
3. **No wind correction** — glide performance is over the ground, not through the air. A glide into headwind will show a worse L/D than the same glide with a tailwind, even though the glider's aerodynamic performance is identical.
