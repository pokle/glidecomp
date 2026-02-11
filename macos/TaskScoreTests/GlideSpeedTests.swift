import Testing
import Foundation
@testable import TaskScoreLib

@Suite("Glide Speed")
struct GlideSpeedTests {

    /// Create a simple straight-line glide track
    func createGlideTrack(numFixes: Int = 100, distancePerFix: Double = 50, altLossPerFix: Int = 2) -> [IGCFix] {
        var fixes: [IGCFix] = []
        let baseDate = makeDate(2024, 1, 15, 12, 0, 0)
        let startAlt = 2000

        for i in 0..<numFixes {
            let time = baseDate.addingTimeInterval(Double(i) * 5) // Every 5 seconds
            // Move northeast at roughly constant speed
            let lat = 47.0 + Double(i) * 0.0005
            let lon = 11.0 + Double(i) * 0.0005
            let alt = startAlt - (i * altLossPerFix)

            fixes.append(IGCFix(
                time: time, latitude: lat, longitude: lon,
                pressureAltitude: alt, gnssAltitude: alt, valid: true
            ))
        }

        return fixes
    }

    @Test("calculateGlidePositions should return empty for less than 2 fixes")
    func emptyForFewFixes() {
        let positions = GlideSpeed.calculateGlidePositions([IGCFix](), interval: 500)
        #expect(positions.isEmpty)

        let singleFix = [IGCFix(
            time: Date(), latitude: 47.0, longitude: 11.0,
            pressureAltitude: 1000, gnssAltitude: 1000, valid: true
        )]
        let positions2 = GlideSpeed.calculateGlidePositions(singleFix, interval: 500)
        #expect(positions2.isEmpty)
    }

    @Test("calculateGlidePositions should return positions at regular intervals")
    func regularIntervals() {
        let fixes = createGlideTrack()
        let interval: Double = 500
        let positions = GlideSpeed.calculateGlidePositions(fixes, interval: interval)

        #expect(positions.count > 0)

        // Each position should be at a multiple of the interval
        for (i, pos) in positions.enumerated() {
            let expectedDist = Double(i + 1) * interval
            #expect(isClose(pos.distance, expectedDist, tolerance: 1))
        }
    }

    @Test("calculateGlideMarkers should alternate between speed labels and chevrons")
    func alternateMarkers() {
        let fixes = createGlideTrack()
        let markers = GlideSpeed.calculateGlideMarkers(fixes)

        guard markers.count >= 4 else {
            #expect(markers.count >= 2, "Need at least 2 markers for this test")
            return
        }

        // Even indices (0, 2, 4...) should be speed labels
        // Odd indices (1, 3, 5...) should be chevrons
        for (i, marker) in markers.enumerated() {
            if i % 2 == 0 {
                #expect(marker.type == .speedLabel)
                #expect(marker.speedMps != nil)
            } else {
                #expect(marker.type == .chevron)
            }
        }
    }

    @Test("calculateTotalGlideDistance should return 0 for less than 2 fixes")
    func totalDistanceEmpty() {
        #expect(GlideSpeed.calculateTotalGlideDistance([]) == 0)
    }

    @Test("calculateTotalGlideDistance should calculate cumulative distance")
    func totalDistanceCumulative() {
        let fixes = createGlideTrack(numFixes: 10)
        let totalDist = GlideSpeed.calculateTotalGlideDistance(fixes)
        #expect(totalDist > 0)

        // Verify it's the sum of segment distances
        var expected: Double = 0
        for i in 1..<fixes.count {
            expected += Geo.haversineDistance(
                lat1: fixes[i - 1].latitude, lon1: fixes[i - 1].longitude,
                lat2: fixes[i].latitude, lon2: fixes[i].longitude
            )
        }
        #expect(isClose(totalDist, expected, tolerance: 0.01))
    }

    @Test("speed labels should have positive speed for moving track")
    func positiveSpeed() {
        let fixes = createGlideTrack()
        let markers = GlideSpeed.calculateGlideMarkers(fixes)

        let speedLabels = markers.filter { $0.type == .speedLabel }
        for label in speedLabels {
            #expect(label.speedMps! > 0)
        }
    }

    @Test("glide ratio should be positive for descending track")
    func positiveGlideRatio() {
        let fixes = createGlideTrack()
        let markers = GlideSpeed.calculateGlideMarkers(fixes)

        let speedLabels = markers.filter { $0.type == .speedLabel }
        for label in speedLabels {
            if let ratio = label.glideRatio {
                #expect(ratio > 0)
            }
        }
    }
}
