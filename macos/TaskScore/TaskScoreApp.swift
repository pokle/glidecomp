import SwiftUI
import AppKit
import TaskScoreLib

@main
struct TaskScoreApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @AppStorage("mapStyle") private var mapStyle: String = MapStylePreference.hybrid.rawValue
    @AppStorage("showTask") private var showTask = true
    @AppStorage("showGlideMarkers") private var showGlideMarkers = true
    @AppStorage("show3D") private var show3D = false

    @FocusedValue(\.eventFilter) var eventFilter

    var body: some Scene {
        WindowGroup {
            ContentView()
                .frame(minWidth: 800, minHeight: 500)
        }
        .defaultSize(width: 1200, height: 800)
        .commands {
            // File menu additions
            CommandGroup(after: .newItem) {
                Button("Open IGC File...") {
                    NotificationCenter.default.post(name: .openIGCFile, object: nil)
                }
                .keyboardShortcut("o", modifiers: .command)

                Button("Open Task File...") {
                    NotificationCenter.default.post(name: .openXCTaskFile, object: nil)
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])

                Divider()

                Button("Load AirScore Task...") {
                    NotificationCenter.default.post(name: .loadAirScoreTask, object: nil)
                }
                .keyboardShortcut("l", modifiers: .command)

                Divider()

                Button("Open Sample Flight") {
                    NotificationCenter.default.post(name: .openSampleFlight, object: nil)
                }
            }

            // View menu additions
            CommandGroup(after: .sidebar) {
                Divider()

                Toggle("Show Task Overlays", isOn: $showTask)

                Toggle("Show Glide Markers", isOn: $showGlideMarkers)

                Toggle("3D Terrain", isOn: $show3D)

                Divider()

                Picker("Map Style", selection: $mapStyle) {
                    ForEach(MapStylePreference.allCases, id: \.rawValue) { style in
                        Text(style.rawValue).tag(style.rawValue)
                    }
                }
            }

            // Flight menu
            CommandMenu("Flight") {
                Button("All Events") {
                    eventFilter?.wrappedValue = .all
                }
                .keyboardShortcut("1", modifiers: .command)

                Button("Glides") {
                    eventFilter?.wrappedValue = .glides
                }
                .keyboardShortcut("2", modifiers: .command)

                Button("Climbs") {
                    eventFilter?.wrappedValue = .climbs
                }
                .keyboardShortcut("3", modifiers: .command)

                Button("Sinks") {
                    eventFilter?.wrappedValue = .sinks
                }
                .keyboardShortcut("4", modifiers: .command)
            }
        }

        Settings {
            SettingsView()
        }
    }
}

/// App delegate to handle activation for SPM-built executables
class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        try? FileStore.ensureDirectories()
        SampleFlights.copyToDocumentsIfNeeded()

        // Set app icon from bundled .icns resource
        if let iconURL = Bundle.module.url(forResource: "AppIcon", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApplication.shared.applicationIconImage = icon
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

extension Notification.Name {
    static let openIGCFile = Notification.Name("openIGCFile")
    static let openXCTaskFile = Notification.Name("openXCTaskFile")
    static let loadAirScoreTask = Notification.Name("loadAirScoreTask")
    static let openSampleFlight = Notification.Name("openSampleFlight")
}
