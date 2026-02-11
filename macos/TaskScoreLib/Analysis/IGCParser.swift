import Foundation

/// IGC File Parser
/// Parses IGC (International Gliding Commission) flight recorder files.
/// Reference: https://xp-soaring.github.io/igc_file_format/igc_format_2008.html
public enum IGCParser {

    /// Parse latitude from IGC format: DDMMmmmN/S
    /// Example: 4728234N = 47 degrees, 28.234 minutes North
    static func parseLatitude(_ lat: String) -> Double {
        guard lat.count >= 8 else { return 0 }
        let chars = Array(lat)

        let degrees = Double(String(chars[0..<2])) ?? 0
        let minutes = Double(String(chars[2..<4])) ?? 0
        let decimal = (Double(String(chars[4..<7])) ?? 0) / 1000
        let direction = chars[7]

        var value = degrees + (minutes + decimal) / 60
        if direction == "S" { value = -value }

        return value
    }

    /// Parse longitude from IGC format: DDDMMmmmE/W
    /// Example: 01152432E = 011 degrees, 52.432 minutes East
    static func parseLongitude(_ lon: String) -> Double {
        guard lon.count >= 9 else { return 0 }
        let chars = Array(lon)

        let degrees = Double(String(chars[0..<3])) ?? 0
        let minutes = Double(String(chars[3..<5])) ?? 0
        let decimal = (Double(String(chars[5..<8])) ?? 0) / 1000
        let direction = chars[8]

        var value = degrees + (minutes + decimal) / 60
        if direction == "W" { value = -value }

        return value
    }

    /// Parse time from IGC format: HHMMSS
    static func parseTime(_ time: String, baseDate: Date) -> Date {
        guard time.count >= 6 else { return baseDate }

        let hours = Int(time.prefix(2)) ?? 0
        let minutes = Int(time.dropFirst(2).prefix(2)) ?? 0
        let seconds = Int(time.dropFirst(4).prefix(2)) ?? 0

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!

        var components = calendar.dateComponents([.year, .month, .day], from: baseDate)
        components.hour = hours
        components.minute = minutes
        components.second = seconds

        return calendar.date(from: components) ?? baseDate
    }

    /// Parse date from IGC format: DDMMYY
    static func parseDate(_ dateStr: String) -> Date {
        guard dateStr.count >= 6 else { return Date() }

        let day = Int(dateStr.prefix(2)) ?? 1
        let month = Int(dateStr.dropFirst(2).prefix(2)) ?? 1
        var year = Int(dateStr.dropFirst(4).prefix(2)) ?? 0

        // Handle 2-digit year: assume 20xx for years < 80, 19xx otherwise
        year += year < 80 ? 2000 : 1900

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!

        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = 0
        components.minute = 0
        components.second = 0

        return calendar.date(from: components) ?? Date()
    }

    /// Parse a B record (GPS fix)
    /// Format: BHHMMSSDDMMMMMN/SDDDMMMMMWE/WVPPPPPGGGGG
    static func parseBRecord(_ line: String, baseDate: Date) -> IGCFix? {
        guard line.count >= 35 else { return nil }

        let chars = Array(line)
        let time = parseTime(String(chars[1..<7]), baseDate: baseDate)
        let latitude = parseLatitude(String(chars[7..<15]))
        let longitude = parseLongitude(String(chars[15..<24]))
        let valid = chars[24] == "A"
        let pressureAltitude = Int(String(chars[25..<30])) ?? 0
        let gnssAltitude = Int(String(chars[30..<35])) ?? 0

        return IGCFix(
            time: time,
            latitude: latitude,
            longitude: longitude,
            pressureAltitude: pressureAltitude,
            gnssAltitude: gnssAltitude,
            valid: valid
        )
    }

    /// Check if a string matches the pattern for IGC latitude: 7 digits followed by N or S
    private static func isLatPattern(_ s: String) -> Bool {
        guard s.count == 8 else { return false }
        let chars = Array(s)
        for i in 0..<7 {
            guard chars[i].isNumber else { return false }
        }
        return chars[7] == "N" || chars[7] == "S"
    }

    /// Check if a string matches the pattern for IGC longitude: 8 digits followed by E or W
    private static func isLonPattern(_ s: String) -> Bool {
        guard s.count == 9 else { return false }
        let chars = Array(s)
        for i in 0..<8 {
            guard chars[i].isNumber else { return false }
        }
        return chars[8] == "E" || chars[8] == "W"
    }

    /// Parse a C record (task declaration point)
    /// Format: CDDMMmmmN/SDDDMMmmmE/W[Description]
    static func parseCRecord(_ line: String) -> IGCTaskPoint? {
        guard line.count >= 18 else { return nil }

        let chars = Array(line)
        let latPart = String(chars[1..<9])
        let lonPart = String(chars[9..<18])

        guard isLatPattern(latPart), isLonPattern(lonPart) else {
            return nil
        }

        let latitude = parseLatitude(latPart)
        let longitude = parseLongitude(lonPart)
        let name = String(line.dropFirst(18)).trimmingCharacters(in: .whitespaces)

        return IGCTaskPoint(latitude: latitude, longitude: longitude, name: name)
    }

    /// Parse an E record (event)
    /// Format: EHHMMSSTTT[text]
    static func parseERecord(_ line: String, baseDate: Date) -> IGCEvent? {
        guard line.count >= 10 else { return nil }

        let chars = Array(line)
        let time = parseTime(String(chars[1..<7]), baseDate: baseDate)
        let code = String(chars[7..<10])
        let description = String(line.dropFirst(10)).trimmingCharacters(in: .whitespaces)

        return IGCEvent(time: time, code: code, description: description)
    }

