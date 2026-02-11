# macOS Event UI Fix Plan

The macOS event sidebar (EventListView) does not match the glide-detection-spec or the web reference implementation (`pages/src/analysis/event-panel.ts`). The three specialized tabs (Glides, Climbs, Sinks) use a generic event row instead of combined segment cards with detailed statistics, and the Sinks filter is fundamentally broken.

## Files to change

| File | What changes |
|------|-------------|
| `Views/EventListView.swift` | Replace generic list with tab-specific segment views |
| `Views/ContentView.swift` | Rework `FlightViewModel` to expose segment data models instead of filtered event arrays |
| `Models/FlightEvent.swift` | Add `GlideData`, `ClimbData`, `SinkData` view-model structs |

No changes needed to `Analysis/EventDetector.swift` — the detection logic is correct; the problem is entirely in how the UI consumes and displays the detected events.

## Step 1 — Add segment data models to `FlightEvent.swift`

Add three structs that mirror the web's `GlideData`, `ClimbData`, and `SinkData` interfaces. These combine paired events into a single display object with all the stats.

```swift
/// Combined glide segment for the Glides tab
public struct GlideData: Identifiable, Hashable {
    public let id: String
    public let startTime: Date
    public let endTime: Date
    public let startAltitude: Double
    public let endAltitude: Double
    public let distance: Double      // meters (path distance)
    public let duration: Double      // seconds
    public let averageSpeed: Double  // m/s
    public let glideRatio: Double    // L/D
    public let altitudeLost: Double  // meters
    public let segment: TrackSegment
    public let sourceEvent: FlightEvent
}

/// Combined thermal/climb segment for the Climbs tab
public struct ClimbData: Identifiable, Hashable {
    public let id: String
    public let startTime: Date
    public let endTime: Date
    public let startAltitude: Double
    public let endAltitude: Double
    public let altitudeGain: Double   // meters
    public let duration: Double       // seconds
    public let avgClimbRate: Double   // m/s
    public let segment: TrackSegment
    public let sourceEvent: FlightEvent
}

/// Sink segment for the Sinks tab (glides with L/D ≤ 5:1)
public struct SinkData: Identifiable, Hashable {
    public let id: String
    public let startTime: Date
    public let endTime: Date
    public let startAltitude: Double
    public let endAltitude: Double
    public let altitudeLost: Double    // meters
    public let distance: Double        // meters
    public let duration: Double        // seconds
    public let averageSpeed: Double    // m/s
    public let avgSinkRate: Double     // m/s (altitudeLost / duration)
    public let glideRatio: Double      // L/D
    public let segment: TrackSegment
    public let sourceEvent: FlightEvent
}
```

## Step 2 — Add extraction methods to `FlightViewModel` in `ContentView.swift`

Add three computed properties that extract and sort segment data from the raw events, matching the web logic exactly.

### `extractGlides() -> [GlideData]`

- Iterate `events` looking for `glide_start` events that have `segment` and `details`
- For each, find matching `glide_end` with same segment indices
- Read `distance`, `glideRatio`, `duration`, `averageSpeed` from `details` dictionary
- Compute `altitudeLost = startAltitude - endAltitude`
- **Sort by distance, longest first**

### `extractClimbs() -> [ClimbData]`

- Iterate `events` looking for `thermal_entry` events that have `segment` and `details`
- For each, find matching `thermal_exit` with same segment indices
- Read `avgClimbRate`, `duration`, `altitudeGain` from `details`
- **Sort by altitude gain, highest first**

### `extractSinks() -> [SinkData]`

This is the critical fix. Currently uses `events.filter { $0.type == .maxSink }` which is completely wrong.

- Iterate `events` looking for `glide_start` events with `segment` and `details`
- Read `glideRatio` from `details`
- **Filter: only include if `glideRatio <= 5`** (L/D of 5:1 or worse)
- For each, find matching `glide_end` with same segment indices
- Compute `altitudeLost = startAltitude - endAltitude`
- Compute `avgSinkRate = altitudeLost / duration`
- **Sort by altitude lost, deepest first**

### Update `filteredEvents(for:)` for the All tab

Keep the existing behavior for `.all` — return all events sorted by time. The other cases will no longer be used by EventListView since it will call the extraction methods directly.

## Step 3 — Rewrite `EventListView.swift` with tab-specific views

Replace the current single-view-fits-all design. The `EventListView` body should switch on `filter` and render a different view per tab.

### Structure

```swift
struct EventListView: View {
    let events: [FlightEvent]
    let glides: [GlideData]
    let climbs: [ClimbData]
    let sinks: [SinkData]
    @Binding var selectedEvent: FlightEvent?
    @Binding var filter: EventFilter

    var body: some View {
        VStack(spacing: 0) {
            // Segmented picker (existing)
            Picker("Filter", selection: $filter) { ... }

            // Count label
            Text(countLabel)

            // Tab content
            switch filter {
            case .all:    AllEventsListView(events: events, selectedEvent: $selectedEvent)
            case .glides: GlideListView(glides: glides, selectedEvent: $selectedEvent)
            case .climbs: ClimbListView(climbs: climbs, selectedEvent: $selectedEvent)
            case .sinks:  SinkListView(sinks: sinks, selectedEvent: $selectedEvent)
            }
        }
    }
}
```

