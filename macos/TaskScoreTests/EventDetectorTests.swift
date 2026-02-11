import Testing
import Foundation
@testable import TaskScoreLib

/// Helper to create a mock fix at a given time offset (in minutes from base)
func createFix(
    timeMinutes: Int,
    lat: Double,
    lon: Double,
    altitude: Int,
    baseDate: Date = makeDate(2024, 1, 15, 10, 0, 0)
) -> IGCFix {
    let time = baseDate.addingTimeInterval(Double(timeMinutes) * 60)
    return IGCFix(
        time: time,
        latitude: lat,
        longitude: lon,
        pressureAltitude: altitude,
        gnssAltitude: altitude,
        valid: true
    )
}

/// Helper to create a fix at a specific second offset
func createFixAtSeconds(
    _ seconds: Double,
    lat: Double,
    lon: Double,
    altitude: Int,
    baseDate: Date = makeDate(2024, 1, 15, 14, 0, 0)
) -> IGCFix {
    let time = baseDate.addingTimeInterval(seconds)
    return IGCFix(
        time: time,
        latitude: lat,
        longitude: lon,
        pressureAltitude: altitude,
        gnssAltitude: altitude,
        valid: true
    )
}

/// Create a UTC date from components
func makeDate(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int, _ second: Int) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    var components = DateComponents()
    components.year = year
    components.month = month
    components.day = day
    components.hour = hour
    components.minute = minute
    components.second = second
    return calendar.date(from: components)!
}

/// Helper to create a simple flight track
func createFlightTrack(durationMinutes: Int) -> [IGCFix] {
    var fixes: [IGCFix] = []
    let startLat = 47.0
    let startLon = 11.0

    for i in 0...durationMinutes {
        let progress = Double(i) / Double(durationMinutes)
        let lat = startLat + progress * 0.5
        let lon = startLon + progress * 0.5

        var altitude = 500
        if i > 5 && i < 20 {
            altitude = 500 + (i - 5) * 100
        } else if i >= 20 && i < 40 {
            altitude = 2000 - (i - 20) * 30
        } else if i >= 40 && i < 60 {
            altitude = 1400 + (i - 40) * 50
        } else if i >= 60 {
            altitude = 2400 - (i - 60) * 50
        }

        fixes.append(createFix(timeMinutes: i, lat: lat, lon: lon, altitude: altitude))
    }

    return fixes
}

/// Create a track with 30 minutes of pre-flight stationary time, then takeoff
func createTrackWithPreTakeoff() -> [IGCFix] {
    var fixes: [IGCFix] = []
    let startTime = makeDate(2024, 1, 15, 14, 0, 0)

    // Pre-takeoff: 30 minutes on the ground (stationary or slow walking)
    for i in 0..<30 {
        let time = startTime.addingTimeInterval(Double(i) * 60)
        let lat = 47.0 + (Double(i) * 0.00001)
        let lon = 11.0 + (Double(i) * 0.00001)
        fixes.append(IGCFix(time: time, latitude: lat, longitude: lon,
                            pressureAltitude: 500, gnssAltitude: 500, valid: true))
    }

    // Takeoff at 2:30pm - rapid position change
    let takeoffTime = startTime.addingTimeInterval(30 * 60)
    for i in 0..<5 {
        let time = takeoffTime.addingTimeInterval(Double(i))
        let lat = 47.0 + 0.0003 + (Double(i) * 0.001)
        let lon = 11.0 + 0.0003 + (Double(i) * 0.001)
        let alt = 500 + (i * 50)
        fixes.append(IGCFix(time: time, latitude: lat, longitude: lon,
                            pressureAltitude: alt, gnssAltitude: alt, valid: true))
    }

    // Post-takeoff flight: thermal
    let postTakeoffStart = takeoffTime.addingTimeInterval(60)
    for i in 0..<40 {
        let time = postTakeoffStart.addingTimeInterval(Double(i) * 5)
        let angle = (Double(i) / 40.0) * 2 * .pi * 3
        let lat = 47.002 + sin(angle) * 0.001
        let lon = 11.002 + cos(angle) * 0.001
        let alt = 750 + (i * 30)
        fixes.append(IGCFix(time: time, latitude: lat, longitude: lon,
                            pressureAltitude: alt, gnssAltitude: alt, valid: true))
    }

    // Glide after thermal
    let glideStart = postTakeoffStart.addingTimeInterval(40 * 5)
    for i in 0..<20 {
        let time = glideStart.addingTimeInterval(Double(i) * 5)
        let lat = 47.003 + (Double(i) * 0.002)
        let lon = 11.003 + (Double(i) * 0.002)
        let alt = 1950 - (i * 40)
        fixes.append(IGCFix(time: time, latitude: lat, longitude: lon,
                            pressureAltitude: alt, gnssAltitude: alt, valid: true))
    }

    return fixes
}

