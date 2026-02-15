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
    @State private var showIGCImporter = false
    @State private var showXCTaskImporter = false
    #if os(iOS)
    @State private var activeSheet: iOSSheet?
    @State private var panelDetent: PanelDetent = .collapsed
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.openURL) private var openURL
    #endif

    var body: some View {
        #if os(iOS)
        Group {
            if horizontalSizeClass == .compact {
                iPhoneLayout
            } else {
                iPadLayout
            }
        }
        .alert("", isPresented: showErrorAlert, actions: {
            Button("OK") { viewModel.errorMessage = nil }
        }, message: {
            Text(viewModel.errorMessage ?? "")
        })
        #else
        macOSLayout
        #endif
    }

    #if os(iOS)
    private var showErrorAlert: Binding<Bool> {
        Binding(
            get: { viewModel.errorMessage != nil },
            set: { if !$0 { viewModel.errorMessage = nil } }
        )
    }
    #endif

    // MARK: - macOS Layout

    #if os(macOS)
    private var macOSLayout: some View {
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
            mapDetailView
        }
        .sheet(isPresented: $showAirScoreSheet) {
            AirScoreLoadView(isLoading: $viewModel.isLoading) { comPk, tasPk, trackId in
                viewModel.loadFromAirScore(comPk: comPk, tasPk: tasPk, trackId: trackId)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .openIGCFile)) { _ in
            showIGCImporter = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .openXCTaskFile)) { _ in
            showXCTaskImporter = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .loadAirScoreTask)) { _ in
            showAirScoreSheet = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .openSampleFlight)) { _ in
            openSampleFlight()
        }
        .focusedSceneValue(\.eventFilter, $eventFilter)
        .fileImporter(isPresented: $showIGCImporter, allowedContentTypes: igcContentTypes) { result in
            handleFileImport(result) { url in viewModel.loadIGCFile(from: url) }
        }
        .fileImporter(isPresented: $showXCTaskImporter, allowedContentTypes: taskContentTypes) { result in
            handleFileImport(result) { url in viewModel.loadXCTaskFile(from: url) }
        }
    }
    #endif

    // MARK: - iPad Layout

    #if os(iOS)
    private var iPadLayout: some View {
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
            .toolbar { iOSToolbar }
        } detail: {
            mapDetailView
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .settings:
                NavigationStack {
                    SettingsView()
                        .navigationTitle("Settings")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { activeSheet = nil }
                            }
                        }
                }
            case .airScore:
                AirScoreLoadView(isLoading: $viewModel.isLoading) { comPk, tasPk, trackId in
                    viewModel.loadFromAirScore(comPk: comPk, tasPk: tasPk, trackId: trackId)
                }
            case .igcImporter:
                iOSFileImporter(contentTypes: igcContentTypes) { url in
                    viewModel.loadIGCFile(from: url)
                } onError: { error in
                    viewModel.errorMessage = error
                }
            case .taskImporter:
                iOSFileImporter(contentTypes: taskContentTypes) { url in
                    viewModel.loadXCTaskFile(from: url)
                } onError: { error in
                    viewModel.errorMessage = error
                }
            }
        }
    }

    // MARK: - iPhone Layout

    private var iPhoneLayout: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                mapDetailView
                    .ignoresSafeArea()

                // Menu buttons in a separate layer that respects safe area
                VStack {
                    HStack {
                        Spacer()
                        iPhoneMenuButtons
                    }
                    Spacer()
                }

                BottomPanelView(detent: $panelDetent, maxHeight: geo.size.height * 0.85) {
                    EventListView(
                        events: viewModel.events,
                        glides: viewModel.extractGlides(),
                        climbs: viewModel.extractClimbs(),
                        sinks: viewModel.extractSinks(),
                        selectedEvent: $selectedEvent,
                        filter: $eventFilter
                    )
                }
                .ignoresSafeArea(edges: .bottom)
            }
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .settings:
                NavigationStack {
                    SettingsView()
                        .navigationTitle("Settings")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button("Done") { activeSheet = nil }
                            }
                        }
                }
            case .airScore:
                AirScoreLoadView(isLoading: $viewModel.isLoading) { comPk, tasPk, trackId in
                    viewModel.loadFromAirScore(comPk: comPk, tasPk: tasPk, trackId: trackId)
                }
            case .igcImporter:
                iOSFileImporter(contentTypes: igcContentTypes) { url in
                    viewModel.loadIGCFile(from: url)
                } onError: { error in
                    viewModel.errorMessage = error
                }
            case .taskImporter:
                iOSFileImporter(contentTypes: taskContentTypes) { url in
                    viewModel.loadXCTaskFile(from: url)
                } onError: { error in
                    viewModel.errorMessage = error
                }
            }
        }
    }

    private var iPhoneMenuButtons: some View {
        HStack(spacing: 8) {
            Menu {
                Button { activeSheet = .igcImporter } label: {
                    Label("Open IGC File", systemImage: "doc")
                }
                Button { activeSheet = .taskImporter } label: {
                    Label("Open Task File", systemImage: "map")
                }
                Button { activeSheet = .airScore } label: {
                    Label("Load AirScore Task", systemImage: "cloud.fill")
                }
                Divider()
                Button {
                    DispatchQueue.main.async { openSampleFlight() }
                } label: {
                    Label("Sample Flight", systemImage: "paperplane")
                }
            } label: {
                Image(systemName: "plus.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
            }

            Button { activeSheet = .settings } label: {
                Image(systemName: "gearshape.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
            }

            Button { sendFeedback() } label: {
                Image(systemName: "envelope.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
            }
        }
        .padding(12)
    }

    @ToolbarContentBuilder
    private var iOSToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Menu {
                Button { activeSheet = .igcImporter } label: {
                    Label("Open IGC File", systemImage: "doc")
                }
                Button { activeSheet = .taskImporter } label: {
                    Label("Open Task File", systemImage: "map")
                }
                Button { activeSheet = .airScore } label: {
                    Label("Load AirScore Task", systemImage: "cloud.fill")
                }
                Divider()
                Button {
                    DispatchQueue.main.async { openSampleFlight() }
                } label: {
                    Label("Sample Flight", systemImage: "paperplane")
                }
            } label: {
                Image(systemName: "plus.circle")
            }

            Button { activeSheet = .settings } label: {
                Image(systemName: "gearshape")
            }

            Button { sendFeedback() } label: {
                Image(systemName: "envelope")
            }
        }
    }
    #endif

    // MARK: - Shared Views

    private var mapDetailView: some View {
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
                    #if os(iOS)
                    .padding(.top, 32) // avoid iPhone menu buttons
                    #endif
            }
        }
        .overlay(alignment: .center) {
            if viewModel.isLoading {
                ProgressView("Loading...")
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            }
        }
        #if os(macOS)
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
        #endif
    }

    // MARK: - File Import

    private var igcContentTypes: [UTType] {
        [UTType(filenameExtension: "igc") ?? .plainText, .plainText]
    }

    private var taskContentTypes: [UTType] {
        [UTType(filenameExtension: "xctsk") ?? .json, .json]
    }

    private func handleFileImport(_ result: Result<URL, Error>, load: (URL) -> Void) {
        switch result {
        case .success(let url):
            let gotAccess = url.startAccessingSecurityScopedResource()
            defer {
                if gotAccess { url.stopAccessingSecurityScopedResource() }
            }
            load(url)
        case .failure(let error):
            viewModel.errorMessage = error.localizedDescription
        }
    }

    #if os(iOS)
    private func sendFeedback() {
        let email = "tushar.pokle@gmail.com"
        if let url = URL(string: "mailto:\(email)?subject=TaskScore%20Feedback%20for%20you") {
            openURL(url) { accepted in
                if !accepted {
                    UIPasteboard.general.string = email
                    viewModel.errorMessage = "Email Tushar at \(email) (copied to your clipboard)"
                }
            }
        }
    }
    #endif

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

