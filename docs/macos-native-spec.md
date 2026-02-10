# macOS Native App — Plan

## Motivation

TaskScore currently runs as a Cloudflare Pages web app. A native macOS app would provide:

- **Native file handling**: Open IGC files via Finder, double-click to open, drag-and-drop from Finder, Spotlight integration
- **Offline-first**: Full functionality without internet (except map tiles and AirScore lookups)
- **Performance**: Native rendering for maps and 3D visualization
- **OS integration**: Menu bar, keyboard shortcuts, document model, Handoff, iCloud sync
- **Distribution**: Mac App Store or direct download with notarization

## Repository Structure (Monorepo)

The macOS app lives alongside the existing web project in a single repository. This keeps shared test fixtures, specs, and sample data in one place while maintaining clean separation of toolchains.

```
taskscore/
├── pages/                      # (existing) Web frontend
├── packages/analysis/          # (existing) TS analysis engine
├── workers/                    # (existing) Cloudflare Workers
├── macos/                      # NEW — Xcode project
│   ├── TaskScore.xcodeproj
│   ├── TaskScore/
│   │   ├── TaskScoreApp.swift
│   │   ├── Analysis/           # Swift port of packages/analysis
│   │   ├── Models/
│   │   ├── Views/
│   │   └── Services/
│   └── TaskScoreTests/
├── tests/
│   └── fixtures/               # Shared test IGC files + expected outputs
├── docs/                       # (existing) Shared specs
├── scripts/                    # (existing)
└── .github/workflows/
    ├── web.yml                 # (existing, add path filter)
    └── macos.yml               # NEW — Xcode build + test
```

**CI path filters** ensure the right pipeline runs for the right changes:

```yaml
# .github/workflows/web.yml
on:
  push:
    paths: ['pages/**', 'workers/**', 'packages/**']

# .github/workflows/macos.yml
on:
  push:
    paths: ['macos/**', 'tests/fixtures/**']
```

Changes to shared test fixtures trigger both pipelines — which is exactly the desired behavior, since both parsers must agree on the same inputs.

## Technology Choice: SwiftUI + MapKit

**Recommended stack:**

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| UI Framework | SwiftUI | Modern, declarative, good for sidebar+detail layout |
| Map | MapKit | Native Apple maps, 3D globe, no API key needed, free |
| 3D Rendering | SceneKit (via MapKit) | Native 3D for track visualization |
| Networking | URLSession | Native async/await HTTP |
| Storage | Files in `~/Documents/TaskScore/` | Transparent, offline-first, Finder-browsable |
| Preferences | UserDefaults / @AppStorage | Native settings persistence |
| File Handling | UTType + DocumentGroup | Native document model for IGC + XCTask files |
| Geo Math | CoreLocation + native Swift | CLLocation distance/bearing calculations |
| Testing | XCTest + Swift Testing | Native test frameworks |

**Why not cross-platform (Electron, Tauri, React Native)?**
- The web version already exists for cross-platform access
- A native app should *feel* native — SwiftUI provides this with far less effort
- MapKit is free and integrates perfectly; MapBox native SDK requires a paid plan for mobile/desktop
- No runtime overhead (Electron bundles Chromium; Tauri uses system webview but adds Rust runtime)

**Why not reuse the TypeScript analysis code via JavaScriptCore?**
- The analysis package is ~2,700 lines — manageable to port to Swift
- Swift's type system catches errors the TypeScript code works around
- CoreLocation provides geographic calculations natively
- Eliminates JS↔Swift bridging complexity and debugging difficulty
- Port is a one-time cost; maintenance benefits are ongoing

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  SwiftUI App                     │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Sidebar  │  │ MapView  │  │  Inspector    │  │
│  │          │  │ (MapKit) │  │  (Detail)     │  │
│  │ Events   │  │          │  │               │  │
│  │ Glides   │  │ Track    │  │  Event info   │  │
│  │ Climbs   │  │ Task     │  │  Statistics   │  │
│  │ Sinks    │  │ Markers  │  │  Units config │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │           Analysis Engine (Swift)         │    │
│  │  IGCParser · XCTaskParser · EventDetector │    │
│  │  GlideSpeed · Geo · Units                 │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │           File Layer                      │    │
│  │  ~/Documents/TaskScore/{Tracks,Tasks}/    │    │
│  │  .igc files · .xctsk files                │    │
│  │  NSDocument + File > Open Recent          │    │
│  └──────────────────────────────────────────┘    │
│                                                  │
│  ┌──────────────────────────────────────────┐    │
│  │           Network Layer                   │    │
│  │  AirScoreClient · XContestClient          │    │
│  │  Download → save to file → then open      │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### App Structure (Swift Package)

