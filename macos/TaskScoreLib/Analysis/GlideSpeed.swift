import Foundation

/// Glide Speed Calculation Utilities
/// Calculates speed labels and chevron positions for glide segment visualization.
public enum GlideSpeed {

    /// Calculate positions along a glide segment at regular intervals.
    /// Returns positions at every `interval` meters (e.g., 250m).
    public static func calculateGlidePositions(
        _ fixes: [IGCFix],
        interval: Double
    ) -> [ChevronPosition] {
        guard fixes.count >= 2 else { return [] }

        var positions: [ChevronPosition] = []
        var cumulativeDistance: Double = 0
        var nextPositionDistance = interval

        for i in 1..<fixes.count {
            let prevFix = fixes[i - 1]
            let currFix = fixes[i]

            let segmentDistance = Geo.haversineDistance(
                lat1: prevFix.latitude, lon1: prevFix.longitude,
                lat2: currFix.latitude, lon2: currFix.longitude
            )

            let prevTime = prevFix.time.timeIntervalSince1970 * 1000
            let currTime = currFix.time.timeIntervalSince1970 * 1000

            cumulativeDistance += segmentDistance

            // Collect positions at each interval
            while cumulativeDistance >= nextPositionDistance - 0.1 {
                let overshoot = cumulativeDistance - nextPositionDistance
                let t = max(0, min(1, 1 - (overshoot / segmentDistance)))
                let posLat = prevFix.latitude + t * (currFix.latitude - prevFix.latitude)
                let posLon = prevFix.longitude + t * (currFix.longitude - prevFix.longitude)
                let posTime = prevTime + t * (currTime - prevTime)
                let posAltitude = Double(prevFix.gnssAltitude) + t * Double(currFix.gnssAltitude - prevFix.gnssAltitude)

                let bearing = Geo.calculateBearing(
                    lat1: prevFix.latitude, lon1: prevFix.longitude,
                    lat2: currFix.latitude, lon2: currFix.longitude
                )

                positions.append(ChevronPosition(
                    lat: posLat,
                    lon: posLon,
                    bearing: bearing,
                    time: posTime,
                    distance: nextPositionDistance,
                    altitude: posAltitude
                ))

                nextPositionDistance += interval

                if nextPositionDistance > cumulativeDistance + 0.1 {
                    break
                }
            }
        }

        return positions
    }

    /// Calculate glide markers (chevrons and speed labels) for a glide segment.
    public static func calculateGlideMarkers(_ fixes: [IGCFix]) -> [GlideMarker] {
        let segmentLength: Double = 1000
        let labelInterval = segmentLength / 2

        let positions = calculateGlidePositions(fixes, interval: labelInterval)

        guard !positions.isEmpty else { return [] }

        var markers: [GlideMarker] = []
        let startTime = fixes[0].time.timeIntervalSince1970 * 1000
        let startAltitude = Double(fixes[0].gnssAltitude)

        for i in 0..<positions.count {
            let pos = positions[i]
            let isLabel = (i % 2 == 0) // 500m, 1500m, 2500m...

            if isLabel {
                let segmentStartTime = (i == 0) ? startTime : positions[i - 1].time
                let segmentEndTime = (i + 1 < positions.count) ? positions[i + 1].time : pos.time

                let timeDiffSeconds = (segmentEndTime - segmentStartTime) / 1000

                let segmentStartAltitude = (i == 0) ? startAltitude : positions[i - 1].altitude
                let segmentEndAltitude = (i + 1 < positions.count) ? positions[i + 1].altitude : pos.altitude

                let altitudeDiff = segmentEndAltitude - segmentStartAltitude

                let segmentDistance: Double
                if i == 0 {
                    segmentDistance = (i + 1 < positions.count) ? positions[i + 1].distance : pos.distance
                } else {
                    let startDist = positions[i - 1].distance
                    let endDist = (i + 1 < positions.count) ? positions[i + 1].distance : pos.distance
                    segmentDistance = endDist - startDist
                }

                var speedMps: Double = 0
                if timeDiffSeconds > 0 && segmentDistance > 0 {
                    speedMps = segmentDistance / timeDiffSeconds
                }

                var glideRatio: Double?
                let altitudeLost = -altitudeDiff
                if altitudeLost > 0 && segmentDistance > 0 {
                    glideRatio = segmentDistance / altitudeLost
                }

                markers.append(GlideMarker(
                    type: .speedLabel,
                    lat: pos.lat,
                    lon: pos.lon,
                    bearing: pos.bearing,
                    speedMps: speedMps,
                    glideRatio: glideRatio,
                    altitudeDiff: (altitudeDiff).rounded()
                ))
            } else {
                markers.append(GlideMarker(
                    type: .chevron,
                    lat: pos.lat,
                    lon: pos.lon,
                    bearing: pos.bearing,
                    speedMps: nil,
                    glideRatio: nil,
                    altitudeDiff: nil
                ))
            }
        }

        return markers
    }

    /// Get the total distance of a glide segment in meters
    public static func calculateTotalGlideDistance(_ fixes: [IGCFix]) -> Double {
        guard fixes.count >= 2 else { return 0 }

        var totalDistance: Double = 0
        for i in 1..<fixes.count {
            totalDistance += Geo.haversineDistance(
                lat1: fixes[i - 1].latitude, lon1: fixes[i - 1].longitude,
                lat2: fixes[i].latitude, lon2: fixes[i].longitude
            )
        }
        return totalDistance
    }
}
