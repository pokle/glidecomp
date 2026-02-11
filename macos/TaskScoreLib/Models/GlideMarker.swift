import Foundation

/// A position along a glide segment at a regular interval
public struct ChevronPosition: Sendable {
    public let lat: Double
    public let lon: Double
    public let bearing: Double
    public let time: Double // timestamp in milliseconds
    public let distance: Double // cumulative distance in meters
    public let altitude: Double // gnssAltitude in meters
}

/// A marker for glide visualization (either a chevron or a speed label)
public struct GlideMarker: Sendable {
    public enum MarkerType: String, Sendable {
        case chevron
        case speedLabel = "speed-label"
    }

    public let type: MarkerType
    public let lat: Double
    public let lon: Double
    public let bearing: Double
    public let speedMps: Double? // m/s, only for speed-label
    public let glideRatio: Double? // L/D ratio, only for speed-label
    public let altitudeDiff: Double? // meters, negative = descent, only for speed-label
}
