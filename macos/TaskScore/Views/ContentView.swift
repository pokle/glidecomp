import SwiftUI
import MapKit
import UniformTypeIdentifiers
import TaskScoreLib

/// Main app layout: NavigationSplitView with sidebar + map detail
struct ContentView: View {
    @State private var viewModel = FlightViewModel()
    @State private var selectedEvent: FlightEvent?
    @State private var eventFilter: EventFilter = .all
    @State private var showAirScoreSheet = false

    var body: some View {
        NavigationSplitView {
            EventListView(
                events: viewModel.events,
                glides: viewModel.extractGlides(),
                climbs: viewModel.extractClimbs(),
                sinks: viewModel.extractSinks(),
                selectedEvent: $selectedEvent,
                filter: $eventFilter
            )
            .navigationTitle("Events")
        } detail: {
            MapView(
                fixes: viewModel.fixes,
                events: viewModel.events,
                task: viewModel.task,
                selectedEvent: $selectedEvent
            )
            .overlay(alignment: .topTrailing) {
                if let summary = viewModel.summary {
                    FlightInfoView(summary: summary)
                        .padding()
                }
            }
            .overlay(alignment: .center) {
                if viewModel.isLoading {
                    ProgressView("Loading...")
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .overlay(alignment: .bottom) {
                if let error = viewModel.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(.red.opacity(0.8), in: RoundedRectangle(cornerRadius: 6))
                        .padding()
                        .onTapGesture { viewModel.errorMessage = nil }
                }
            }
        }
        .sheet(isPresented: $showAirScoreSheet) {
            AirScoreLoadView(isLoading: $viewModel.isLoading) { comPk, tasPk, trackId in
                viewModel.loadFromAirScore(comPk: comPk, tasPk: tasPk, trackId: trackId)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openIGCFile)) { _ in
            openIGCFile()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openXCTaskFile)) { _ in
            openXCTaskFile()
        }
        .onReceive(NotificationCenter.default.publisher(for: .loadAirScoreTask)) { _ in
            showAirScoreSheet = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .openSampleFlight)) { _ in
            openSampleFlight()
        }
        .focusedSceneValue(\.eventFilter, $eventFilter)
    }

    private func openIGCFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText, UTType(filenameExtension: "igc") ?? .plainText]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Select an IGC flight log file"

        if panel.runModal() == .OK, let url = panel.url {
            viewModel.loadIGCFile(from: url)
        }
    }

    private func openXCTaskFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json, UTType(filenameExtension: "xctsk") ?? .json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Select an XCTask file"

        if panel.runModal() == .OK, let url = panel.url {
            viewModel.loadXCTaskFile(from: url)
        }
    }

    private func openSampleFlight() {
        // Load task first, then track
        if let taskURL = SampleFlights.taskURL {
            viewModel.loadXCTaskFile(from: taskURL)
        }
        if let trackURL = SampleFlights.trackURL {
            viewModel.loadIGCFile(from: trackURL)
        } else {
            viewModel.errorMessage = "Sample flight not found"
        }
    }
}

/// Filter for event list
enum EventFilter: String, CaseIterable {
    case all = "All"
    case glides = "Glides"
    case climbs = "Climbs"
    case sinks = "Sinks"
}

// MARK: - FocusedValue for event filter binding

struct EventFilterKey: FocusedValueKey {
    typealias Value = Binding<EventFilter>
}

extension FocusedValues {
    var eventFilter: Binding<EventFilter>? {
        get { self[EventFilterKey.self] }
        set { self[EventFilterKey.self] = newValue }
    }
}

/// View model managing flight data and analysis
@Observable
class FlightViewModel {
    var igcFile: IGCFileData?
    var fixes: [IGCFix] = []
    var events: [FlightEvent] = []
    var task: XCTask?
    var summary: FlightSummary?
    var isLoading = false
    var errorMessage: String?
    var airScoreResponse: AirScoreTaskResponse?

    func loadIGCFile(from url: URL) {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            errorMessage = "Failed to read IGC file"
            return
        }

