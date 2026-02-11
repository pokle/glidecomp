import Foundation
import TaskScoreLib

/// Manages ~/Documents/TaskScore/ directory structure
public struct FileStore {
    public static let baseURL: URL = FileManager.default
        .urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appending(path: "TaskScore")

    public static let tracksURL: URL = baseURL.appending(path: "Tracks")
    public static let tasksURL: URL = baseURL.appending(path: "Tasks")

    /// Creates ~/Documents/TaskScore/{Tracks,Tasks}/ if needed
    public static func ensureDirectories() throws {
        let fm = FileManager.default
        try fm.createDirectory(at: tracksURL, withIntermediateDirectories: true)
        try fm.createDirectory(at: tasksURL, withIntermediateDirectories: true)
    }

    /// Save downloaded IGC track, returns URL of saved file
    @discardableResult
    public static func saveTrack(_ data: Data, filename: String) throws -> URL {
        let url = tracksURL.appending(path: filename)
        guard !FileManager.default.fileExists(atPath: url.path) else { return url }
        try data.write(to: url)
        return url
    }

    /// Save downloaded task, returns URL of saved file
    @discardableResult
    public static func saveTask(_ data: Data, filename: String) throws -> URL {
        let url = tasksURL.appending(path: filename)
        guard !FileManager.default.fileExists(atPath: url.path) else { return url }
        try data.write(to: url)
        return url
    }

    /// Generate a human-readable track filename from IGC data
    public static func trackFilename(igc: IGCFileData, competition: String? = nil) -> String {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "yyyy-MM-dd"
        dateFormatter.timeZone = TimeZone(identifier: "UTC")

        let date = igc.header.date.map { dateFormatter.string(from: $0) } ?? "unknown-date"
        let pilot = igc.header.pilot?.sanitizedForFilename() ?? "Unknown"
        let comp = competition?.sanitizedForFilename()

        return [date, pilot, comp].compactMap { $0 }.joined(separator: "-") + ".igc"
    }

    /// Generate a task filename
    public static func taskFilename(competition: String, taskName: String) -> String {
        "\(competition)-\(taskName)".sanitizedForFilename() + ".xctsk"
    }
}

extension String {
    /// Remove characters that are not valid in filenames
    func sanitizedForFilename() -> String {
        let invalidChars = CharacterSet(charactersIn: "/\\:*?\"<>|")
        return components(separatedBy: invalidChars)
            .joined()
            .trimmingCharacters(in: .whitespaces)
    }
}
