import SwiftUI
import TaskScoreLib

// MARK: - Formatting Helpers

/// Duration has no unit preference — always mm:ss
private func formatDuration(_ seconds: Double) -> String {
    let mins = Int(seconds) / 60
    let secs = Int(seconds) % 60
    return String(format: "%d:%02d", mins, secs)
}

private func formatGlideRatio(_ ratio: Double) -> String {
    if ratio.isInfinite || ratio.isNaN {
        return "\u{221E}:1"
    }
    return String(format: "%.1f:1", ratio)
}

private func formatTimeRange(_ start: Date, _ end: Date) -> String {
    let fmt = DateFormatter()
    fmt.dateFormat = "HH:mm:ss"
    return "\(fmt.string(from: start)) \u{2192} \(fmt.string(from: end))"
}

// MARK: - UnitPreferences from @AppStorage

extension UnitPreferences {
    /// Build preferences from raw @AppStorage string values
    init(speed: String, altitude: String, distance: String, climbRate: String) {
        self.init(
            speed: SpeedUnit(rawValue: speed) ?? .kmh,
            altitude: AltitudeUnit(rawValue: altitude) ?? .meters,
            distance: DistanceUnit(rawValue: distance) ?? .km,
            climbRate: ClimbRateUnit(rawValue: climbRate) ?? .mps
        )
    }
}

// MARK: - EventListView

/// Sidebar event list with filter tabs
struct EventListView: View {
    let events: [FlightEvent]
    let glides: [GlideData]
    let climbs: [ClimbData]
    let sinks: [SinkData]
    @Binding var selectedEvent: FlightEvent?
    @Binding var filter: EventFilter

    private var countLabel: String {
        switch filter {
        case .all:    return "\(events.count) events"
        case .glides: return "\(glides.count) glides"
        case .climbs: return "\(climbs.count) thermals"
        case .sinks:  return "\(sinks.count) sinks"
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Filter tabs
            Picker("Filter", selection: $filter) {
                ForEach(EventFilter.allCases, id: \.self) { f in
                    Text(f.rawValue).tag(f)
                }
            }
            .pickerStyle(.segmented)
            .padding()

            Text(countLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)

            // Tab content (fill remaining space so header stays at top)
            Group {
                switch filter {
                case .all:
                    AllEventsListView(events: events, selectedEvent: $selectedEvent)
                case .glides:
                    GlideListView(glides: glides, selectedEvent: $selectedEvent)
                case .climbs:
                    ClimbListView(climbs: climbs, selectedEvent: $selectedEvent)
                case .sinks:
                    SinkListView(sinks: sinks, selectedEvent: $selectedEvent)
                }
            }
            .frame(maxHeight: .infinity)
        }
    }
}

// MARK: - All Events Tab

struct AllEventsListView: View {
    let events: [FlightEvent]
    @Binding var selectedEvent: FlightEvent?

    var body: some View {
        if events.isEmpty {
            ContentUnavailableView("No events", systemImage: "list.bullet",
                                   description: Text("Load an IGC file to see events"))
        } else {
            List(events, selection: $selectedEvent) { event in
                EventRowView(event: event)
                    .tag(event)
            }
        }
    }
}

/// A single event row in the sidebar (used by All tab)
struct EventRowView: View {
    let event: FlightEvent

    @AppStorage("altitudeUnit") private var altitudeUnit: String = AltitudeUnit.meters.rawValue

    private var prefs: UnitPreferences {
        // EventRowView only displays altitude; other unit prefs don't matter here
        UnitPreferences(speed: SpeedUnit.kmh.rawValue, altitude: altitudeUnit,
                        distance: DistanceUnit.km.rawValue, climbRate: ClimbRateUnit.mps.rawValue)
    }