@Suite("Event Detector")
struct EventDetectorTests {

    @Suite("detectFlightEvents")
    struct DetectFlightEvents {

        @Test("should detect takeoff and landing")
        func detectTakeoffLanding() {
            let fixes = createFlightTrack(durationMinutes: 90)
            let events = EventDetector.detectFlightEvents(fixes)

            let takeoff = events.first(where: { $0.type == .takeoff })
            let landing = events.first(where: { $0.type == .landing })

            #expect(takeoff != nil)
            #expect(landing != nil)
        }

        @Test("should detect altitude extremes")
        func detectAltitudeExtremes() {
            let fixes = createFlightTrack(durationMinutes: 90)
            let events = EventDetector.detectFlightEvents(fixes)

            let maxAlt = events.first(where: { $0.type == .maxAltitude })
            let minAlt = events.first(where: { $0.type == .minAltitude })

            #expect(maxAlt != nil)
            #expect(minAlt != nil)
            #expect(maxAlt!.altitude > minAlt!.altitude)
        }

        @Test("should detect thermal entry and exit")
        func detectThermals() {
            let fixes = createFlightTrack(durationMinutes: 90)
            let events = EventDetector.detectFlightEvents(fixes)

            let thermalEntries = events.filter { $0.type == .thermalEntry }
            let thermalExits = events.filter { $0.type == .thermalExit }

            #expect(thermalEntries.count >= 1)
            #expect(thermalExits.count >= 1)
        }

        @Test("should detect turnpoint crossings when task is provided")
        func detectTurnpointCrossings() {
            var fixes: [IGCFix] = []
            let taskCenter = (lat: 47.2, lon: 11.2)

            // Pre-flight fixes
            for i in 0..<5 {
                fixes.append(createFix(timeMinutes: i, lat: 47.0, lon: 11.0, altitude: 500))
            }

            // Takeoff with rapid movement
            for i in 5..<10 {
                let lat = 47.0 + Double(i - 5) * 0.002
                let lon = 11.0 + Double(i - 5) * 0.002
                fixes.append(createFix(timeMinutes: i, lat: lat, lon: lon, altitude: 500 + (i - 5) * 50))
            }

            // Track that enters and exits a turnpoint cylinder
            for i in 0..<60 {
                let angle = (Double(i) / 60.0) * .pi
                let radius = 0.005
                let lat = taskCenter.lat + sin(angle) * radius
                let lon = taskCenter.lon + cos(angle) * radius - 0.01

                fixes.append(createFix(timeMinutes: i + 10, lat: lat, lon: lon, altitude: 1500))
            }

            let task = XCTask(
                taskType: "CLASSIC",
                version: 1,
                turnpoints: [
                    XCTaskTurnpoint(
                        type: "SSS",
                        radius: 400,
                        waypoint: XCTaskWaypoint(name: "Start", lat: taskCenter.lat, lon: taskCenter.lon)
                    ),
                ]
            )

            let events = EventDetector.detectFlightEvents(fixes, task: task)
            let startCrossing = events.first(where: { $0.type == .startCrossing })

            #expect(startCrossing != nil)
        }

        @Test("should sort events by time")
        func sortByTime() {
            let fixes = createFlightTrack(durationMinutes: 90)
            let events = EventDetector.detectFlightEvents(fixes)

            for i in 1..<events.count {
                #expect(events[i].time >= events[i - 1].time)
            }
        }
    }

    @Suite("Takeoff First Requirement")
    struct TakeoffFirst {

        @Test("should have takeoff as the first event chronologically")
        func takeoffFirst() {
            let fixes = createTrackWithPreTakeoff()
            let events = EventDetector.detectFlightEvents(fixes)

            #expect(events.count > 0)
            #expect(events[0].type == .takeoff)
        }

        @Test("should have takeoff at ~2:30pm when tracklog starts at 2pm")
        func takeoffTiming() {
            let fixes = createTrackWithPreTakeoff()
            let events = EventDetector.detectFlightEvents(fixes)

            let takeoff = events.first(where: { $0.type == .takeoff })
            #expect(takeoff != nil)

            let expectedTime = makeDate(2024, 1, 15, 14, 30, 0)
            let timeDiff = abs(takeoff!.time.timeIntervalSince(expectedTime))
            #expect(timeDiff < 60) // Within 1 minute
        }