// MARK: - iPhone Bottom Panel

#if os(iOS)
/// Height state for the draggable bottom panel
enum PanelDetent {
    case collapsed, medium, large

    func height(maxHeight: CGFloat) -> CGFloat {
        switch self {
        case .collapsed: return 80
        case .medium: return maxHeight * 0.45
        case .large: return maxHeight
        }
    }
}

/// A draggable bottom panel overlay (replaces .sheet to avoid multiple-sheet conflicts)
struct BottomPanelView<Content: View>: View {
    @Binding var detent: PanelDetent
    let maxHeight: CGFloat
    @ViewBuilder let content: () -> Content

    @State private var dragOffset: CGFloat = 0

    private var panelHeight: CGFloat {
        max(80, detent.height(maxHeight: maxHeight) - dragOffset)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Drag handle
            Capsule()
                .fill(Color.secondary.opacity(0.5))
                .frame(width: 36, height: 5)
                .padding(.top, 8)
                .padding(.bottom, 4)

            content()

            Spacer(minLength: 0)
        }
        .frame(height: panelHeight, alignment: .top)
        .frame(maxWidth: .infinity)
        .background(.regularMaterial)
        .gesture(
            DragGesture()
                .onChanged { value in
                    dragOffset = value.translation.height
                }
                .onEnded { value in
                    let currentHeight = detent.height(maxHeight: maxHeight)
                    let projected = currentHeight - value.predictedEndTranslation.height
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        detent = closestDetent(for: projected)
                        dragOffset = 0
                    }
                }
        )
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: detent)
    }

    private func closestDetent(for height: CGFloat) -> PanelDetent {
        let detents: [PanelDetent] = [.collapsed, .medium, .large]
        return detents.min(by: {
            abs($0.height(maxHeight: maxHeight) - height) < abs($1.height(maxHeight: maxHeight) - height)
        }) ?? .collapsed
    }
}