    var body: some View {
        HStack(spacing: 8) {
            let style = EventDetector.getEventStyle(event.type)
            Circle()
                .fill(Color(hex: style.color) ?? .gray)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(event.description)
                    .font(.system(.body, design: .default))
                    .lineLimit(1)

                Text(event.time, style: .time)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Text(Units.formatAltitude(event.altitude, prefs: prefs).withUnit)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Glides Tab

struct GlideListView: View {
    let glides: [GlideData]
    @Binding var selectedEvent: FlightEvent?

    var body: some View {
        if glides.isEmpty {
            ContentUnavailableView("No glides detected", systemImage: "arrow.right",
                                   description: Text("Load an IGC file to see glides"))
        } else {
            List {
                Text("Sorted by distance (longest first)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .listRowSeparator(.hidden)

                ForEach(Array(glides.enumerated()), id: \.element.id) { index, glide in
                    GlideRowView(rank: index + 1, glide: glide)
                        .contentShape(Rectangle())
                        .listRowBackground(selectedEvent == glide.sourceEvent ? Color.accentColor.opacity(0.2) : Color.clear)
                        .onTapGesture { selectedEvent = glide.sourceEvent }
                }
            }
        }
    }
}

struct GlideRowView: View {
    let rank: Int
    let glide: GlideData

    @AppStorage("speedUnit") private var speedUnit: String = SpeedUnit.kmh.rawValue
    @AppStorage("altitudeUnit") private var altitudeUnit: String = AltitudeUnit.meters.rawValue
    @AppStorage("distanceUnit") private var distanceUnit: String = DistanceUnit.km.rawValue
    @AppStorage("climbRateUnit") private var climbRateUnit: String = ClimbRateUnit.mps.rawValue

    private var prefs: UnitPreferences {
        UnitPreferences(speed: speedUnit, altitude: altitudeUnit, distance: distanceUnit, climbRate: climbRateUnit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Line 1: rank + distance + time range
            HStack {
                Text("#\(rank)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(Units.formatDistance(glide.distance, prefs: prefs).withUnit)
                    .font(.body.bold())
                Spacer()
                Text(formatTimeRange(glide.startTime, glide.endTime))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Line 2: stats
            HStack(spacing: 8) {
                Text("L/D \(formatGlideRatio(glide.glideRatio))")
                Text(Units.formatSpeed(glide.averageSpeed, prefs: prefs).withUnit)
                Text(Units.formatAltitude(abs(glide.altitudeLost), prefs: prefs).withUnit)
                Text(formatDuration(glide.duration))
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            // Line 3: altitude range
            Text("\(Units.formatAltitude(glide.startAltitude, prefs: prefs).withUnit) \u{2192} \(Units.formatAltitude(glide.endAltitude, prefs: prefs).withUnit)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
    }
}

// MARK: - Climbs Tab

struct ClimbListView: View {
    let climbs: [ClimbData]
    @Binding var selectedEvent: FlightEvent?

    var body: some View {
        if climbs.isEmpty {
            ContentUnavailableView("No thermals detected", systemImage: "arrow.up",
                                   description: Text("Load an IGC file to see climbs"))
        } else {
            List {
                Text("Sorted by altitude gain (highest first)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .listRowSeparator(.hidden)

                ForEach(Array(climbs.enumerated()), id: \.element.id) { index, climb in
                    ClimbRowView(rank: index + 1, climb: climb)
                        .contentShape(Rectangle())
                        .listRowBackground(selectedEvent == climb.sourceEvent ? Color.accentColor.opacity(0.2) : Color.clear)
                        .onTapGesture { selectedEvent = climb.sourceEvent }
                }
            }
        }
    }
}

struct ClimbRowView: View {
    let rank: Int
    let climb: ClimbData

    @AppStorage("altitudeUnit") private var altitudeUnit: String = AltitudeUnit.meters.rawValue
    @AppStorage("climbRateUnit") private var climbRateUnit: String = ClimbRateUnit.mps.rawValue

    private var prefs: UnitPreferences {
        UnitPreferences(speed: SpeedUnit.kmh.rawValue, altitude: altitudeUnit,
                        distance: DistanceUnit.km.rawValue, climbRate: climbRateUnit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Line 1: rank + altitude gain + time range
            HStack {
                Text("#\(rank)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("+\(Units.formatAltitude(climb.altitudeGain, prefs: prefs).withUnit)")
                    .font(.body.bold())
                Spacer()
                Text(formatTimeRange(climb.startTime, climb.endTime))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Line 2: stats
            HStack(spacing: 8) {
                Text(Units.formatClimbRate(climb.avgClimbRate, prefs: prefs).withUnit)
                Text(formatDuration(climb.duration))
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            // Line 3: altitude range
            Text("\(Units.formatAltitude(climb.startAltitude, prefs: prefs).withUnit) \u{2192} \(Units.formatAltitude(climb.endAltitude, prefs: prefs).withUnit)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
    }
}

// MARK: - Sinks Tab

struct SinkListView: View {
    let sinks: [SinkData]
    @Binding var selectedEvent: FlightEvent?

    var body: some View {
        if sinks.isEmpty {
            ContentUnavailableView("No descents detected", systemImage: "arrow.down",
                                   description: Text("Load an IGC file to see sinks"))
        } else {
            List {
                Text("Glides with L/D \u{2264} 5:1, sorted by altitude lost")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .listRowSeparator(.hidden)

                ForEach(Array(sinks.enumerated()), id: \.element.id) { index, sink in
                    SinkRowView(rank: index + 1, sink: sink)
                        .contentShape(Rectangle())
                        .listRowBackground(selectedEvent == sink.sourceEvent ? Color.accentColor.opacity(0.2) : Color.clear)
                        .onTapGesture { selectedEvent = sink.sourceEvent }
                }
            }
        }
    }
}

struct SinkRowView: View {
    let rank: Int
    let sink: SinkData

    @AppStorage("speedUnit") private var speedUnit: String = SpeedUnit.kmh.rawValue
    @AppStorage("altitudeUnit") private var altitudeUnit: String = AltitudeUnit.meters.rawValue
    @AppStorage("distanceUnit") private var distanceUnit: String = DistanceUnit.km.rawValue
    @AppStorage("climbRateUnit") private var climbRateUnit: String = ClimbRateUnit.mps.rawValue

    private var prefs: UnitPreferences {
        UnitPreferences(speed: speedUnit, altitude: altitudeUnit, distance: distanceUnit, climbRate: climbRateUnit)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // Line 1: rank + altitude lost + time range
            HStack {
                Text("#\(rank)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(Units.formatAltitude(sink.altitudeLost, prefs: prefs).withUnit)
                    .font(.body.bold())
                Spacer()
                Text(formatTimeRange(sink.startTime, sink.endTime))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Line 2: stats
            HStack(spacing: 8) {
                Text("L/D \(formatGlideRatio(sink.glideRatio))")
                Text(Units.formatClimbRate(-sink.avgSinkRate, prefs: prefs).withUnit)
                Text(Units.formatDistance(sink.distance, prefs: prefs).withUnit)
                Text(Units.formatSpeed(sink.averageSpeed, prefs: prefs).withUnit)
                Text(formatDuration(sink.duration))
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            // Line 3: altitude range
            Text("\(Units.formatAltitude(sink.startAltitude, prefs: prefs).withUnit) \u{2192} \(Units.formatAltitude(sink.endAltitude, prefs: prefs).withUnit)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
    }
}