    /// Extract 6-digit date string from header content like "FDTE:150124" or "FDTE150124" or "DTE:150124"
    private static func extractDateDigits(from content: String, prefixes: [String]) -> String? {
        for prefix in prefixes {
            guard content.hasPrefix(prefix) else { continue }
            let rest = String(content.dropFirst(prefix.count))
            // Skip optional colon and whitespace
            let trimmed = rest.drop { $0 == ":" || $0 == " " }
            // Extract 6 digits
            let digits = String(trimmed.prefix(6))
            if digits.count == 6 && digits.allSatisfy(\.isNumber) {
                return digits
            }
        }
        return nil
    }

    /// Extract value after colon from header content like "FPLT:John Doe" or "FPLTSomething:John Doe"
    private static func extractAfterColon(from content: String, prefixes: [String]) -> String? {
        for prefix in prefixes {
            guard content.hasPrefix(prefix) else { continue }
            if let colonIdx = content.firstIndex(of: ":") {
                let afterColon = String(content[content.index(after: colonIdx)...])
                    .trimmingCharacters(in: .whitespaces)
                if !afterColon.isEmpty {
                    return afterColon
                }
            }
        }
        return nil
    }

    /// Parse an H record (header)
    static func parseHRecord(_ line: String, header: inout IGCHeader) {
        let content = String(line.dropFirst(1))

        // HFDTE - Date
        if content.hasPrefix("FDTE") || content.hasPrefix("DTE") {
            if let digits = extractDateDigits(from: content, prefixes: ["FDTE", "DTE"]) {
                header.date = parseDate(digits)
            }
            return
        }

        // HFPLT - Pilot
        if content.hasPrefix("FPLT") || content.hasPrefix("PLT") {
            if let value = extractAfterColon(from: content, prefixes: ["FPLT", "PLT"]) {
                header.pilot = value
            }
            return
        }

        // HFGTY - Glider Type
        if content.hasPrefix("FGTY") || content.hasPrefix("GTY") {
            if let value = extractAfterColon(from: content, prefixes: ["FGTY", "GTY"]) {
                header.gliderType = value
            }
            return
        }

        // HFGID - Glider ID
        if content.hasPrefix("FGID") || content.hasPrefix("GID") {
            if let value = extractAfterColon(from: content, prefixes: ["FGID", "GID"]) {
                header.gliderId = value
            }
            return
        }

        // HFCID - Competition ID
        if content.hasPrefix("FCID") || content.hasPrefix("CID") {
            if let value = extractAfterColon(from: content, prefixes: ["FCID", "CID"]) {
                header.competitionId = value
            }
            return
        }

        // HFCCL - Competition Class
        if content.hasPrefix("FCCL") || content.hasPrefix("CCL") {
            if let value = extractAfterColon(from: content, prefixes: ["FCCL", "CCL"]) {
                header.competitionClass = value
            }
            return
        }
    }

    /// Extract 6-digit date from a line matching HFDTE or HDTE patterns
    private static func extractDateFromLine(_ line: String) -> String? {
        // Match patterns: HFDTE150124, HFDTE:150124, HDTE150124, HDTE:150124
        for prefix in ["HFDTE", "HDTE"] {
            guard line.hasPrefix(prefix) else { continue }
            let rest = String(line.dropFirst(prefix.count))
            let trimmed = rest.drop { $0 == ":" || $0 == " " }
            let digits = String(trimmed.prefix(6))
            if digits.count == 6 && digits.allSatisfy(\.isNumber) {
                return digits
            }
        }
        return nil
    }

    /// Parse an IGC file content string into structured data
    public static func parse(_ content: String) -> IGCFileData {
        let lines = content.components(separatedBy: .newlines)
        var header = IGCHeader()
        var fixes: [IGCFix] = []
        var events: [IGCEvent] = []
        var taskPoints: [IGCTaskPoint] = []

        var baseDate = Date()

        // First pass: get the date from header
        for line in lines {
            if line.hasPrefix("H") {
                if let dateDigits = extractDateFromLine(line) {
                    baseDate = parseDate(dateDigits)
                    header.date = baseDate
                    break
                }
            }
        }

        // Second pass: parse all records
        for line in lines {
            // Handle \r in lines from \r\n line endings
            let cleanLine = line.hasSuffix("\r") ? String(line.dropLast()) : line
            guard !cleanLine.isEmpty else { continue }

            let recordType = cleanLine.first

            switch recordType {
            case "H":
                parseHRecord(cleanLine, header: &header)

            case "B":
                if let fix = parseBRecord(cleanLine, baseDate: baseDate) {
                    fixes.append(fix)
                }

            case "E":
                if let event = parseERecord(cleanLine, baseDate: baseDate) {
                    events.append(event)
                }

            case "C":
                if let point = parseCRecord(cleanLine) {
                    taskPoints.append(point)
                }

            default:
                break
            }
        }

        // Build task from C records if present
        var task: IGCTask?
        if taskPoints.count >= 2 {
            var t = IGCTask(
                numTurnpoints: max(0, taskPoints.count - 4),
                turnpoints: []
            )

            if taskPoints.count >= 1 { t.takeoff = taskPoints[0] }
            if taskPoints.count >= 2 { t.start = taskPoints[1] }
            if taskPoints.count >= 3 { t.landing = taskPoints[taskPoints.count - 1] }
            if taskPoints.count >= 4 { t.finish = taskPoints[taskPoints.count - 2] }

            // Middle points are turnpoints
            if taskPoints.count > 4 {
                t.turnpoints = Array(taskPoints[2..<(taskPoints.count - 2)])
            }

            task = t
        }

        return IGCFileData(header: header, fixes: fixes, events: events, task: task)
    }
}
