import Foundation

/// Unit conversion and formatting module.
/// All internal values are in SI units (m, m/s).
/// This module handles conversion to display units.
public enum Units {

    private struct ConversionInfo {
        let factor: Double
        let decimals: Int
        let label: String
    }

    private static let conversions: [String: [String: ConversionInfo]] = [
        "speed": [
            "km/h": ConversionInfo(factor: 3.6, decimals: 0, label: "km/h"),
            "mph": ConversionInfo(factor: 2.237, decimals: 0, label: "mph"),
            "knots": ConversionInfo(factor: 1.944, decimals: 0, label: "kts"),
        ],
        "altitude": [
            "m": ConversionInfo(factor: 1, decimals: 0, label: "m"),
            "ft": ConversionInfo(factor: 3.281, decimals: 0, label: "ft"),
        ],
        "distance": [
            "km": ConversionInfo(factor: 0.001, decimals: 2, label: "km"),
            "mi": ConversionInfo(factor: 0.000621371, decimals: 2, label: "mi"),
            "nmi": ConversionInfo(factor: 0.000539957, decimals: 2, label: "NM"),
        ],
        "climbRate": [
            "m/s": ConversionInfo(factor: 1, decimals: 1, label: "m/s"),
            "ft/min": ConversionInfo(factor: 196.85, decimals: 0, label: "fpm"),
            "knots": ConversionInfo(factor: 1.944, decimals: 1, label: "kts"),
        ],
    ]

    /// Result of formatting a value with units
    public struct FormattedValue {
        public let value: Double
        public let formatted: String    // e.g., "45"
        public let withUnit: String     // e.g., "45\u{00A0}km/h"
        public let unit: String         // e.g., "km/h"
    }

    /// Convert and format a value for display
    public static func formatUnit(
        _ value: Double,
        unitType: String,
        unit: String? = nil,
        decimals: Int? = nil,
        showSign: Bool = false,
        prefs: UnitPreferences = .default
    ) -> FormattedValue {
        let unitKey = unit ?? currentUnit(unitType, prefs: prefs)
        guard let conv = conversions[unitType]?[unitKey] else {
            let formatted = String(format: "%.0f", value)
            return FormattedValue(value: value, formatted: formatted, withUnit: formatted, unit: unitKey)
        }

        let converted = value * conv.factor
        let decimalPlaces = decimals ?? conv.decimals
        let formatted: String
        if decimalPlaces == 0 {
            formatted = String(format: "%.0f", converted)
        } else {
            formatted = String(format: "%.\(decimalPlaces)f", converted)
        }

        let sign = showSign && converted > 0 ? "+" : ""
        let displayValue = sign + formatted

        let withUnit = conv.label.isEmpty ? displayValue : "\(displayValue)\u{00A0}\(conv.label)"

        return FormattedValue(value: converted, formatted: displayValue, withUnit: withUnit, unit: conv.label.isEmpty ? unitKey : conv.label)
    }

    // Convenience functions

    public static func formatSpeed(_ mps: Double, showSign: Bool = false, prefs: UnitPreferences = .default) -> FormattedValue {
        formatUnit(mps, unitType: "speed", showSign: showSign, prefs: prefs)
    }

    public static func formatAltitude(_ m: Double, showSign: Bool = false, decimals: Int? = nil, prefs: UnitPreferences = .default) -> FormattedValue {
        formatUnit(m, unitType: "altitude", decimals: decimals, showSign: showSign, prefs: prefs)
    }

    public static func formatDistance(_ m: Double, decimals: Int? = nil, prefs: UnitPreferences = .default) -> FormattedValue {
        formatUnit(m, unitType: "distance", decimals: decimals, prefs: prefs)
    }

    public static func formatClimbRate(_ mps: Double, showSign: Bool? = nil, prefs: UnitPreferences = .default) -> FormattedValue {
        formatUnit(mps, unitType: "climbRate", showSign: showSign ?? true, prefs: prefs)
    }

    public static func formatAltitudeChange(_ m: Double, prefs: UnitPreferences = .default) -> FormattedValue {
        formatAltitude(m, showSign: true, prefs: prefs)
    }

    public static func formatRadius(_ meters: Double, prefs: UnitPreferences = .default) -> FormattedValue {
        let unitKey = currentUnit("distance", prefs: prefs)
        guard let conv = conversions["distance"]?[unitKey] else {
            let formatted = String(format: "%.0f", meters)
            return FormattedValue(value: meters, formatted: formatted, withUnit: formatted, unit: "m")
        }

        let converted = meters * conv.factor
        let decimalPlaces = converted >= 1 ? 0 : 1
        let formatted: String
        if decimalPlaces == 0 {
            formatted = String(format: "%.0f", converted)
        } else {
            formatted = String(format: "%.1f", converted)
        }

        return FormattedValue(value: converted, formatted: formatted, withUnit: "\(formatted)\(conv.label)", unit: conv.label)
    }

    public static func getUnitLabel(_ unitType: String, prefs: UnitPreferences = .default) -> String {
        let unitKey = currentUnit(unitType, prefs: prefs)
        return conversions[unitType]?[unitKey]?.label ?? unitKey
    }

    public static func currentUnit(_ unitType: String, prefs: UnitPreferences = .default) -> String {
        switch unitType {
        case "speed": return prefs.speed.rawValue
        case "altitude": return prefs.altitude.rawValue
        case "distance": return prefs.distance.rawValue
        case "climbRate": return prefs.climbRate.rawValue
        default: return ""
        }
    }
}