        @Test("should not detect thermals before takeoff")
        func noThermalsBeforeTakeoff() {
            let fixes = createTrackWithPreTakeoff()
            let events = EventDetector.detectFlightEvents(fixes)

            let takeoff = events.first(where: { $0.type == .takeoff })!
            let thermalEvents = events.filter { $0.type == .thermalEntry || $0.type == .thermalExit }

            for thermal in thermalEvents {
                #expect(thermal.time >= takeoff.time)
            }
        }

        @Test("should not detect glides before takeoff")
        func noGlidesBeforeTakeoff() {
            let fixes = createTrackWithPreTakeoff()
            let events = EventDetector.detectFlightEvents(fixes)

            let takeoff = events.first(where: { $0.type == .takeoff })!
            let glideEvents = events.filter { $0.type == .glideStart || $0.type == .glideEnd }

            for glide in glideEvents {
                #expect(glide.time >= takeoff.time)
            }
        }
    }

    @Suite("Edge cases")
    struct EdgeCases {

        @Test("should handle tracklog with no clear takeoff")
        func noTakeoff() {
            var fixes: [IGCFix] = []
            let startTime = makeDate(2024, 1, 15, 14, 0, 0)

            for i in 0..<60 {
                let time = startTime.addingTimeInterval(Double(i))
                fixes.append(IGCFix(time: time, latitude: 47.0, longitude: 11.0,
                                    pressureAltitude: 500, gnssAltitude: 500, valid: true))
            }

            let events = EventDetector.detectFlightEvents(fixes)

            let takeoff = events.first(where: { $0.type == .takeoff })
            #expect(takeoff == nil)

            let thermals = events.filter { $0.type == .thermalEntry || $0.type == .thermalExit }
            let glides = events.filter { $0.type == .glideStart || $0.type == .glideEnd }
            #expect(thermals.count == 0)
            #expect(glides.count == 0)
        }

        @Test("should handle immediate takeoff (no pre-flight period)")
        func immediateTakeoff() {
            var fixes: [IGCFix] = []
            let startTime = makeDate(2024, 1, 15, 14, 0, 0)

            for i in 0..<60 {
                let time = startTime.addingTimeInterval(Double(i))
                let lat = 47.0 + (Double(i) * 0.001)
                let lon = 11.0 + (Double(i) * 0.001)
                let alt = 500 + (i * 10)
                fixes.append(IGCFix(time: time, latitude: lat, longitude: lon,
                                    pressureAltitude: alt, gnssAltitude: alt, valid: true))
            }

            let events = EventDetector.detectFlightEvents(fixes)

            let takeoff = events.first(where: { $0.type == .takeoff })
            #expect(takeoff != nil)
            #expect(takeoff!.time.timeIntervalSince(startTime) <= 5)
        }
    }

    @Suite("filterEventsByBounds")
    struct FilterByBounds {

        @Test("should filter events within bounds")
        func filterWithinBounds() {
            let events: [FlightEvent] = [
                FlightEvent(id: "1", type: .thermalEntry, time: Date(),
                           latitude: 47.5, longitude: 11.5, altitude: 1500, description: "Thermal 1"),
                FlightEvent(id: "2", type: .thermalEntry, time: Date(),
                           latitude: 48.5, longitude: 12.5, altitude: 1500, description: "Thermal 2"),
                FlightEvent(id: "3", type: .thermalEntry, time: Date(),
                           latitude: 47.0, longitude: 11.0, altitude: 1500, description: "Thermal 3"),
            ]

            let filtered = EventDetector.filterEventsByBounds(
                events,
                bounds: (north: 48.0, south: 47.0, east: 12.0, west: 11.0)
            )

            #expect(filtered.count == 2)
            #expect(filtered.map(\.id).contains("1"))
            #expect(filtered.map(\.id).contains("3"))
            #expect(!filtered.map(\.id).contains("2"))
        }
    }

    @Suite("getEventStyle")
    struct GetEventStyle {

        @Test("should return correct colors for event types")
        func correctColors() {
            #expect(EventDetector.getEventStyle(.takeoff).color == "#22c55e")
            #expect(EventDetector.getEventStyle(.landing).color == "#ef4444")
            #expect(EventDetector.getEventStyle(.thermalEntry).color == "#f97316")
            #expect(EventDetector.getEventStyle(.startCrossing).color == "#22c55e")
            #expect(EventDetector.getEventStyle(.goalCrossing).color == "#eab308")
        }

        @Test("should return icon names for all event types")
        func allEventTypesHaveStyles() {
            for type in FlightEventType.allCases {
                let style = EventDetector.getEventStyle(type)
                #expect(!style.icon.isEmpty)
                #expect(!style.color.isEmpty)
            }
        }
    }
}