```
TaskScore/
├── TaskScoreApp.swift              # @main, WindowGroup, Settings
├── Models/
│   ├── IGCFile.swift               # Parsed IGC data model
│   ├── XCTask.swift                # Task definition model
│   ├── FlightEvent.swift           # Event types and data
│   ├── GlideSegment.swift          # Glide analysis results
│   └── Preferences.swift           # User preferences (units, theme)
├── Analysis/
│   ├── IGCParser.swift             # Port of igc-parser.ts (327 lines)
│   ├── XCTaskParser.swift          # Port of xctsk-parser.ts (721 lines)
│   ├── EventDetector.swift         # Port of event-detector.ts (888 lines)
│   ├── GlideSpeed.swift            # Port of glide-speed.ts (236 lines)
│   ├── Geo.swift                   # Port of geo.ts (wrap CoreLocation)
│   ├── Units.swift                 # Port of units.ts (164 lines)
│   └── Waypoints.swift             # Port of waypoints.ts (171 lines)
├── Views/
│   ├── ContentView.swift           # Main NavigationSplitView layout
│   ├── MapView.swift               # MapKit integration
│   ├── EventListView.swift         # Sidebar event list with filters
│   ├── EventDetailView.swift       # Individual event card
│   ├── TaskOverlayView.swift       # Task cylinder rendering on map
│   ├── TrackOverlayView.swift      # Flight track polyline on map
│   ├── GlideMarkersView.swift      # Chevron + speed labels
│   ├── FlightInfoView.swift        # Summary panel (pilot, date, etc.)
│   ├── SettingsView.swift          # Preferences (units, display)
│   └── AirScoreLoadView.swift      # AirScore URL input sheet
├── Services/
│   ├── AirScoreClient.swift        # Fetch from AirScore → save .igc/.xctsk
│   ├── XContestClient.swift        # Fetch from XContest → save .xctsk
│   └── FileStore.swift             # Manages ~/Documents/TaskScore/ directory
└── Resources/
    ├── SampleFlights/              # Bundled demo IGC files
    └── Waypoints/                  # Bundled waypoint CSVs
```

## Feature Mapping: Web → Native

### File Handling & Storage

**Design principle**: Everything is a file. No database. Downloaded data is written to `~/Documents/TaskScore/` with proper extensions so it can be browsed in Finder, reopened offline, backed up by Time Machine, and synced via iCloud Drive.

#### File Layout

```
~/Documents/TaskScore/
├── Tracks/
│   ├── 2025-01-15-John-Smith-Corryong.igc
│   ├── 2025-01-16-Jane-Doe-Forbes.igc
│   └── ...
└── Tasks/
    ├── Corryong-2025-Task-1.xctsk
    ├── Forbes-2025-Task-3.xctsk
    └── ...
```

The app creates this directory structure on first launch if it doesn't exist.

#### File Types

| Format | Extension | UTType | Contents |
|--------|-----------|--------|----------|
| IGC flight log | `.igc` | `com.taskscore.igc` (conforms to `.plainText`) | Standard IGC format, unchanged |
| XCTask | `.xctsk` | `com.taskscore.xctask` (conforms to `.json`) | XCTask JSON — same format as web version |

The app registers as the handler for both types. Double-clicking an `.igc` or `.xctsk` file in Finder opens it in TaskScore.

#### File Naming

