import Foundation

/// XCTrack Task (.xctsk) Parser
/// Parses XCTrack task files in v1 (full JSON) and v2 (compact QR code) formats.
/// Port of packages/analysis/src/xctsk-parser.ts
public enum XCTaskParser {

    /// Default turnpoint radius in meters (standard for paragliding)
    public static let defaultTurnpointRadius: Double = 400

    // MARK: - Public API

    /// Parse xctsk JSON content (v1 or v2 format)
    public static func parseXCTask(_ content: String) throws -> XCTask {
        var jsonContent = content.trimmingCharacters(in: .whitespacesAndNewlines)

        // Remove XCTSK: prefix if present (QR code format)
        if jsonContent.hasPrefix("XCTSK:") {
            jsonContent = String(jsonContent.dropFirst(6))
        }

        guard let data = jsonContent.data(using: .utf8) else {
            throw XCTaskParseError.invalidJSON
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw XCTaskParseError.invalidJSON
        }

        // Determine format based on structure
        if let turnpoints = json["turnpoints"] as? [[String: Any]] {
            return parseV1(json, turnpoints: turnpoints)
        } else if let t = json["t"] as? [[String: Any]] {
            return parseV2(json, compactTurnpoints: t)
        } else {
            // Fallback: try v1
            let v1Task = parseV1(json, turnpoints: [])
            if isValidTask(v1Task) {
                return v1Task
            }
            return parseV2(json, compactTurnpoints: [])
        }
    }

    /// Validate that a task has valid turnpoints with coordinates
    public static func isValidTask(_ task: XCTask) -> Bool {
        guard !task.turnpoints.isEmpty else { return false }

        for tp in task.turnpoints {
            let lat = tp.waypoint.lat
            let lon = tp.waypoint.lon
            if lat.isNaN || lon.isNaN { return false }
            if lat < -90 || lat > 90 { return false }
            if lon < -180 || lon > 180 { return false }
        }

        return true
    }

    /// Get the SSS (start) turnpoint index, or -1 if not found
    public static func getSSSIndex(_ task: XCTask) -> Int {
        task.turnpoints.firstIndex(where: { $0.type == "SSS" }) ?? -1
    }

    /// Get the ESS (end of speed section) turnpoint index, or -1 if not found
    public static func getESSIndex(_ task: XCTask) -> Int {
        task.turnpoints.firstIndex(where: { $0.type == "ESS" }) ?? -1
    }

    /// Get all turnpoints that are actual turnpoints (not SSS/ESS/TAKEOFF)
    public static func getIntermediateTurnpoints(_ task: XCTask) -> [XCTaskTurnpoint] {
        task.turnpoints.filter { $0.type == nil }
    }

    // MARK: - Task Distance Calculations

