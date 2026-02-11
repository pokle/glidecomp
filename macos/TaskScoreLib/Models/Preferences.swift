import Foundation

public enum SpeedUnit: String, CaseIterable, Sendable {
    case kmh = "km/h"
    case mph = "mph"
    case knots = "knots"
}

public enum AltitudeUnit: String, CaseIterable, Sendable {
    case meters = "m"
    case feet = "ft"
}

public enum DistanceUnit: String, CaseIterable, Sendable {
    case km = "km"
    case mi = "mi"
    case nmi = "nmi"
}

public enum ClimbRateUnit: String, CaseIterable, Sendable {
    case mps = "m/s"
    case fpm = "ft/min"
    case knots = "knots"
}

public struct UnitPreferences: Sendable {
    public var speed: SpeedUnit
    public var altitude: AltitudeUnit
    public var distance: DistanceUnit
    public var climbRate: ClimbRateUnit

    public init(speed: SpeedUnit, altitude: AltitudeUnit, distance: DistanceUnit, climbRate: ClimbRateUnit) {
        self.speed = speed; self.altitude = altitude; self.distance = distance; self.climbRate = climbRate
    }

    public static let `default` = UnitPreferences(
        speed: .kmh,
        altitude: .meters,
        distance: .km,
        climbRate: .mps
    )
}

public enum MapStylePreference: String, CaseIterable, Sendable {
    case standard = "Standard"
    case satellite = "Satellite"
    case hybrid = "Hybrid"
}
