import SwiftUI
import MapKit
import TaskScoreLib

/// MapKit view displaying the flight track, events, task cylinders, optimized task line,
/// glide markers, and segment highlighting
struct MapView: View {
    let fixes: [IGCFix]
    let events: [FlightEvent]
    let task: XCTask?
    @Binding var selectedEvent: FlightEvent?

    @State private var cameraPosition: MapCameraPosition = .automatic

    // Display preferences (synced via UserDefaults)
    @AppStorage("mapStyle") private var mapStyle: String = MapStylePreference.hybrid.rawValue
    @AppStorage("showTask") private var showTask = true
    @AppStorage("showGlideMarkers") private var showGlideMarkers = true
    @AppStorage("show3D") private var show3D = false

    var body: some View {
        Map(position: $cameraPosition) {
            // Track polyline
            if fixes.count >= 2 {
                let coordinates = fixes.map {
                    CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
                }
                MapPolyline(coordinates: coordinates)
                    .stroke(.blue, lineWidth: 2)
            }

            // Segment highlight (cyan) for selected event
            let segCoords = segmentCoordinates
            if segCoords.count >= 2 {
                MapPolyline(coordinates: segCoords)
                    .stroke(.cyan, lineWidth: 4)
            }

            // Task cylinder overlays
            if showTask, let task = task {
                ForEach(Array(task.turnpoints.enumerated()), id: \.offset) { index, tp in
                    let circleCoords = Geo.getCirclePoints(
                        centerLat: tp.waypoint.lat, centerLon: tp.waypoint.lon,
                        radiusMeters: tp.radius
                    ).map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }

                    MapPolygon(coordinates: circleCoords)
                        .foregroundStyle(turnpointFillColor(tp).opacity(0.15))
                        .stroke(turnpointStrokeColor(tp), lineWidth: 1.5)

                    Annotation(
                        tp.waypoint.name,
                        coordinate: CLLocationCoordinate2D(latitude: tp.waypoint.lat, longitude: tp.waypoint.lon)
                    ) {
                        turnpointMarker(tp, index: index)
                    }
                }

                // Optimized task line
                let optimizedPath = XCTaskParser.calculateOptimizedTaskLine(task)
                if optimizedPath.count >= 2 {
                    let pathCoords = optimizedPath.map {
                        CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon)
                    }
                    MapPolyline(coordinates: pathCoords)
                        .stroke(.orange, style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                }
            }

            // Glide markers (chevrons + speed labels) for selected glide event
            if showGlideMarkers {
                let markers = computedGlideMarkers
                ForEach(Array(markers.enumerated()), id: \.offset) { _, marker in
                    let coord = CLLocationCoordinate2D(latitude: marker.lat, longitude: marker.lon)
                    if marker.type == .chevron {
                        Annotation("", coordinate: coord, anchor: .center) {
                            ChevronView(bearing: marker.bearing)
                        }
                    } else {
                        Annotation("", coordinate: coord, anchor: .center) {
                            SpeedLabelView(marker: marker)
                        }
                    }
                }
            }

            // Event markers
            ForEach(events.filter { shouldShowMarker($0) }) { event in
                Annotation(event.description, coordinate: CLLocationCoordinate2D(
                    latitude: event.latitude, longitude: event.longitude
                )) {
                    eventMarkerView(for: event)
                        .onTapGesture {
                            selectedEvent = event
                        }
                }
            }
        }
        .mapStyle(currentMapStyle)
        .onChange(of: fixes) { _, newFixes in
            updateCamera(fixes: newFixes, task: task)
        }
        .onChange(of: selectedEvent) { _, event in
            if let event = event {
                withAnimation {
                    cameraPosition = .camera(MapCamera(
                        centerCoordinate: CLLocationCoordinate2D(latitude: event.latitude, longitude: event.longitude),
                        distance: cameraPosition.camera?.distance ?? 5000
                    ))
                }
            }
        }
    }

    // MARK: - Computed Properties

    private var currentMapStyle: MapStyle {
        switch MapStylePreference(rawValue: mapStyle) {
        case .standard:
            return .standard(elevation: show3D ? .realistic : .flat)
        case .satellite:
            return .imagery(elevation: show3D ? .realistic : .flat)
        case .hybrid, .none:
            return .hybrid(elevation: show3D ? .realistic : .flat)
        }
    }

    /// Coordinates for highlighting the selected event's segment
    private var segmentCoordinates: [CLLocationCoordinate2D] {
        guard let event = selectedEvent,
              let segment = event.segment,
              segment.startIndex >= 0,
              segment.endIndex < fixes.count,
              segment.startIndex <= segment.endIndex else {
            return []
        }
        return fixes[segment.startIndex...segment.endIndex].map {
            CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude)
        }
    }

    /// Glide markers for the selected glide event's segment
    private var computedGlideMarkers: [GlideMarker] {
        guard let event = selectedEvent,
              (event.type == .glideStart || event.type == .glideEnd),
              let segment = event.segment,
              segment.startIndex >= 0,
              segment.endIndex < fixes.count,
              segment.startIndex < segment.endIndex else {
            return []
        }
        let segmentFixes = Array(fixes[segment.startIndex...segment.endIndex])
        return GlideSpeed.calculateGlideMarkers(segmentFixes)
    }

    // MARK: - Camera

    private func updateCamera(fixes: [IGCFix], task: XCTask?) {
        var allPoints: [(latitude: Double, longitude: Double)] = []

        if !fixes.isEmpty {
            allPoints = fixes.map { (latitude: $0.latitude, longitude: $0.longitude) }
        }

        if let task = task {
            for tp in task.turnpoints {
                allPoints.append((latitude: tp.waypoint.lat, longitude: tp.waypoint.lon))
            }
        }

        guard !allPoints.isEmpty else { return }

        let bounds = Geo.getBoundingBox(allPoints)
        let center = CLLocationCoordinate2D(
            latitude: (bounds.minLat + bounds.maxLat) / 2,
            longitude: (bounds.minLon + bounds.maxLon) / 2
        )
        let span = MKCoordinateSpan(
            latitudeDelta: (bounds.maxLat - bounds.minLat) * 1.2,
            longitudeDelta: (bounds.maxLon - bounds.minLon) * 1.2
        )
        cameraPosition = .region(MKCoordinateRegion(center: center, span: span))
    }

    // MARK: - Event Markers

    private func shouldShowMarker(_ event: FlightEvent) -> Bool {
        switch event.type {
        case .takeoff, .landing, .maxAltitude, .thermalEntry, .startCrossing, .goalCrossing:
            return true
        default:
            return false
        }
    }

    @ViewBuilder
    private func eventMarkerView(for event: FlightEvent) -> some View {
        let style = EventDetector.getEventStyle(event.type)
        Circle()
            .fill(Color(hex: style.color) ?? .blue)
            .frame(width: 12, height: 12)
            .overlay(
                Circle()
                    .stroke(.white, lineWidth: 1.5)
            )
    }

    // MARK: - Task Styling

    private func turnpointFillColor(_ tp: XCTaskTurnpoint) -> Color {
        switch tp.type {
        case "SSS": return .green
        case "ESS": return .yellow
        case "TAKEOFF": return .gray
        default: return .purple
        }
    }

    private func turnpointStrokeColor(_ tp: XCTaskTurnpoint) -> Color {
        switch tp.type {
        case "SSS": return .green
        case "ESS": return .yellow
        case "TAKEOFF": return .gray
        default: return .purple
        }
    }

    @ViewBuilder
    private func turnpointMarker(_ tp: XCTaskTurnpoint, index: Int) -> some View {
        let label: String = {
            if tp.type == "SSS" { return "S" }
            if tp.type == "ESS" { return "G" }
            if tp.type == "TAKEOFF" { return "T" }
            return "\(index)"
        }()

        Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 20, height: 20)
            .background(turnpointStrokeColor(tp))
            .clipShape(Circle())
            .overlay(Circle().stroke(.white, lineWidth: 1))
    }
}

