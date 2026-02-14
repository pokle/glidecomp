import Foundation

/// Task path optimization for competition tasks.
///
/// Calculates the optimized (shortest) path through a competition task by finding
/// the optimal point to tag each turnpoint cylinder. Works with any task source
/// (XCTask from .xctsk files, IGC task declarations, AirScore tasks, etc.).
///
/// Port of web/analysis/src/task-optimizer.ts
public enum TaskOptimizer {

    /// Calculate the optimized task line that tags the edges of turnpoint cylinders.
    /// Uses golden section search to find optimal points on each cylinder.
    public static func calculateOptimizedTaskLine(_ task: XCTask) -> [(lat: Double, lon: Double)] {
        guard !task.turnpoints.isEmpty else { return [] }

        if task.turnpoints.count == 1 {
            let wp = task.turnpoints[0].waypoint
            return [(lat: wp.lat, lon: wp.lon)]
        }

        if task.turnpoints.count == 2 {
            let tp1 = task.turnpoints[0]
            let tp2 = task.turnpoints[1]

            let bearing = Geo.calculateBearingRadians(
                lat1: tp1.waypoint.lat, lon1: tp1.waypoint.lon,
                lat2: tp2.waypoint.lat, lon2: tp2.waypoint.lon
            )

            return [
                Geo.destinationPoint(lat: tp1.waypoint.lat, lon: tp1.waypoint.lon,
                                     distanceMeters: tp1.radius, bearingRadians: bearing),
                Geo.destinationPoint(lat: tp2.waypoint.lat, lon: tp2.waypoint.lon,
                                     distanceMeters: tp2.radius, bearingRadians: bearing + .pi),
            ]
        }

        // Three or more turnpoints - optimize each point
        var path: [(lat: Double, lon: Double)] = []

        for i in 0..<task.turnpoints.count {
            let tp = task.turnpoints[i]

            if i == 0 {
                // First turnpoint: point along line towards next
                let next = task.turnpoints[i + 1]
                let bearing = Geo.calculateBearingRadians(
                    lat1: tp.waypoint.lat, lon1: tp.waypoint.lon,
                    lat2: next.waypoint.lat, lon2: next.waypoint.lon
                )
                path.append(Geo.destinationPoint(
                    lat: tp.waypoint.lat, lon: tp.waypoint.lon,
                    distanceMeters: tp.radius, bearingRadians: bearing
                ))
            } else if i == task.turnpoints.count - 1 {
                // Last turnpoint (goal): entry point on cylinder nearest to previous optimized point
                let prevPoint = path[path.count - 1]
                let bearing = Geo.calculateBearingRadians(
                    lat1: prevPoint.lat, lon1: prevPoint.lon,
                    lat2: tp.waypoint.lat, lon2: tp.waypoint.lon
                )
                path.append(Geo.destinationPoint(
                    lat: tp.waypoint.lat, lon: tp.waypoint.lon,
                    distanceMeters: tp.radius, bearingRadians: bearing + .pi
                ))
            } else {
                // Intermediate turnpoint: find optimal point minimizing total distance
                let prevPoint = path[path.count - 1]
                let next = task.turnpoints[i + 1]

                let optimal = findOptimalCirclePoint(
                    prevLat: prevPoint.lat, prevLon: prevPoint.lon,
                    centerLat: tp.waypoint.lat, centerLon: tp.waypoint.lon,
                    radius: tp.radius,
                    nextLat: next.waypoint.lat, nextLon: next.waypoint.lon
                )

                path.append(optimal)
            }
        }

        return path
    }

    /// Calculate the optimized task distance (sum of all line segments)
    public static func calculateOptimizedTaskDistance(_ task: XCTask) -> Double {
        let path = calculateOptimizedTaskLine(task)
        guard path.count >= 2 else { return 0 }

        var totalDistance: Double = 0
        for i in 1..<path.count {
            totalDistance += Geo.haversineDistance(
                lat1: path[i - 1].lat, lon1: path[i - 1].lon,
                lat2: path[i].lat, lon2: path[i].lon
            )
        }

        return totalDistance
    }

    /// Get individual segment distances for the optimized path
    public static func getOptimizedSegmentDistances(_ task: XCTask) -> [Double] {
        let path = calculateOptimizedTaskLine(task)
        guard path.count >= 2 else { return [] }

        var distances: [Double] = []
        for i in 1..<path.count {
            distances.append(
                Geo.haversineDistance(
                    lat1: path[i - 1].lat, lon1: path[i - 1].lon,
                    lat2: path[i].lat, lon2: path[i].lon
                )
            )
        }

        return distances
    }

    // MARK: - Private: Golden Section Search

    /// Find the optimal point on a circle that minimizes total path distance
    private static func findOptimalCirclePoint(
        prevLat: Double, prevLon: Double,
        centerLat: Double, centerLon: Double,
        radius: Double,
        nextLat: Double, nextLon: Double
    ) -> (lat: Double, lon: Double) {
        // Cost function: total distance through a point on the circle
        let cost = { (angle: Double) -> Double in
            let point = Geo.destinationPoint(lat: centerLat, lon: centerLon,
                                             distanceMeters: radius, bearingRadians: angle)
            let d1 = Geo.haversineDistance(lat1: prevLat, lon1: prevLon,
                                           lat2: point.lat, lon2: point.lon)
            let d2 = Geo.haversineDistance(lat1: point.lat, lon1: point.lon,
                                           lat2: nextLat, lon2: nextLon)
            return d1 + d2
        }

        // Golden section search for minimum
        let phi = (1 + sqrt(5.0)) / 2
        let resphi = 2 - phi

        var a: Double = 0
        var b: Double = 2 * .pi
        let tol: Double = 1e-5

        var x1 = a + resphi * (b - a)
        var x2 = b - resphi * (b - a)
        var f1 = cost(x1)
        var f2 = cost(x2)

        while abs(b - a) > tol {
            if f1 < f2 {
                b = x2
                x2 = x1
                f2 = f1
                x1 = a + resphi * (b - a)
                f1 = cost(x1)
            } else {
                a = x1
                x1 = x2
                f1 = f2
                x2 = b - resphi * (b - a)
                f2 = cost(x2)
            }
        }

        let optimalAngle = (a + b) / 2
        return Geo.destinationPoint(lat: centerLat, lon: centerLon,
                                    distanceMeters: radius, bearingRadians: optimalAngle)
    }
}