Downloaded files get human-readable names derived from their metadata:

```swift
// Tracks: {date}-{pilot}-{competition}.igc
func trackFilename(igc: IGCFile, competition: String?) -> String {
    let date = igc.header.date.formatted(.iso8601.year().month().day().dateSeparator(.dash))
    let pilot = igc.header.pilot?.sanitizedForFilename() ?? "Unknown"
    let comp = competition?.sanitizedForFilename()
    return [date, pilot, comp].compactMap { $0 }.joined(separator: "-") + ".igc"
}

// Tasks: {competition}-{task-name}.xctsk
func taskFilename(competition: String, taskName: String) -> String {
    "\(competition)-\(taskName)".sanitizedForFilename() + ".xctsk"
}
```

If a file with the same name already exists, the app skips the download (the data is already local).

#### Web → Native Mapping

| Web | macOS Native |
|-----|-------------|
| `<input type="file">` | `NSOpenPanel` / File > Open |
| Drag-and-drop to browser | Native Finder drag-and-drop (`onDrop`) |
| IndexedDB storage | Files in `~/Documents/TaskScore/` |
| SHA-256 deduplication | Filename-based deduplication |
| "Stored Items" in command menu | File > Open Recent (built-in macOS) |
| localStorage (preferences) | `@AppStorage` / UserDefaults |

#### Open Recent

macOS tracks recently opened files automatically when the app uses the standard document-opening APIs (`NSDocumentController`). No custom "recent items" implementation needed — File > Open Recent just works, populated with every `.igc` and `.xctsk` file the app has opened.

#### Download Workflow

When the user loads data from AirScore or XContest, the app:

1. Fetches the data from the remote API
2. Saves it as a file in `~/Documents/TaskScore/` (Tracks/ or Tasks/)
3. Opens the saved file — exactly as if the user had opened it from Finder
4. The file appears in File > Open Recent

This means every remote fetch produces a durable local file. The user can go offline, open Finder, and browse all their downloaded flights and tasks. No network needed to reopen anything.

### Map Rendering

| Web (MapBox GL JS) | macOS Native (MapKit) |
|--------------------|-----------------------|
| `mapboxgl.Map` | `Map` (SwiftUI) or `MKMapView` |
| GeoJSON polylines | `MKPolyline` / MapKit overlays |
| Circle markers | `MKCircle` overlays |
| Popup on click | `MKAnnotation` with callout |
| Style switching | `mapStyle` modifier (.standard, .imagery, .hybrid) |
| 3D via Threebox | MapKit 3D with `MKMapCamera` pitch |
| Altitude coloring | Custom `MKPolylineRenderer` with gradient |

**MapKit advantages over MapBox:**
- No API key or usage limits
- Native 3D globe with terrain
- Smooth integration with SwiftUI animations
- Offline map caching built in (Apple handles it)
- Look Around (Street View equivalent) for free

**MapKit limitations to work around:**
- No custom vector tile styles (but satellite/standard/hybrid covers the use cases)
- Overlay rendering is less flexible than WebGL — gradient polylines require a custom `MKOverlayRenderer` subclass

### Track Visualization

```swift
// Altitude-colored track as segmented polyline
class AltitudePolylineRenderer: MKOverlayPathRenderer {
    let fixes: [IGCFix]
    let altitudeRange: ClosedRange<Double>

    override func draw(_ mapRect: MKMapRect, zoomScale: MKZoomScale, in context: CGContext) {
        // Draw segments with color interpolated by altitude
        // Brown (low) → Green → Blue → Sky blue (high)
    }
}
```

### Task Visualization

```swift
// Turnpoint cylinders as MKCircle overlays
func renderTask(_ task: XCTask) -> [MKOverlay] {
    task.turnpoints.map { tp in
        MKCircle(
            center: CLLocationCoordinate2D(latitude: tp.lat, longitude: tp.lon),
            radius: tp.radius
        )
    }
}
```

### Event Detection

Direct port of the TypeScript event detector. The algorithm is well-documented in `docs/events/thermal-detection-spec.md` and `docs/events/glide-detection-spec.md`.

