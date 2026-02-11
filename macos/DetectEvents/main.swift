import Foundation
import TaskScoreLib

// MARK: - CSV output helpers

func eventTypeString(_ type: FlightEventType) -> String {
    switch type {
    case .takeoff: return "takeoff"
    case .landing: return "landing"
    case .thermalEntry: return "thermal_entry"
    case .thermalExit: return "thermal_exit"
    case .glideStart: return "glide_start"
    case .glideEnd: return "glide_end"
    case .turnpointEntry: return "turnpoint_entry"
    case .turnpointExit: return "turnpoint_exit"
    case .startCrossing: return "start_crossing"
    case .goalCrossing: return "goal_crossing"
    case .maxAltitude: return "max_altitude"
    case .minAltitude: return "min_altitude"
    case .maxClimb: return "max_climb"
    case .maxSink: return "max_sink"
    }
}

func formatTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    formatter.timeZone = TimeZone(identifier: "UTC")
    return formatter.string(from: date)
}

func csvEscape(_ s: String) -> String {
    if s.contains(",") || s.contains("\"") || s.contains("\n") {
        return "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
    return s
}

// MARK: - Main

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: detect-events <flight.igc> [task.xctask]\n", stderr)
    exit(1)
}

let igcPath = CommandLine.arguments[1]
let taskPath = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : nil

// Load IGC
guard let igcContent = try? String(contentsOfFile: igcPath, encoding: .utf8) else {
    fputs("Error: Cannot read IGC file: \(igcPath)\n", stderr)
    exit(1)
}

let igc = IGCParser.parse(igcContent)

guard !igc.fixes.isEmpty else {
    fputs("Error: No fixes found in IGC file\n", stderr)
    exit(1)
}

// Load task (optional)
var task: XCTask? = nil
if let taskPath {
    guard let taskContent = try? String(contentsOfFile: taskPath, encoding: .utf8) else {
        fputs("Error: Cannot read task file: \(taskPath)\n", stderr)
        exit(1)
    }
    do {
        task = try XCTaskParser.parseXCTask(taskContent)
    } catch {
        fputs("Error: Failed to parse task: \(error)\n", stderr)
        exit(1)
    }
}

// Detect events
let events = EventDetector.detectFlightEvents(igc.fixes, task: task)

// Output CSV
print("time,type,lat,lon,altitude,description")
for event in events {
    let line = [
        formatTime(event.time),
        eventTypeString(event.type),
        String(format: "%.6f", event.latitude),
        String(format: "%.6f", event.longitude),
        String(format: "%.0f", event.altitude),
        csvEscape(event.description),
    ].joined(separator: ",")
    print(line)
}
