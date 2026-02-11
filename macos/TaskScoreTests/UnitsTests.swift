import Testing
import Foundation
@testable import TaskScoreLib

@Suite("Units")
struct UnitsTests {

    @Test("should format speed in km/h by default")
    func formatSpeedDefault() {
        let result = Units.formatSpeed(10.0) // 10 m/s
        #expect(result.value == 36) // 10 * 3.6
        #expect(result.formatted == "36")
        #expect(result.unit == "km/h")
    }

    @Test("should format speed in mph")
    func formatSpeedMph() {
        let prefs = UnitPreferences(speed: .mph, altitude: .meters, distance: .km, climbRate: .mps)
        let result = Units.formatSpeed(10.0, prefs: prefs)
        #expect(isClose(result.value, 22.37, tolerance: 0.01))
    }

    @Test("should format speed in knots")
    func formatSpeedKnots() {
        let prefs = UnitPreferences(speed: .knots, altitude: .meters, distance: .km, climbRate: .mps)
        let result = Units.formatSpeed(10.0, prefs: prefs)
        #expect(isClose(result.value, 19.44, tolerance: 0.01))
    }

    @Test("should format altitude in meters")
    func formatAltitudeMeters() {
        let result = Units.formatAltitude(1500.0)
        #expect(result.value == 1500)
        #expect(result.formatted == "1500")
        #expect(result.unit == "m")
    }

    @Test("should format altitude in feet")
    func formatAltitudeFeet() {
        let prefs = UnitPreferences(speed: .kmh, altitude: .feet, distance: .km, climbRate: .mps)
        let result = Units.formatAltitude(1000.0, prefs: prefs)
        #expect(isClose(result.value, 3281, tolerance: 1))
    }

    @Test("should format distance in km")
    func formatDistanceKm() {
        let result = Units.formatDistance(5000.0) // 5000m
        #expect(isClose(result.value, 5.0, tolerance: 0.01))
        #expect(result.formatted == "5.00")
    }

    @Test("should format distance in miles")
    func formatDistanceMiles() {
        let prefs = UnitPreferences(speed: .kmh, altitude: .meters, distance: .mi, climbRate: .mps)
        let result = Units.formatDistance(10000.0, prefs: prefs)
        #expect(isClose(result.value, 6.21, tolerance: 0.01))
    }

    @Test("should format climb rate in m/s with sign")
    func formatClimbRateDefault() {
        let result = Units.formatClimbRate(2.5)
        #expect(result.formatted == "+2.5")
        #expect(result.unit == "m/s")
    }

    @Test("should format climb rate in ft/min")
    func formatClimbRateFpm() {
        let prefs = UnitPreferences(speed: .kmh, altitude: .meters, distance: .km, climbRate: .fpm)
        let result = Units.formatClimbRate(1.0, prefs: prefs)
        #expect(isClose(result.value, 196.85, tolerance: 1))
    }

    @Test("should format altitude change with sign")
    func formatAltitudeChange() {
        let result = Units.formatAltitudeChange(500.0)
        #expect(result.formatted == "+500")

        let result2 = Units.formatAltitudeChange(-200.0)
        #expect(result2.formatted == "-200")
    }

    @Test("should format radius with smart decimals")
    func formatRadius() {
        let result = Units.formatRadius(5000) // 5000m = 5km
        #expect(result.formatted == "5")

        let result2 = Units.formatRadius(500) // 500m = 0.5km
        #expect(result2.formatted == "0.5")
    }

    @Test("should include non-breaking space in withUnit")
    func nonBreakingSpace() {
        let result = Units.formatSpeed(10.0)
        #expect(result.withUnit.contains("\u{00A0}"))
    }

    @Test("should get correct unit labels")
    func unitLabels() {
        #expect(Units.getUnitLabel("speed") == "km/h")
        #expect(Units.getUnitLabel("altitude") == "m")
        #expect(Units.getUnitLabel("distance") == "km")
        #expect(Units.getUnitLabel("climbRate") == "m/s")
    }
}