        let igc = IGCParser.parse(content)
        self.igcFile = igc
        self.fixes = igc.fixes
        self.events = EventDetector.detectFlightEvents(igc.fixes, task: task)
        self.summary = FlightSummary(igc: igc, events: events, task: task)
        self.errorMessage = nil
    }

    func loadXCTaskFile(from url: URL) {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else {
            errorMessage = "Failed to read task file"
            return
        }

        do {
            let xcTask = try XCTaskParser.parseXCTask(content)
            self.task = xcTask

            // Re-detect events with the task if we have fixes
            if !fixes.isEmpty {
                self.events = EventDetector.detectFlightEvents(fixes, task: xcTask)
            }

            // Update summary
            if let igc = igcFile {
                self.summary = FlightSummary(igc: igc, events: events, task: xcTask)
            }

            self.errorMessage = nil
        } catch {
            errorMessage = "Failed to parse task: \(error.localizedDescription)"
        }
    }

    func loadFromAirScore(comPk: Int, tasPk: Int, trackId: Int?) {
        isLoading = true
        errorMessage = nil

        Task {
            do {
                let client = AirScoreClient.shared

                // Fetch task first
                let (_, response) = try await client.fetchAndSaveTask(comPk: comPk, tasPk: tasPk)

                await MainActor.run {
                    self.task = response.task
                    self.airScoreResponse = response
                }

                // Fetch track if trackId provided
                if let trackId = trackId {
                    let trackURL = try await client.fetchAndSaveTrack(
                        trackId: trackId,
                        competition: response.competition.name
                    )

                    await MainActor.run {
                        self.loadIGCFile(from: trackURL)
                    }
                } else {
                    await MainActor.run {
                        // Update summary with just the task
                        if let igc = self.igcFile {
                            self.events = EventDetector.detectFlightEvents(self.fixes, task: response.task)
                            self.summary = FlightSummary(igc: igc, events: self.events, task: response.task)
                        }
                    }
                }

                await MainActor.run {
                    self.isLoading = false
                }
            } catch {
                await MainActor.run {
                    self.isLoading = false
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }

    func extractGlides() -> [GlideData] {
        var glides: [GlideData] = []

        for startEvent in events where startEvent.type == .glideStart {
            guard let segment = startEvent.segment,
                  let distance = startEvent.details["distance"],
                  let glideRatio = startEvent.details["glideRatio"],
                  let duration = startEvent.details["duration"],
                  let averageSpeed = startEvent.details["averageSpeed"] else {
                continue
            }

            guard let endEvent = events.first(where: {
                $0.type == .glideEnd && $0.segment == segment
            }) else {
                continue
            }

            let altitudeLost = startEvent.altitude - endEvent.altitude

            glides.append(GlideData(
                id: startEvent.id,
                startTime: startEvent.time,
                endTime: endEvent.time,
                startAltitude: startEvent.altitude,
                endAltitude: endEvent.altitude,
                distance: distance,
                duration: duration,
                averageSpeed: averageSpeed,
                glideRatio: glideRatio,
                altitudeLost: altitudeLost,
                segment: segment,
                sourceEvent: startEvent
            ))
        }

        // Sort by distance, longest first
        glides.sort { $0.distance > $1.distance }
        return glides
    }

    func extractClimbs() -> [ClimbData] {
        var climbs: [ClimbData] = []

        for entryEvent in events where entryEvent.type == .thermalEntry {
            guard let segment = entryEvent.segment,
                  let avgClimbRate = entryEvent.details["avgClimbRate"],
                  let duration = entryEvent.details["duration"],
                  let altitudeGain = entryEvent.details["altitudeGain"] else {
                continue
            }

            guard let exitEvent = events.first(where: {
                $0.type == .thermalExit && $0.segment == segment
            }) else {
                continue
            }

            climbs.append(ClimbData(
                id: entryEvent.id,
                startTime: entryEvent.time,
                endTime: exitEvent.time,
                startAltitude: entryEvent.altitude,
                endAltitude: exitEvent.altitude,
                altitudeGain: altitudeGain,
                duration: duration,
                avgClimbRate: avgClimbRate,
                segment: segment,
                sourceEvent: entryEvent
            ))
        }

        // Sort by altitude gain, highest first
        climbs.sort { $0.altitudeGain > $1.altitudeGain }
        return climbs
    }

    func extractSinks() -> [SinkData] {
        var sinks: [SinkData] = []

        for startEvent in events where startEvent.type == .glideStart {
            guard let segment = startEvent.segment,
                  let glideRatio = startEvent.details["glideRatio"],
                  let distance = startEvent.details["distance"],
                  let duration = startEvent.details["duration"],
                  let averageSpeed = startEvent.details["averageSpeed"] else {
                continue
            }

            // Only include glides with L/D ≤ 5 (poor glide = sink)
            guard glideRatio <= 5 else { continue }

            guard let endEvent = events.first(where: {
                $0.type == .glideEnd && $0.segment == segment
            }) else {
                continue
            }

            let altitudeLost = startEvent.altitude - endEvent.altitude
            let avgSinkRate = duration > 0 ? altitudeLost / duration : 0

            sinks.append(SinkData(
                id: startEvent.id,
                startTime: startEvent.time,
                endTime: endEvent.time,
                startAltitude: startEvent.altitude,
                endAltitude: endEvent.altitude,
                altitudeLost: altitudeLost,
                distance: distance,
                duration: duration,
                averageSpeed: averageSpeed,
                avgSinkRate: avgSinkRate,
                glideRatio: glideRatio,
                segment: segment,
                sourceEvent: startEvent
            ))
        }

        // Sort by altitude lost, deepest first
        sinks.sort { $0.altitudeLost > $1.altitudeLost }
        return sinks
    }
}

/// Summary information about a flight
struct FlightSummary {
    let pilot: String?
    let date: Date?
    let gliderType: String?
    let maxAltitudeMeters: Double?
    let eventCount: Int
    let taskDistanceMeters: Double?
    let competitionName: String?

    init(igc: IGCFileData, events: [FlightEvent], task: XCTask? = nil) {
        self.pilot = igc.header.pilot
        self.date = igc.header.date
        self.gliderType = igc.header.gliderType
        self.maxAltitudeMeters = events.first(where: { $0.type == .maxAltitude }).map { $0.altitude }
        self.eventCount = events.count
        self.competitionName = nil

        if let task = task, task.turnpoints.count >= 2 {
            self.taskDistanceMeters = XCTaskParser.calculateOptimizedTaskDistance(task)
        } else {
            self.taskDistanceMeters = nil
        }
    }
}
