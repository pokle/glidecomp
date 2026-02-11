import Foundation
import CoreLocation

/// Centralized Geographic Math Module
/// Provides geographic calculations using CoreLocation and standard formulas.
public enum Geo {

    /// Earth radius in meters (WGS-84 mean radius)
    private static let earthRadius: Double = 6_371_008.8

    /// Calculate distance between two coordinates using Haversine formula.
    /// - Returns: Distance in meters
    public static func haversineDistance(
        lat1: Double, lon1: Double,
        lat2: Double, lon2: Double
    ) -> Double {
        let loc1 = CLLocation(latitude: lat1, longitude: lon1)
        let loc2 = CLLocation(latitude: lat2, longitude: lon2)
        return loc1.distance(from: loc2)
    }

    /// Calculate bearing from point 1 to point 2 in degrees.
    /// - Returns: Bearing in degrees, between -180 and 180 (positive clockwise from north)
    public static func calculateBearing(
        lat1: Double, lon1: Double,
        lat2: Double, lon2: Double
    ) -> Double {
        let lat1Rad = lat1 * .pi / 180
        let lat2Rad = lat2 * .pi / 180
        let dLon = (lon2 - lon1) * .pi / 180

        let y = sin(dLon) * cos(lat2Rad)
        let x = cos(lat1Rad) * sin(lat2Rad) - sin(lat1Rad) * cos(lat2Rad) * cos(dLon)

        let bearing = atan2(y, x) * 180 / .pi
        return bearing
    }

    /// Calculate bearing from point 1 to point 2 in radians.
    /// - Returns: Bearing in radians
    public static func calculateBearingRadians(
        lat1: Double, lon1: Double,
        lat2: Double, lon2: Double
    ) -> Double {
        let bearingDegrees = calculateBearing(lat1: lat1, lon1: lon1, lat2: lat2, lon2: lon2)
        return bearingDegrees * .pi / 180
    }

    /// Calculate a destination point given distance and bearing from start point.
    /// - Parameters:
    ///   - lat: Starting latitude in degrees
    ///   - lon: Starting longitude in degrees
    ///   - distanceMeters: Distance in meters
    ///   - bearingRadians: Bearing in radians
    /// - Returns: Destination point (lat, lon) in degrees
    public static func destinationPoint(
        lat: Double, lon: Double,
        distanceMeters: Double,
        bearingRadians: Double
    ) -> (lat: Double, lon: Double) {
        let latRad = lat * .pi / 180
        let lonRad = lon * .pi / 180
        let angDist = distanceMeters / earthRadius

        let destLat = asin(
            sin(latRad) * cos(angDist) +
            cos(latRad) * sin(angDist) * cos(bearingRadians)
        )

        let destLon = lonRad + atan2(
            sin(bearingRadians) * sin(angDist) * cos(latRad),
            cos(angDist) - sin(latRad) * sin(destLat)
        )

        return (lat: destLat * 180 / .pi, lon: destLon * 180 / .pi)
    }

    /// Get bounding box for a set of points with latitude/longitude.
    /// - Returns: Bounding box (minLat, maxLat, minLon, maxLon)
    public static func getBoundingBox(
        _ fixes: [(latitude: Double, longitude: Double)]
    ) -> (minLat: Double, maxLat: Double, minLon: Double, maxLon: Double) {
        guard !fixes.isEmpty else {
            return (minLat: 0, maxLat: 0, minLon: 0, maxLon: 0)
        }

        var minLat = fixes[0].latitude
        var maxLat = fixes[0].latitude
        var minLon = fixes[0].longitude
        var maxLon = fixes[0].longitude

        for fix in fixes {
            minLat = min(minLat, fix.latitude)
            maxLat = max(maxLat, fix.latitude)
            minLon = min(minLon, fix.longitude)
            maxLon = max(maxLon, fix.longitude)
        }

        return (minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon)
    }

    /// Overload accepting IGCFix array
    public static func getBoundingBox(_ fixes: [IGCFix]) -> (minLat: Double, maxLat: Double, minLon: Double, maxLon: Double) {
        return getBoundingBox(fixes.map { (latitude: $0.latitude, longitude: $0.longitude) })
    }

    /// Check if a point is inside a cylinder.
    /// - Returns: true if point is inside or on the cylinder boundary
    public static func isInsideCylinder(
        lat: Double, lon: Double,
        centerLat: Double, centerLon: Double,
        radius: Double
    ) -> Bool {
        let dist = haversineDistance(lat1: lat, lon1: lon, lat2: centerLat, lon2: centerLon)
        return dist <= radius
    }

    /// Generate points forming a circle around a center point.
    /// - Parameters:
    ///   - centerLat: Latitude of circle center (degrees)
    ///   - centerLon: Longitude of circle center (degrees)
    ///   - radiusMeters: Circle radius in meters
    ///   - numPoints: Number of points to generate (default 64)
    /// - Returns: Array of (lat, lon) points forming the circle, closed (first point repeated at end)
    public static func getCirclePoints(
        centerLat: Double, centerLon: Double,
        radiusMeters: Double,
        numPoints: Int = 64
    ) -> [(lat: Double, lon: Double)] {
        var points: [(lat: Double, lon: Double)] = []

        for i in 0...numPoints {
            let angle = (Double(i) / Double(numPoints)) * 2 * .pi
            let dest = destinationPoint(lat: centerLat, lon: centerLon,
                                        distanceMeters: radiusMeters, bearingRadians: angle)
            points.append(dest)
        }

        return points
    }
}