    /// Calculate total task distance (center-to-center)
    public static func calculateTaskDistance(_ task: XCTask) -> Double {
        var distance: Double = 0
        let tps = task.turnpoints

        for i in 1..<tps.count {
            let p1 = tps[i - 1].waypoint
            let p2 = tps[i].waypoint
            distance += Geo.haversineDistance(lat1: p1.lat, lon1: p1.lon, lat2: p2.lat, lon2: p2.lon)
        }

        return distance
    }

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
                // Last turnpoint: point along line from previous
                let prev = task.turnpoints[i - 1]
                let bearing = Geo.calculateBearingRadians(
                    lat1: prev.waypoint.lat, lon1: prev.waypoint.lon,
                    lat2: tp.waypoint.lat, lon2: tp.waypoint.lon
                )
                path.append(Geo.destinationPoint(
                    lat: tp.waypoint.lat, lon: tp.waypoint.lon,
                    distanceMeters: tp.radius, bearingRadians: bearing
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

    // MARK: - IGC Task Conversion

    /// Convert an IGC task declaration to XCTask format
    public static func igcTaskToXCTask(_ igcTask: IGCTask, defaultRadius: Double = 400) -> XCTask {
        var turnpoints: [XCTaskTurnpoint] = []

        // Add start point as SSS
        if let start = igcTask.start {
            let name = start.name.isEmpty ? "Start" : start.name
            turnpoints.append(XCTaskTurnpoint(
                type: "SSS",
                radius: defaultRadius,
                waypoint: XCTaskWaypoint(name: name, lat: start.latitude, lon: start.longitude)
            ))
        }

        // Add intermediate turnpoints (no type)
        for tp in igcTask.turnpoints {
            let name = tp.name.isEmpty ? "Turnpoint" : tp.name
            turnpoints.append(XCTaskTurnpoint(
                type: nil,
                radius: defaultRadius,
                waypoint: XCTaskWaypoint(name: name, lat: tp.latitude, lon: tp.longitude)
            ))
        }

        // Add finish point as ESS
        if let finish = igcTask.finish {
            let name = finish.name.isEmpty ? "Finish" : finish.name
            turnpoints.append(XCTaskTurnpoint(
                type: "ESS",
                radius: defaultRadius,
                waypoint: XCTaskWaypoint(name: name, lat: finish.latitude, lon: finish.longitude)
            ))
        }

        return XCTask(
            taskType: "CLASSIC",
            version: 1,
            earthModel: "WGS84",
            turnpoints: turnpoints,
            sss: SSSConfig(type: "RACE", direction: "EXIT"),
            goal: GoalConfig(type: "CYLINDER")
        )
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

    // MARK: - Private: Polyline Decoding

    /// Decode polyline-encoded coordinates (Google Polyline Algorithm)
    /// Used in xctsk v2 format for compact representation
    private static func decodePolyline(_ encoded: String) -> [Double] {
        var result: [Double] = []
        let chars = Array(encoded.unicodeScalars)
        var index = 0
        var lat = 0
        var lon = 0
        var alt = 0

        while index < chars.count {
            // Decode latitude
            var shift = 0
            var value = 0

            repeat {
                let byte = Int(chars[index].value) - 63
                index += 1
                value |= (byte & 0x1f) << shift
                shift += 5
                if byte < 0x20 || index >= chars.count { break }
            } while true

            lat += (value & 1) != 0 ? ~(value >> 1) : (value >> 1)

            guard index < chars.count else { break }

            // Decode longitude
            shift = 0
            value = 0

            repeat {
                let byte = Int(chars[index].value) - 63
                index += 1
                value |= (byte & 0x1f) << shift
                shift += 5
                if byte < 0x20 || index >= chars.count { break }
            } while true

            lon += (value & 1) != 0 ? ~(value >> 1) : (value >> 1)

            // Decode altitude (if present)
            if index < chars.count {
                shift = 0
                value = 0

                repeat {
                    let byte = Int(chars[index].value) - 63
                    index += 1
                    value |= (byte & 0x1f) << shift
                    shift += 5
                    if byte < 0x20 || index >= chars.count { break }
                } while true

                alt += (value & 1) != 0 ? ~(value >> 1) : (value >> 1)
            }

            result.append(Double(lat) / 1e5)
            result.append(Double(lon) / 1e5)
            result.append(Double(alt))
        }

        return result
    }

    // MARK: - Private: V1 Parser

    /// Parse xctsk v1 format (full JSON)
    private static func parseV1(_ data: [String: Any], turnpoints tpArray: [[String: Any]]) -> XCTask {
        var turnpoints: [XCTaskTurnpoint] = []

        for tp in tpArray {
            guard let wp = tp["waypoint"] as? [String: Any] else { continue }

            let type = tp["type"] as? String
            let radius = (tp["radius"] as? Double) ?? (tp["radius"] as? Int).map { Double($0) } ?? 400

            turnpoints.append(XCTaskTurnpoint(
                type: type,
                radius: radius,
                waypoint: XCTaskWaypoint(
                    name: (wp["name"] as? String) ?? "Unnamed",
                    description: wp["description"] as? String,
                    lat: (wp["lat"] as? Double) ?? 0,
                    lon: (wp["lon"] as? Double) ?? 0,
                    altSmoothed: wp["altSmoothed"] as? Double
                )
            ))
        }

        let taskType = (data["taskType"] as? String) ?? "CLASSIC"
        let version = (data["version"] as? Int) ?? 1
        let earthModel = (data["earthModel"] as? String) ?? "WGS84"

        // Parse takeoff times
        var takeoffConfig: TakeoffConfig?
        if let takeoff = data["takeoff"] as? [String: Any] {
            takeoffConfig = TakeoffConfig(
                timeOpen: takeoff["timeOpen"] as? String,
                timeClose: takeoff["timeClose"] as? String
            )
        }

        // Parse SSS config
        var sssConfig: SSSConfig?
        if let sss = data["sss"] as? [String: Any] {
            sssConfig = SSSConfig(
                type: (sss["type"] as? String) ?? "RACE",
                direction: (sss["direction"] as? String) ?? "ENTER",
                timeGates: sss["timeGates"] as? [String]
            )
        }

        // Parse goal config
        var goalConfig: GoalConfig?
        if let goal = data["goal"] as? [String: Any] {
            goalConfig = GoalConfig(
                type: (goal["type"] as? String) ?? "CYLINDER",
                deadline: goal["deadline"] as? String
            )
        }

        return XCTask(
            taskType: taskType,
            version: version,
            earthModel: earthModel,
            turnpoints: turnpoints,
            takeoff: takeoffConfig,
            sss: sssConfig,
            goal: goalConfig
        )
    }

    // MARK: - Private: V2 Parser

    /// Parse xctsk v2 format (compact QR code format)
    private static func parseV2(_ data: [String: Any], compactTurnpoints tArray: [[String: Any]]) -> XCTask {
        var turnpoints: [XCTaskTurnpoint] = []

        for tp in tArray {
            var lat: Double = 0
            var lon: Double = 0
            var radius: Double = 400
            var alt: Double = 0

            // Decode polyline-encoded coordinates if present
            if let z = tp["z"] as? String {
                let decoded = decodePolyline(z)
                if decoded.count >= 2 {
                    lat = decoded[0]
                    lon = decoded[1]
                    if decoded.count >= 3 {
                        alt = decoded[2]
                    }
                }
            }

            // Override with explicit values if present
            if let explicitLat = tp["lat"] as? Double { lat = explicitLat }
            if let explicitLon = tp["lon"] as? Double { lon = explicitLon }
            if let explicitRadius = tp["r"] as? Double { radius = explicitRadius }
            else if let explicitRadius = tp["r"] as? Int { radius = Double(explicitRadius) }

            // Determine type from short code
            var type: String?
            if let y = tp["y"] as? String {
                switch y {
                case "S": type = "SSS"
                case "E": type = "ESS"
                case "T": type = "TAKEOFF"
                default: break
                }
            }

            turnpoints.append(XCTaskTurnpoint(
                type: type,
                radius: radius,
                waypoint: XCTaskWaypoint(
                    name: (tp["n"] as? String) ?? "Unnamed",
                    lat: lat,
                    lon: lon,
                    altSmoothed: alt != 0 ? alt : nil
                )
            ))
        }

        let taskType = (data["taskType"] as? String) ?? "CLASSIC"
        let earthModel: String = {
            if let e = data["e"] as? Int, e == 1 { return "FAI_SPHERE" }
            return "WGS84"
        }()

        // Parse takeoff times
        var takeoffConfig: TakeoffConfig?
        if data["to"] != nil || data["tc"] != nil {
            takeoffConfig = TakeoffConfig(
                timeOpen: data["to"] as? String,
                timeClose: data["tc"] as? String
            )
        }

        // Parse SSS config from compact format
        var sssConfig: SSSConfig?
        if let s = data["s"] as? [String: Any] {
            let sType = (s["t"] as? Int) == 1 ? "RACE" : "ELAPSED-TIME"
            let sDirection = (s["d"] as? Int) == 1 ? "ENTER" : "EXIT"
            let timeGates = s["g"] as? [String]
            sssConfig = SSSConfig(type: sType, direction: sDirection, timeGates: timeGates)
        }

        // Parse goal config from compact format
        var goalConfig: GoalConfig?
        if let g = data["g"] as? [String: Any] {
            let gType = (g["t"] as? Int) == 1 ? "LINE" : "CYLINDER"
            let deadline = g["d"] as? String
            goalConfig = GoalConfig(type: gType, deadline: deadline)
        }

        return XCTask(
            taskType: taskType,
            version: 2,
            earthModel: earthModel,
            turnpoints: turnpoints,
            takeoff: takeoffConfig,
            sss: sssConfig,
            goal: goalConfig
        )
    }
}

/// Errors that can occur during XCTask parsing
public enum XCTaskParseError: Error, LocalizedError {
    case invalidJSON
    case invalidFormat

    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "Invalid JSON content"
        case .invalidFormat:
            return "Unrecognized XCTask format"
        }
    }
}
