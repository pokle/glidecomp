import Testing
import Foundation
@testable import TaskScoreLib

@Suite("Geo Math Functions")
struct GeoTests {

    @Suite("haversineDistance")
    struct HaversineDistance {

        @Test("should calculate distance from London to Paris (~344km)")
        func londonParis() {
            let distance = Geo.haversineDistance(
                lat1: 51.5007, lon1: -0.1246,
                lat2: 48.8584, lon2: 2.2945
            )
            #expect(distance > 339000)
            #expect(distance < 349000)
        }

        @Test("should return 0 for same point")
        func samePoint() {
            let distance = Geo.haversineDistance(lat1: 47.0, lon1: 11.0, lat2: 47.0, lon2: 11.0)
            #expect(distance == 0)
        }

        @Test("should calculate roughly 111km for 1 degree of latitude")
        func oneDegreeLat() {
            let distance = Geo.haversineDistance(lat1: 47.0, lon1: 11.0, lat2: 48.0, lon2: 11.0)
            #expect(isClose(distance, 111195, tolerance: 100))
        }

        @Test("should calculate distance across equator")
        func acrossEquator() {
            let distance = Geo.haversineDistance(lat1: 1.0, lon1: 0.0, lat2: -1.0, lon2: 0.0)
            // CLLocation uses WGS-84 ellipsoid (~221,149m) vs spherical model (~222,390m)
            // Allow 2% tolerance to accommodate different earth models
            #expect(distance > 220000)
            #expect(distance < 224000)
        }

        @Test("should calculate distance in southern hemisphere")
        func southernHemisphere() {
            let distance = Geo.haversineDistance(
                lat1: -37.8136, lon1: 144.9631,
                lat2: -33.8688, lon2: 151.2093
            )
            #expect(distance > 700000)
            #expect(distance < 730000)
        }

        @Test("should calculate distance across date line")
        func acrossDateLine() {
            let distance = Geo.haversineDistance(
                lat1: -17.7134, lon1: 178.065,
                lat2: -21.1789, lon2: -175.1982
            )
            #expect(distance > 800000)
            #expect(distance < 810000)
        }

        @Test("should calculate short distances accurately (<100m)")
        func shortDistance() {
            let distance = Geo.haversineDistance(
                lat1: 47.0, lon1: 11.0,
                lat2: 47.0, lon2: 11.000657
            )
            #expect(distance > 45)
            #expect(distance < 55)
        }

        @Test("should be symmetric (A to B equals B to A)")
        func symmetric() {
            let distAB = Geo.haversineDistance(lat1: 47.123, lon1: 11.456, lat2: 48.789, lon2: 12.012)
            let distBA = Geo.haversineDistance(lat1: 48.789, lon1: 12.012, lat2: 47.123, lon2: 11.456)
            #expect(distAB == distBA)
        }

        @Test("should handle antipodal points (~20,000km)")
        func antipodal() {
            let distance = Geo.haversineDistance(lat1: 0, lon1: 0, lat2: 0, lon2: 180)
            #expect(distance > 20000000)
            #expect(distance < 20050000)
        }
    }

    @Suite("calculateBearing")
    struct CalculateBearing {

        @Test("should return ~0° for due north")
        func dueNorth() {
            let bearing = Geo.calculateBearing(lat1: 47.0, lon1: 11.0, lat2: 48.0, lon2: 11.0)
            #expect(isClose(bearing, 0, tolerance: 1))
        }

        @Test("should return ~90° for due east")
        func dueEast() {
            let bearing = Geo.calculateBearing(lat1: 47.0, lon1: 11.0, lat2: 47.0, lon2: 12.0)
            #expect(isClose(bearing, 90, tolerance: 1))
        }

        @Test("should return ~180° for due south")
        func dueSouth() {
            let bearing = Geo.calculateBearing(lat1: 48.0, lon1: 11.0, lat2: 47.0, lon2: 11.0)
            #expect(isClose(abs(bearing), 180, tolerance: 1))
        }

