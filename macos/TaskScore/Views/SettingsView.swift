import SwiftUI
import TaskScoreLib

/// Settings window for unit and map preferences
struct SettingsView: View {
    @AppStorage("speedUnit") private var speedUnit: String = SpeedUnit.kmh.rawValue
    @AppStorage("altitudeUnit") private var altitudeUnit: String = AltitudeUnit.meters.rawValue
    @AppStorage("distanceUnit") private var distanceUnit: String = DistanceUnit.km.rawValue
    @AppStorage("climbRateUnit") private var climbRateUnit: String = ClimbRateUnit.mps.rawValue
    @AppStorage("mapStyle") private var mapStyle: String = MapStylePreference.hybrid.rawValue

    var body: some View {
        Form {
            Section("Units") {
                Picker("Speed", selection: $speedUnit) {
                    ForEach(SpeedUnit.allCases, id: \.rawValue) { unit in
                        Text(unit.rawValue).tag(unit.rawValue)
                    }
                }

                Picker("Altitude", selection: $altitudeUnit) {
                    ForEach(AltitudeUnit.allCases, id: \.rawValue) { unit in
                        Text(unit.rawValue).tag(unit.rawValue)
                    }
                }

                Picker("Distance", selection: $distanceUnit) {
                    ForEach(DistanceUnit.allCases, id: \.rawValue) { unit in
                        Text(unit.rawValue).tag(unit.rawValue)
                    }
                }

                Picker("Climb Rate", selection: $climbRateUnit) {
                    ForEach(ClimbRateUnit.allCases, id: \.rawValue) { unit in
                        Text(unit.rawValue).tag(unit.rawValue)
                    }
                }
            }

            Section("Map") {
                Picker("Default Style", selection: $mapStyle) {
                    ForEach(MapStylePreference.allCases, id: \.rawValue) { style in
                        Text(style.rawValue).tag(style.rawValue)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 350, height: 300)
    }
}