/// Identifiable enum for single-sheet presentation on iOS
enum iOSSheet: String, Identifiable {
    case settings, airScore, igcImporter, taskImporter
    var id: String { rawValue }
}

/// Wrapper that presents a document picker and auto-dismisses after selection
struct iOSFileImporter: View {
    let contentTypes: [UTType]
    let onLoad: (URL) -> Void
    let onError: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showPicker = true

    var body: some View {
        Color.clear
            .fileImporter(isPresented: $showPicker, allowedContentTypes: contentTypes) { result in
                switch result {
                case .success(let url):
                    let gotAccess = url.startAccessingSecurityScopedResource()
                    defer {
                        if gotAccess { url.stopAccessingSecurityScopedResource() }
                    }
                    onLoad(url)
                case .failure(let error):
                    onError(error.localizedDescription)
                }
                dismiss()
            }
            .onChange(of: showPicker) { _, newValue in
                // User cancelled the file picker
                if !newValue { dismiss() }
            }
    }
}
#endif

// MARK: - FocusedValue for event filter binding

#if os(macOS)
struct EventFilterKey: FocusedValueKey {
    typealias Value = Binding<EventFilter>
}

extension FocusedValues {
    var eventFilter: Binding<EventFilter>? {
        get { self[EventFilterKey.self] }
        set { self[EventFilterKey.self] = newValue }
    }
}
#endif

/// View model managing flight data and analysis
@Observable
class FlightViewModel {
    var igcFile: IGCFileData?
    var fixes: [IGCFix] = []
    var events: [FlightEvent] = []
    var task: XCTask?
    var summary: FlightSummary?
    var isLoading = false
    var errorMessage: String? {
        didSet {
            if let msg = errorMessage {
                print("[TaskScore Error] \(msg)")
            }
        }
    }
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
            self.taskDistanceMeters = TaskOptimizer.calculateOptimizedTaskDistance(task)
        } else {
            self.taskDistanceMeters = nil
        }
    }
}