Key parameters remain the same:
- Thermal: window=10, minClimb=0.5 m/s, minDuration=20s, exitThreshold=3
- Glide: minFixes=10, minDuration=30s
- Sink: L/D ≤ 5:1

The Swift port benefits from:
- `CLLocation.distance(from:)` replacing custom haversine
- `Measurement<UnitSpeed>` for unit conversions
- Value types (structs) for event data — no accidental mutation
- Strong enums for event types with associated values

```swift
enum FlightEvent {
    case thermal(ThermalEvent)
    case glide(GlideEvent)
    case sink(SinkEvent)
    case maxAltitude(FixIndex)
    case maxClimb(FixIndex, rate: Double)
    case maxSink(FixIndex, rate: Double)
    case turnpointEntry(FixIndex, turnpoint: Turnpoint)
    case turnpointExit(FixIndex, turnpoint: Turnpoint)
    case startCrossing(FixIndex)
    case goalCrossing(FixIndex)
    case takeoff(FixIndex)
    case landing(FixIndex)
}
```

### Storage

No database. The filesystem *is* the storage layer.

| Concern | Implementation |
|---------|---------------|
| Tracks | `.igc` files in `~/Documents/TaskScore/Tracks/` |
| Tasks | `.xctsk` files in `~/Documents/TaskScore/Tasks/` |
| Recent items | macOS File > Open Recent (automatic) |
| Preferences | `@AppStorage` / UserDefaults |
| Deduplication | Filename match (skip download if file exists) |
| Backup | Time Machine covers `~/Documents/` automatically |
| Sync | iCloud Drive covers `~/Documents/` if enabled |

```swift
struct FileStore {
    static let baseURL = FileManager.default
        .urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appending(path: "TaskScore")

    static let tracksURL = baseURL.appending(path: "Tracks")
    static let tasksURL = baseURL.appending(path: "Tasks")

    /// Creates ~/Documents/TaskScore/{Tracks,Tasks}/ if needed
    static func ensureDirectories() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: tracksURL, withIntermediateDirectories: true)
        try fm.createDirectory(at: tasksURL, withIntermediateDirectories: true)
    }

    /// Save downloaded IGC track, returns URL of saved file
    static func saveTrack(_ data: Data, filename: String) throws -> URL {
        let url = tracksURL.appending(path: filename)
        guard !FileManager.default.fileExists(atPath: url.path) else { return url }
        try data.write(to: url)
        return url
    }

    /// Save downloaded task, returns URL of saved file
    static func saveTask(_ data: Data, filename: String) throws -> URL {
        let url = tasksURL.appending(path: filename)
        guard !FileManager.default.fileExists(atPath: url.path) else { return url }
        try data.write(to: url)
        return url
    }
}
```

### UI Layout

The web app uses a sidebar + map layout. SwiftUI's `NavigationSplitView` provides this natively:

```swift
NavigationSplitView {
    // Sidebar: Event list with filter tabs
    EventListView(events: viewModel.events, filter: $filter)
} detail: {
    // Detail: Map with track + task overlays
    MapView(track: viewModel.track, task: viewModel.task)
        .overlay(alignment: .topTrailing) {
            FlightInfoView(summary: viewModel.summary)
        }
        .inspector(isPresented: $showInspector) {
            EventDetailView(event: viewModel.selectedEvent)
        }
}
```

### Command Palette

The web app's ⌘K command menu maps to:
- **Native menu bar**: File > Open, File > Open Recent, etc.
- **Toolbar**: Quick actions for display toggles
- **Settings window**: `Settings` scene for unit configuration
- **Spotlight/Quick Actions**: Could register as Spotlight importer for IGC metadata