        @Test("should return ~-90° for due west")
        func dueWest() {
            let bearing = Geo.calculateBearing(lat1: 47.0, lon1: 12.0, lat2: 47.0, lon2: 11.0)
            #expect(isClose(bearing, -90, tolerance: 1))
        }

        @Test("should handle bearing range [-180, 180]")
        func bearingRange() {
            let testCases: [(Double, Double, Double, Double)] = [
                (47.0, 11.0, 48.0, 11.0),  // North
                (47.0, 11.0, 47.0, 12.0),  // East
                (48.0, 11.0, 47.0, 11.0),  // South
                (47.0, 12.0, 47.0, 11.0),  // West
            ]

            for (lat1, lon1, lat2, lon2) in testCases {
                let bearing = Geo.calculateBearing(lat1: lat1, lon1: lon1, lat2: lat2, lon2: lon2)
                #expect(bearing >= -180)
                #expect(bearing <= 180)
            }
        }
    }

    @Suite("getBoundingBox")
    struct GetBoundingBox {

        @Test("should calculate bounding box for fixes")
        func multiplePoints() {
            let fixes = [
                IGCFix(time: Date(), latitude: 47.0, longitude: 11.0, pressureAltitude: 1000, gnssAltitude: 1000, valid: true),
                IGCFix(time: Date(), latitude: 48.0, longitude: 12.0, pressureAltitude: 1000, gnssAltitude: 1000, valid: true),
                IGCFix(time: Date(), latitude: 47.5, longitude: 11.5, pressureAltitude: 1000, gnssAltitude: 1000, valid: true),
            ]

            let bounds = Geo.getBoundingBox(fixes)

            #expect(bounds.minLat == 47.0)
            #expect(bounds.maxLat == 48.0)
            #expect(bounds.minLon == 11.0)
            #expect(bounds.maxLon == 12.0)
        }

        @Test("should return zeros for empty fixes array")
        func emptyArray() {
            let bounds = Geo.getBoundingBox([IGCFix]())

            #expect(bounds.minLat == 0)
            #expect(bounds.maxLat == 0)
            #expect(bounds.minLon == 0)
            #expect(bounds.maxLon == 0)
        }

        @Test("should handle single fix")
        func singleFix() {
            let fixes = [
                IGCFix(time: Date(), latitude: 47.5, longitude: 11.5, pressureAltitude: 1000, gnssAltitude: 1000, valid: true),
            ]

            let bounds = Geo.getBoundingBox(fixes)
            #expect(bounds.minLat == 47.5)
            #expect(bounds.maxLat == 47.5)
            #expect(bounds.minLon == 11.5)
            #expect(bounds.maxLon == 11.5)
        }

        @Test("should handle negative coordinates")
        func negativeCoordinates() {
            let fixes = [
                IGCFix(time: Date(), latitude: -37.0, longitude: -175.0, pressureAltitude: 1000, gnssAltitude: 1000, valid: true),
                IGCFix(time: Date(), latitude: -35.0, longitude: -173.0, pressureAltitude: 1000, gnssAltitude: 1000, valid: true),
            ]

            let bounds = Geo.getBoundingBox(fixes)
            #expect(bounds.minLat == -37.0)
            #expect(bounds.maxLat == -35.0)
            #expect(bounds.minLon == -175.0)
            #expect(bounds.maxLon == -173.0)
        }
    }

    @Suite("destinationPoint")
    struct DestinationPoint {

        @Test("should calculate correct destination going north")
        func goingNorth() {
            let result = Geo.destinationPoint(lat: 47.0, lon: 11.0, distanceMeters: 1000, bearingRadians: 0)
            #expect(result.lat > 47.0)
            #expect(isClose(result.lon, 11.0, tolerance: 0.001))
        }

        @Test("should calculate correct destination going east")
        func goingEast() {
            let result = Geo.destinationPoint(lat: 47.0, lon: 11.0, distanceMeters: 1000, bearingRadians: .pi / 2)
            #expect(isClose(result.lat, 47.0, tolerance: 0.001))
            #expect(result.lon > 11.0)
        }