### `AllEventsListView` — keep existing `EventRowView`

No changes needed. Shows the generic timeline of all events with colored dot, description, time, altitude.

### `GlideListView` — new view

Each row shows one combined glide segment:

```
#1
 3.2 km                     10:23:45 → 10:28:12
 L/D 18.2:1  Spd 42 km/h  Alt -176m  Dur 4:27
 1,823m → 1,647m
```

- Rank number on the left
- Distance as the primary metric (bold)
- Time range
- Stats row: L/D, speed, altitude lost (prefixed with `-`), duration
- Altitude range row (start → end)
- Sort description header: "Sorted by distance (longest first)"

### `ClimbListView` — new view

Each row shows one combined thermal:

```
#1
 +423m                      10:15:00 → 10:22:30
 Avg +2.1 m/s  Dur 7:30
 1,400m → 1,823m
```

- Rank number
- Altitude gain as primary metric (bold, prefixed with `+`)
- Time range
- Stats: average climb rate, duration
- Altitude range
- Sort description header: "Sorted by altitude gain (highest first)"

### `SinkListView` — new view

Each row shows one sink (filtered glide):

```
#1
 -312m                      10:28:12 → 10:33:45
 L/D 2.8:1  Avg -1.8 m/s  Dist 0.9 km  Spd 31 km/h  Dur 2:49
 1,647m → 1,335m
```

- Rank number
- Altitude lost as primary metric (bold, prefixed with `-`)
- Time range
- Stats: L/D, average sink rate, distance, speed, duration
- Altitude range
- Sort description header: "Glides with L/D ≤ 5:1, sorted by altitude lost"

## Step 4 — Wire up ContentView

Update `ContentView` to pass the extracted segment data to `EventListView`:

```swift
EventListView(
    events: viewModel.events,
    glides: viewModel.extractGlides(),
    climbs: viewModel.extractClimbs(),
    sinks: viewModel.extractSinks(),
    selectedEvent: $selectedEvent,
    filter: $eventFilter
)
```

The `filteredEvents(for:)` method on FlightViewModel is no longer needed for the sidebar — it can be kept if used elsewhere, or removed.

## Step 5 — Selection and segment highlighting

When a user taps a glide/climb/sink row, set `selectedEvent` to the row's `sourceEvent`. This preserves the existing `MapView` segment highlighting behavior — the map already knows how to highlight a segment when `selectedEvent` has a `.segment`.

No changes needed to `MapView.swift`.

## Formatting helpers

Add a small formatting utility (either in `EventListView.swift` or a separate file) for:
- `formatDuration(_ seconds: Double) -> String` — `"m:ss"` format
- `formatAltitude(_ meters: Double) -> String` — `"1,234m"` with grouping
- `formatDistance(_ meters: Double) -> String` — `"3.2 km"` or `"850m"` depending on magnitude
- `formatSpeed(_ mps: Double) -> String` — `"42 km/h"`
- `formatClimbRate(_ mps: Double) -> String` — `"+2.1 m/s"` or `"-1.8 m/s"`
- `formatGlideRatio(_ ratio: Double) -> String` — `"18.2:1"` or `"∞:1"` for infinity

## Edge cases to handle

1. **Infinity glide ratio** — When a glide gains altitude, `glideRatio` is `Double.infinity`. Display as `"∞:1"` in Glides tab. These should never appear in Sinks tab (since `infinity > 5`).
2. **Zero duration** — Guard against division by zero when computing `avgSinkRate`.
3. **Empty states** — Each tab should show an appropriate empty message:
   - Glides: "No glides detected"
   - Climbs: "No thermals detected"
   - Sinks: "No descents detected"
   - Or "Load an IGC file to see {glides|climbs|sinks}" if no flight loaded.

## Verification

After implementation, verify against the spec (`docs/events/glide-detection-spec.md`):

- [ ] Sinks are glides with L/D ≤ 5:1, not `max_sink` events
- [ ] Sinks sorted by altitude lost (deepest first)
- [ ] Sinks compute and display `avgSinkRate`
- [ ] Glides sorted by distance (longest first)
- [ ] Glides show: distance, L/D, speed, altitude lost, duration, altitude range
- [ ] Climbs sorted by altitude gain (highest first)
- [ ] Climbs show: altitude gain, avg climb rate, duration, altitude range
- [ ] Each tab shows rank numbers (#1, #2, ...)
- [ ] Each tab shows sort description header
- [ ] Ascending glides show "∞:1" for L/D and never appear in Sinks
- [ ] Selecting a row highlights the segment on the map
