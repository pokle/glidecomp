import SwiftUI
import TaskScoreLib

/// Summary panel showing flight metadata
struct FlightInfoView: View {
    let summary: FlightSummary

    @AppStorage("altitudeUnit") private var altitudeUnit: String = AltitudeUnit.meters.rawValue
    @AppStorage("distanceUnit") private var distanceUnit: String = DistanceUnit.km.rawValue

    private var prefs: UnitPreferences {
        UnitPreferences(speed: SpeedUnit.kmh.rawValue, altitude: altitudeUnit,
                        distance: distanceUnit, climbRate: ClimbRateUnit.mps.rawValue)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let pilot = summary.pilot {
                Label(pilot, systemImage: "person")
                    .font(.headline)
            }

            if let date = summary.date {
                Label(date.formatted(.dateTime.day().month().year()), systemImage: "calendar")
                    .font(.caption)
            }

            if let glider = summary.gliderType {
                Label(glider, systemImage: "airplane")
                    .font(.caption)
            }

            if let maxAlt = summary.maxAltitudeMeters {
                Label("Max: \(Units.formatAltitude(maxAlt, prefs: prefs).withUnit)", systemImage: "arrow.up")
                    .font(.caption)
            }

            if let taskDist = summary.taskDistanceMeters {
                Label("Task: \(Units.formatDistance(taskDist, prefs: prefs).withUnit)", systemImage: "map")
                    .font(.caption)
            }

            Label("\(summary.eventCount) events", systemImage: "list.bullet")
                .font(.caption)
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}