        @Test("should return to approximately same point after round trip")
        func roundTrip() {
            let distance: Double = 10000
            let bearing = Double.pi / 4

            let dest = Geo.destinationPoint(lat: 47.0, lon: 11.0, distanceMeters: distance, bearingRadians: bearing)
            let returnTrip = Geo.destinationPoint(lat: dest.lat, lon: dest.lon, distanceMeters: distance, bearingRadians: bearing + .pi)

            #expect(isClose(returnTrip.lat, 47.0, tolerance: 0.01))
            #expect(isClose(returnTrip.lon, 11.0, tolerance: 0.01))
        }
    }

    @Suite("isInsideCylinder")
    struct IsInsideCylinder {

        @Test("should return true for point at center")
        func atCenter() {
            #expect(Geo.isInsideCylinder(lat: 47.0, lon: 11.0, centerLat: 47.0, centerLon: 11.0, radius: 1000))
        }

        @Test("should return true for point inside cylinder")
        func inside() {
            #expect(Geo.isInsideCylinder(lat: 47.0, lon: 11.005, centerLat: 47.0, centerLon: 11.0, radius: 1000))
        }

        @Test("should return false for point outside cylinder")
        func outside() {
            #expect(!Geo.isInsideCylinder(lat: 47.02, lon: 11.0, centerLat: 47.0, centerLon: 11.0, radius: 1000))
        }
    }

    @Suite("getCirclePoints")
    struct GetCirclePoints {

        @Test("should return correct number of points (numPoints + 1 for closure)")
        func pointCount() {
            let points = Geo.getCirclePoints(centerLat: 47.0, centerLon: 11.0, radiusMeters: 1000, numPoints: 64)
            #expect(points.count == 65)
        }

        @Test("should return closed polygon")
        func closedPolygon() {
            let points = Geo.getCirclePoints(centerLat: 47.0, centerLon: 11.0, radiusMeters: 1000, numPoints: 32)
            let first = points[0]
            let last = points[points.count - 1]
            #expect(isClose(first.lat, last.lat, tolerance: 0.0000001))
            #expect(isClose(first.lon, last.lon, tolerance: 0.0000001))
        }

        @Test("should generate points at correct distance from center")
        func correctRadius() {
            let centerLat = 47.0
            let centerLon = 11.0
            let radius: Double = 1000

            let points = Geo.getCirclePoints(centerLat: centerLat, centerLon: centerLon, radiusMeters: radius, numPoints: 16)

            for i in 0..<(points.count - 1) {
                let dist = Geo.haversineDistance(lat1: centerLat, lon1: centerLon, lat2: points[i].lat, lon2: points[i].lon)
                #expect(isClose(dist, radius, tolerance: 10))
            }
        }

        @Test("should use default numPoints of 64")
        func defaultNumPoints() {
            let points = Geo.getCirclePoints(centerLat: 47.0, centerLon: 11.0, radiusMeters: 1000)
            #expect(points.count == 65)
        }
    }

    @Suite("Integration: distance + bearing consistency")
    struct Integration {

        @Test("should maintain triangle inequality")
        func triangleInequality() {
            let distAB = Geo.haversineDistance(lat1: 47.0, lon1: 11.0, lat2: 47.5, lon2: 11.5)
            let distBC = Geo.haversineDistance(lat1: 47.5, lon1: 11.5, lat2: 48.0, lon2: 12.0)
            let distAC = Geo.haversineDistance(lat1: 47.0, lon1: 11.0, lat2: 48.0, lon2: 12.0)

            #expect(distAC <= distAB + distBC + 1)
        }

        @Test("should have consistent bearing and reverse bearing")
        func reverseBearing() {
            let bearingForward = Geo.calculateBearing(lat1: 47.0, lon1: 11.0, lat2: 48.0, lon2: 12.0)
            let bearingBack = Geo.calculateBearing(lat1: 48.0, lon1: 12.0, lat2: 47.0, lon2: 11.0)

            var diff = abs(bearingForward - bearingBack)
            if diff > 180 { diff = 360 - diff }

            #expect(diff > 178)
            #expect(diff < 182)
        }
    }
}
