import Foundation
import TaskScoreLib

/// Manages bundled sample flights, copying them to ~/Documents/TaskScore/ on first launch
enum SampleFlights {
    static let sampleTrackFilename = "durand_45515_050126.igc"
    static let sampleTaskFilename = "buje.xctask"

    /// Find a resource in Bundle.main, checking both root and SampleFlights subdirectory
    private static func bundleURL(forResource name: String, withExtension ext: String) -> URL? {
        Bundle.main.url(forResource: name, withExtension: ext)
            ?? Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "SampleFlights")
    }

    /// Copy bundled sample files to the Documents directory if they don't already exist
    static func copyToDocumentsIfNeeded() {
        let fm = FileManager.default

        let trackDest = FileStore.tracksURL.appending(path: sampleTrackFilename)
        if !fm.fileExists(atPath: trackDest.path),
           let src = bundleURL(forResource: "durand_45515_050126", withExtension: "igc") {
            try? fm.copyItem(at: src, to: trackDest)
        }

        let taskDest = FileStore.tasksURL.appending(path: sampleTaskFilename)
        if !fm.fileExists(atPath: taskDest.path),
           let src = bundleURL(forResource: "buje", withExtension: "xctask") {
            try? fm.copyItem(at: src, to: taskDest)
        }
    }

    /// URLs for sample files (from Documents if copied, otherwise from bundle)
    static var trackURL: URL? {
        let docURL = FileStore.tracksURL.appending(path: sampleTrackFilename)
        if FileManager.default.fileExists(atPath: docURL.path) { return docURL }
        return bundleURL(forResource: "durand_45515_050126", withExtension: "igc")
    }

    static var taskURL: URL? {
        let docURL = FileStore.tasksURL.appending(path: sampleTaskFilename)
        if FileManager.default.fileExists(atPath: docURL.path) { return docURL }
        return bundleURL(forResource: "buje", withExtension: "xctask")
    }
}