```
Menu Bar:
├── File
│   ├── Open IGC File...          ⌘O
│   ├── Open Recent              ▶
│   ├── Load AirScore Task...     ⌘L
│   ├── Load XContest Task...     ⇧⌘L
│   └── Close                     ⌘W
├── View
│   ├── Show/Hide Sidebar         ⌘S (⌃⌘S)
│   ├── Show/Hide Inspector       ⌥⌘I
│   ├── Toggle 3D                 ⇧⌘3
│   ├── Map Style                ▶
│   │   ├── Standard
│   │   ├── Satellite
│   │   └── Hybrid
│   ├── Show Task                 ⌘T
│   └── Altitude Coloring         ⌘A
├── Flight
│   ├── All Events                ⌘1
│   ├── Glides                    ⌘2
│   ├── Climbs                    ⌘3
│   └── Sinks                     ⌘4
├── Sample Flights               ▶
│   ├── Corryong 2025 Task 1
│   ├── ...
└── Window / Help (standard)
```

### Network Layer

The native app can call AirScore and XContest directly — no CORS proxy needed. Every fetch saves to disk first, then opens from disk.

```swift
actor AirScoreClient {
    private let baseURL = URL(string: "https://xc.highcloud.net")!

    /// Fetch task → save as .xctsk → return file URL
    func fetchAndSaveTask(comPk: Int, tasPk: Int) async throws -> URL {
        let filename = "AirScore-\(comPk)-Task-\(tasPk).xctsk"

        // Skip download if already on disk
        let existing = FileStore.tasksURL.appending(path: filename)
        if FileManager.default.fileExists(atPath: existing.path) {
            return existing
        }

        // Fetch, transform to XCTask JSON, save
        let response = try await fetchTaskData(comPk: comPk, tasPk: tasPk)
        let xctaskJSON = try JSONEncoder().encode(response.task)
        return try FileStore.saveTask(xctaskJSON, filename: filename)
    }

    /// Fetch pilot track → save as .igc → return file URL
    func fetchAndSaveTrack(trackId: Int, pilotName: String?, competition: String?) async throws -> URL {
        let igcData = try await downloadTrack(trackId: trackId)
        let igc = try IGCParser.parse(igcData)
        let filename = trackFilename(igc: igc, competition: competition)

        return try FileStore.saveTrack(igcData, filename: filename)
    }
}
```

**Flow**: Network fetch → file on disk → open from disk → appears in Open Recent. The network layer is only used for the initial download. After that, the file is local and the app never needs the network for that data again.

## Implementation Phases

### Phase 1: Core Analysis (MVP)

**Goal**: Open and analyze local IGC files with event detection and map display.

**Deliverables:**
1. Swift IGC parser (port `igc-parser.ts`)
2. Event detector (port `event-detector.ts`)
3. Geo utilities (wrap CoreLocation, port `geo.ts`)
4. Unit conversion (port `units.ts`)
5. FileStore — create `~/Documents/TaskScore/` structure
6. Register as `.igc` file handler (UTType)
7. File > Open for IGC files, drag-and-drop from Finder
8. File > Open Recent (automatic with standard document APIs)
9. MapKit view with track polyline (altitude-colored)
10. Event list sidebar with filter tabs
11. Click event → pan to location on map

**Estimated scope**: ~4,000 lines of Swift

### Phase 2: Task Support + Downloads

**Goal**: Load competition tasks from AirScore/XContest, save as files, visualize alongside tracks.

**Deliverables:**
1. XCTask parser (port `xctsk-parser.ts`)
2. Register as `.xctsk` file handler (UTType)
3. Task cylinder overlays on map
4. Optimized task line calculation and display
5. Turnpoint entry/exit detection integrated with events
6. Start/goal crossing detection
7. AirScore client — fetch task → save `.xctsk` → open from file
8. AirScore client — fetch track → save `.igc` → open from file
9. XContest client — fetch task → save `.xctsk` → open from file
10. Load AirScore Task sheet (paste URL)

After this phase, every downloaded item is a file in `~/Documents/TaskScore/` that appears in File > Open Recent and can be reopened offline.

**Estimated scope**: ~3,000 lines of Swift

### Phase 3: Polish

**Goal**: Full-featured app with native feel.

