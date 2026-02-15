import Foundation
import TaskScoreLib

/// Client for fetching task and track data from AirScore.
/// The native app calls AirScore directly — no CORS proxy needed.
/// Every fetch saves to disk first, then opens from disk.
public actor AirScoreClient {

    public static let shared = AirScoreClient()

    private let baseURL = "https://xc.highcloud.net"

    private var userAgent: String {
        #if os(iOS)
        "TaskScore-iOS/1.0"
        #else
        "TaskScore-macOS/1.0"
        #endif
    }

    // MARK: - URL Parsing

    /// Parse an AirScore tracklog URL to extract comPk, tasPk, and trackId.
    /// Delegates to AirScoreURLParser in TaskScoreLib.
    public static func parseAirScoreURL(_ urlString: String) -> (comPk: Int, tasPk: Int, trackId: Int?)? {
        guard let params = AirScoreURLParser.parse(urlString) else { return nil }
        return (comPk: params.comPk, tasPk: params.tasPk, trackId: params.trackId)
    }

    // MARK: - Fetch Task

    /// Fetch task data from AirScore and return the raw JSON response.
    /// The response is in AirScore's native format and needs transformation.
    public func fetchTask(comPk: Int, tasPk: Int) async throws -> AirScoreTaskResponse {
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let url = URL(string: "\(baseURL)/get_task_result.php?comPk=\(comPk)&tasPk=\(tasPk)&_=\(timestamp)")!

        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AirScoreError.networkError("Invalid response type")
        }

        guard httpResponse.statusCode == 200 else {
            throw AirScoreError.httpError(httpResponse.statusCode)
        }

        // Parse raw AirScore response
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AirScoreError.invalidResponse("Invalid JSON response")
        }

        guard let rawTask = json["task"] as? [String: Any],
              let rawFormula = json["formula"] as? [String: Any],
              let rawData = json["data"] as? [[Any]] else {
            throw AirScoreError.invalidResponse("Missing required fields (task, formula, data)")
        }

        // Transform to our format
        let task = transformAirScoreTask(rawTask)
        let competition = extractCompetitionInfo(rawTask)
        let pilots = extractPilotResults(rawData)
        let formula = extractFormulaInfo(rawFormula)

        return AirScoreTaskResponse(
            task: task,
            competition: competition,
            pilots: pilots,
            formula: formula
        )
    }

    /// Fetch task and save as .xctsk file. Returns URL of saved file.
    public func fetchAndSaveTask(comPk: Int, tasPk: Int) async throws -> (url: URL, response: AirScoreTaskResponse) {
        let response = try await fetchTask(comPk: comPk, tasPk: tasPk)

        let filename = FileStore.taskFilename(
            competition: response.competition.name,
            taskName: response.competition.taskName
        )

        let taskData = try JSONEncoder().encode(response.task)
        let url = try FileStore.saveTask(taskData, filename: filename)

        return (url: url, response: response)
    }

    // MARK: - Fetch Track

    /// Fetch IGC track file from AirScore
    public func fetchTrack(trackId: Int) async throws -> String {
        let url = URL(string: "\(baseURL)/download_tracks.php?traPk=\(trackId)")!

        var request = URLRequest(url: url)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AirScoreError.networkError("Invalid response type")
        }

        guard httpResponse.statusCode == 200 else {
            throw AirScoreError.httpError(httpResponse.statusCode)
        }

        guard let content = String(data: data, encoding: .utf8) else {
            throw AirScoreError.invalidResponse("Invalid IGC file encoding")
        }

        // Validate it looks like an IGC file
        guard content.hasPrefix("A") || content.contains("HFDTE") else {
            throw AirScoreError.invalidResponse("Response does not appear to be a valid IGC file")
        }

        return content
    }

    /// Fetch track and save as .igc file. Returns URL of saved file.
    public func fetchAndSaveTrack(
        trackId: Int,
        competition: String? = nil
    ) async throws -> URL {
        let igcContent = try await fetchTrack(trackId: trackId)
        let igc = IGCParser.parse(igcContent)
        let filename = FileStore.trackFilename(igc: igc, competition: competition)

        guard let igcData = igcContent.data(using: .utf8) else {
            throw AirScoreError.invalidResponse("Failed to encode IGC content")
        }

        return try FileStore.saveTrack(igcData, filename: filename)
    }

    // MARK: - Private: Transform AirScore Data

    /// Transform AirScore raw task data to XCTask format
    private func transformAirScoreTask(_ rawTask: [String: Any]) -> XCTask {
        var turnpoints: [XCTaskTurnpoint] = []

        if let waypoints = rawTask["waypoints"] as? [[String: Any]],
           waypoints.first?["rwpLatDecimal"] != nil {
            // AirScore native format: waypoints with rwpLatDecimal/rwpLongDecimal (cylinder centers)
            for wp in waypoints {
                let tpType = mapWaypointType(wp["tawType"] as? String)
                let radius: Double = {
                    if let s = wp["tawRadius"] as? String { return Double(s) ?? 400 }
                    if let d = wp["tawRadius"] as? Double { return d }
                    if let i = wp["tawRadius"] as? Int { return Double(i) }
                    return 400
                }()
                let lat: Double = {
                    if let s = wp["rwpLatDecimal"] as? String { return Double(s) ?? 0 }
                    if let d = wp["rwpLatDecimal"] as? Double { return d }
                    return 0
                }()
                let lon: Double = {
                    if let s = wp["rwpLongDecimal"] as? String { return Double(s) ?? 0 }
                    if let d = wp["rwpLongDecimal"] as? Double { return d }
                    return 0
                }()
                let alt: Double? = {
                    if let s = wp["rwpAltitude"] as? String { return Double(s) }
                    if let d = wp["rwpAltitude"] as? Double { return d }
                    return nil
                }()

                turnpoints.append(XCTaskTurnpoint(
                    type: tpType,
                    radius: radius,
                    waypoint: XCTaskWaypoint(
                        name: (wp["rwpName"] as? String) ?? "Unnamed",
                        description: wp["rwpDescription"] as? String,
                        lat: lat,
                        lon: lon,
                        altSmoothed: alt
                    )
                ))
            }
        } else if let waypoints = rawTask["turnpoints"] as? [[String: Any]] {
            // XCTask/xctsk format: turnpoints with nested waypoint objects
            for wp in waypoints {
                let tpType = mapWaypointType(wp["type"] as? String)
                let radius = (wp["radius"] as? Double) ?? (wp["radius"] as? Int).map { Double($0) } ?? 400

                let waypointData = wp["waypoint"] as? [String: Any] ?? wp

                turnpoints.append(XCTaskTurnpoint(
                    type: tpType,
                    radius: radius,
                    waypoint: XCTaskWaypoint(
                        name: (waypointData["name"] as? String) ?? "Unnamed",
                        description: waypointData["description"] as? String,
                        lat: (waypointData["lat"] as? Double) ?? 0,
                        lon: (waypointData["lon"] as? Double) ?? 0,
                        altSmoothed: waypointData["altitude"] as? Double
                            ?? waypointData["altSmoothed"] as? Double
                    )
                ))
            }
        }

        // Extract SSS config
        var sssConfig: SSSConfig?

        // Try to get SSS direction from waypoint data (tawHow field)
        let sssDirection: String = {
            if let wps = rawTask["waypoints"] as? [[String: Any]],
               let sssWp = wps.first(where: { ($0["tawType"] as? String) == "speed" }),
               let how = sssWp["tawHow"] as? String {
                return how == "exit" ? "EXIT" : "ENTER"
            }
            return (rawTask["start_direction"] as? String) == "entry" ? "ENTER" : "EXIT"
        }()

        let taskType = (rawTask["task_type"] as? String) ?? "CLASSIC"
        let raceType = taskType.uppercased().contains("ELAPSED") ? "ELAPSED-TIME" : "RACE"

        // Check for time gates
        var timeGates: [String]?
        if let gates = rawTask["time_offset"] as? [Int] {
            timeGates = gates.map { offset in
                let hours = offset / 3600
                let minutes = (offset % 3600) / 60
                let seconds = offset % 60
                return String(format: "%02d:%02d:%02dZ", hours, minutes, seconds)
            }
        } else if let start = rawTask["start"] as? String, !start.isEmpty {
            timeGates = [start]
        }

        if !turnpoints.isEmpty {
            sssConfig = SSSConfig(type: raceType, direction: sssDirection, timeGates: timeGates)
        }

        // Extract goal config
        var goalConfig: GoalConfig?
        let goalType = (rawTask["goal_shape"] as? String)?.uppercased() == "LINE" ? "LINE" : "CYLINDER"
        goalConfig = GoalConfig(type: goalType)

        return XCTask(
            taskType: (rawTask["task_type"] as? String) ?? "CLASSIC",
            version: 1,
            earthModel: "WGS84",
            turnpoints: turnpoints,
            sss: sssConfig,
            goal: goalConfig
        )
    }

    private func mapWaypointType(_ airScoreType: String?) -> String? {
        guard let type = airScoreType?.lowercased() else { return nil }
        switch type {
        case "speed": return "SSS"
        case "endspeed": return "ESS"
        case "takeoff": return "TAKEOFF"
        default: return nil
        }
    }

    private func extractCompetitionInfo(_ rawTask: [String: Any]) -> CompetitionInfo {
        CompetitionInfo(
            name: (rawTask["comp_name"] as? String) ?? "Unknown Competition",
            compClass: (rawTask["comp_class"] as? String) ?? "",
            taskName: (rawTask["task_name"] as? String) ?? "Unknown Task",
            date: (rawTask["date"] as? String) ?? "",
            taskType: (rawTask["task_type"] as? String) ?? "CLASSIC",
            taskDistance: (rawTask["opt_dist"] as? Double) ?? (rawTask["task_distance"] as? Double) ?? 0,
            waypointDistance: (rawTask["task_distance"] as? Double) ?? 0,
            comment: rawTask["comment"] as? String,
            quality: (rawTask["quality"] as? Double) ?? 0,
            stopped: (rawTask["stopped"] as? Bool) ?? false
        )
    }

    private func extractPilotResults(_ rawData: [[Any]]) -> [PilotResult] {
        var results: [PilotResult] = []

        for row in rawData {
            guard row.count >= 17 else { continue }

            // Parse name and trackId from HTML link (element at index 2)
            let (name, trackId) = parseNameLink(row[2])

            let rank = (row[0] as? Int) ?? Int("\(row[0])".replacingOccurrences(of: "<b>", with: "").replacingOccurrences(of: "</b>", with: "")) ?? 0

            results.append(PilotResult(
                rank: rank,
                pilotId: "\(row[1])",
                name: name,
                nationality: "\(row[3])",
                glider: "\(row[4])",
                gliderClass: "\(row[5])",
                startTime: row[6] as? String,
                finishTime: row[7] as? String,
                duration: row[8] as? String,
                distance: parseDouble(row[10]),
                speed: parseDouble(row[14]),
                score: parseDouble(row[16]),
                trackId: trackId
            ))
        }

        return results
    }

    /// Parse HTML anchor tags to extract name and trackId
    private func parseNameLink(_ value: Any) -> (name: String, trackId: String?) {
        let str = "\(value)"

        // Check if it's an HTML link like: <a href="tracklog_map.html?trackid=43826">Pilot Name</a>
        if str.contains("<a ") {
            var name = str
            var trackId: String?

            // Extract name between > and </a>
            if let startRange = str.range(of: ">"),
               let endRange = str.range(of: "</a>") {
                name = String(str[startRange.upperBound..<endRange.lowerBound])
            }

            // Extract trackId from URL
            if let trackIdRange = str.range(of: "trackid=") {
                let afterTrackId = str[trackIdRange.upperBound...]
                if let endQuote = afterTrackId.firstIndex(where: { $0 == "\"" || $0 == "&" || $0 == "'" }) {
                    trackId = String(afterTrackId[..<endQuote])
                } else {
                    trackId = String(afterTrackId)
                }
            }

            return (name: name, trackId: trackId)
        }

        return (name: str, trackId: nil)
    }

    private func parseDouble(_ value: Any) -> Double {
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        if let s = value as? String { return Double(s) ?? 0 }
        return 0
    }

    private func extractFormulaInfo(_ rawFormula: [String: Any]) -> FormulaInfo {
        FormulaInfo(
            name: (rawFormula["formula_name"] as? String) ?? (rawFormula["name"] as? String) ?? "Unknown",
            goalPenalty: (rawFormula["goal_penalty"] as? Double) ?? 0,
            nominalGoal: "\(rawFormula["nominal_goal"] ?? "")",
            minimumDistance: "\(rawFormula["min_dist"] ?? rawFormula["minimum_distance"] ?? "")",
            nominalDistance: "\(rawFormula["nom_dist"] ?? rawFormula["nominal_distance"] ?? "")",
            nominalTime: "\(rawFormula["nom_time"] ?? rawFormula["nominal_time"] ?? "")",
            arrivalScoring: "\(rawFormula["arr_alt_bonus"] ?? rawFormula["arrival_scoring"] ?? "off")",
            heightBonus: "\(rawFormula["height_bonus"] ?? "")"
        )
    }
}

/// AirScore client errors
public enum AirScoreError: Error, LocalizedError {
    case networkError(String)
    case httpError(Int)
    case invalidResponse(String)
    case invalidURL(String)

    public var errorDescription: String? {
        switch self {
        case .networkError(let msg): return "Network error: \(msg)"
        case .httpError(let code): return "HTTP error: \(code)"
        case .invalidResponse(let msg): return "Invalid response: \(msg)"
        case .invalidURL(let msg): return "Invalid URL: \(msg)"
        }
    }
}