// MARK: - Glide Marker Views

/// Chevron shape pointing in flight direction
struct ChevronView: View {
    let bearing: Double

    var body: some View {
        ChevronShape()
            .stroke(.blue, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .frame(width: 14, height: 10)
            .rotationEffect(.degrees(bearing))
    }
}

/// V-shape pointing up (north), rotated by bearing
struct ChevronShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        }
    }
}

/// Speed label showing speed, glide ratio, and altitude change
struct SpeedLabelView: View {
    let marker: GlideMarker

    @AppStorage("speedUnit") private var speedUnit: String = SpeedUnit.kmh.rawValue
    @AppStorage("altitudeUnit") private var altitudeUnit: String = AltitudeUnit.meters.rawValue

    private var prefs: UnitPreferences {
        UnitPreferences(speed: speedUnit, altitude: altitudeUnit,
                        distance: DistanceUnit.km.rawValue, climbRate: ClimbRateUnit.mps.rawValue)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let speedMps = marker.speedMps {
                Text(Units.formatSpeed(speedMps, prefs: prefs).withUnit)
                    .font(.system(size: 9, weight: .semibold))
            }
            HStack(spacing: 3) {
                if let glideRatio = marker.glideRatio {
                    Text(glideRatio >= 100 ? "∞:1" : String(format: "%.0f:1", glideRatio))
                        .font(.system(size: 8))
                }
                if let altDiff = marker.altitudeDiff {
                    Text(Units.formatAltitudeChange(altDiff, prefs: prefs).withUnit)
                        .font(.system(size: 8))
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 3))
    }
}

// MARK: - Color Extension

extension Color {
    init?(hex: String) {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.hasPrefix("#") ? String(hexSanitized.dropFirst()) : hexSanitized

        guard hexSanitized.count == 6,
              let rgb = UInt64(hexSanitized, radix: 16) else {
            return nil
        }

        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}