**Deliverables:**
1. Settings window (unit preferences)
2. Glide visualization (chevrons + speed labels as map annotations)
3. 3D track visualization (MapKit camera pitch + altitude)
4. Sample flights bundled in app (copied to ~/Documents/TaskScore/ on first run)
5. Toolbar with display toggles
6. Keyboard shortcuts for all common actions
7. Dark mode support (automatic via SwiftUI)

**Estimated scope**: ~2,000 lines of Swift

### Phase 4: Distribution

**Goal**: Ship the app.

**Deliverables:**
1. App icon and branding
2. Code signing and notarization
3. Mac App Store submission (or direct DMG download)
4. Sparkle framework for auto-updates (if direct distribution)
5. Spotlight importer for IGC file metadata (optional)

## Testing Strategy

### Unit Tests (Swift Testing framework)

Port the existing test suite and expand:

```swift
@Test func parsesBRecord() {
    let record = "B1234564523456N00612345EA0034500456"
    let fix = IGCParser.parseBRecord(record)
    #expect(fix.latitude == 45.39093, accuracy: 0.00001)
    #expect(fix.longitude == 6.20575, accuracy: 0.00001)
}

@Test func detectsThermals() {
    let fixes = loadTestIGC("thermal-test.igc")
    let events = EventDetector.detect(fixes: fixes)
    let thermals = events.compactMap { if case .thermal(let t) = $0 { t } else { nil } }
    #expect(thermals.count > 0)
    #expect(thermals[0].avgClimbRate > 0.5)
}
```

### Integration Tests

- Load each sample flight → verify event counts match web version
- Parse known XCTask files → verify turnpoint coordinates
- Verify unit conversions match web version output

### UI Tests (XCUITest)

- Open IGC file via menu → verify track appears on map
- Click event in sidebar → verify map pans
- Change units in settings → verify labels update

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MapKit overlay performance with large tracks (10K+ fixes) | Slow rendering | Downsample tracks for display; full data for analysis |
| Altitude-gradient polyline complexity | Custom renderer work | Start with solid-color polyline; add gradient in Phase 3 |
| IGC parser edge cases differ between TS and Swift | Incorrect parsing | Use identical test fixtures; run both parsers on same files |
| AirScore API changes | Broken integration | Keep worker as intermediary; version the transform layer |
| App Store review (maps, file handling) | Rejection | Follow Apple HIG; use standard document model |

## What Stays on the Web

The native app does **not** replace the web version. They serve different audiences:

| Capability | Web | macOS Native |
|-----------|-----|-------------|
| Email submission workflow | Yes | No |
| Admin/scorer features | Yes | No |
| Competition management (D1/R2) | Yes | No |
| IGC analysis | Yes | Yes |
| Task visualization | Yes | Yes |
| AirScore integration | Yes | Yes |
| Offline analysis | Partial (cached) | Full |
| File system integration | Limited | Full |

The native app is a **flight analysis companion** — it focuses entirely on the IGC analysis tool, which is the most interactive and compute-intensive part of TaskScore.

## Decision Log

| Decision | Chosen | Alternatives Considered | Reason |
|----------|--------|------------------------|--------|
| Repository | Monorepo | Separate repos | Shared test fixtures, shared docs, low splitting cost later |
| UI Framework | SwiftUI | AppKit, Catalyst | Modern, declarative, less code |
| Map SDK | MapKit | MapBox Native SDK | Free, no API key, native 3D, simpler |
| Analysis code | Swift port | JavaScriptCore bridge | Type safety, no bridging overhead, maintainable |
| Storage | Files in ~/Documents/TaskScore/ | SwiftData, Core Data, SQLite | Transparent, Finder-browsable, offline-first, no database to corrupt |
| Distribution | Direct + App Store | Homebrew, App Store only | Flexibility; avoid review delays during development |
| Geo calculations | CoreLocation | Turf.js via JSCore | Native, tested, no dependencies |

## Minimum System Requirements

- macOS 14 Sonoma (for SwiftUI improvements + SwiftData + MapKit SwiftUI)
- Apple Silicon or Intel Mac
- ~50MB disk space (app + sample flights)
