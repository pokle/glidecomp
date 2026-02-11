import Foundation

/// Flight Event Detector
/// Analyzes IGC track data to detect meaningful flight events.
public enum EventDetector {

    // MARK: - Private helpers

    /// Calculate vertical speed between two fixes (m/s)
    private static func calculateVario(_ fix1: IGCFix, _ fix2: IGCFix) -> Double {
        let timeDiff = fix2.time.timeIntervalSince(fix1.time)
        guard timeDiff > 0 else { return 0 }
        let altDiff = Double(fix2.gnssAltitude - fix1.gnssAltitude)
        return altDiff / timeDiff
    }

    /// Calculate ground speed between two fixes (m/s)
    private static func calculateGroundSpeed(_ fix1: IGCFix, _ fix2: IGCFix) -> Double {
        let timeDiff = fix2.time.timeIntervalSince(fix1.time)
        guard timeDiff > 0 else { return 0 }
        let distance = Geo.haversineDistance(
            lat1: fix1.latitude, lon1: fix1.longitude,
            lat2: fix2.latitude, lon2: fix2.longitude
        )
        return distance / timeDiff
    }

    // MARK: - Thermal detection

    /// Detect thermal segments in the flight
    private static func detectThermals(_ fixes: [IGCFix], windowSize: Int = 10) -> [ThermalSegment] {
        var thermals: [ThermalSegment] = []
        let minClimbRate: Double = 0.5
        let minDuration: Double = 20
        let exitThreshold = 3
        let minGapDuration: Double = 20

        var inThermal = false
        var thermalStart = 0
        var exitCounter = 0
        var lastThermalEnd = -1

        for i in windowSize..<fixes.count {
            var totalClimb: Double = 0
            var totalTime: Double = 0

            for j in (i - windowSize)..<i {
                let dt = fixes[j + 1].time.timeIntervalSince(fixes[j].time)
                let da = Double(fixes[j + 1].gnssAltitude - fixes[j].gnssAltitude)
                totalClimb += da
                totalTime += dt
            }

            let avgClimb = totalTime > 0 ? totalClimb / totalTime : 0

            if !inThermal && avgClimb > minClimbRate {
                let potentialStart = i - windowSize
                let timeSinceLastThermal: Double = lastThermalEnd >= 0
                    ? fixes[potentialStart].time.timeIntervalSince(fixes[lastThermalEnd].time)
                    : .infinity

                if potentialStart > lastThermalEnd && timeSinceLastThermal >= minGapDuration {
                    inThermal = true
                    thermalStart = potentialStart
                    exitCounter = 0
                }
            } else if inThermal {
                if avgClimb <= minClimbRate {
                    exitCounter += 1

                    if exitCounter >= exitThreshold {
                        let thermalEnd = i - exitThreshold
                        let duration = fixes[thermalEnd].time.timeIntervalSince(fixes[thermalStart].time)

                        if duration >= minDuration {
                            var sumLat: Double = 0
                            var sumLon: Double = 0
                            var count: Double = 0

                            for j in thermalStart...thermalEnd {
                                sumLat += fixes[j].latitude
                                sumLon += fixes[j].longitude
                                count += 1
                            }

                            let altGain = Double(fixes[thermalEnd].gnssAltitude - fixes[thermalStart].gnssAltitude)

                            thermals.append(ThermalSegment(
                                startIndex: thermalStart,
                                endIndex: thermalEnd,
                                startAltitude: Double(fixes[thermalStart].gnssAltitude),
                                endAltitude: Double(fixes[thermalEnd].gnssAltitude),
                                avgClimbRate: altGain / duration,
                                duration: duration,
                                location: (lat: sumLat / count, lon: sumLon / count)
                            ))
                            lastThermalEnd = thermalEnd
                        }

                        inThermal = false
                        exitCounter = 0
                    }
                } else {
                    exitCounter = 0
                }
            }
        }

        // Handle thermal that's still active at end of flight
        if inThermal {
            let thermalEnd = fixes.count - 1
            let duration = fixes[thermalEnd].time.timeIntervalSince(fixes[thermalStart].time)

            if duration >= minDuration {
                var sumLat: Double = 0
                var sumLon: Double = 0
                var count: Double = 0

                for j in thermalStart...thermalEnd {
                    sumLat += fixes[j].latitude
                    sumLon += fixes[j].longitude
                    count += 1
                }

                let altGain = Double(fixes[thermalEnd].gnssAltitude - fixes[thermalStart].gnssAltitude)

                thermals.append(ThermalSegment(
                    startIndex: thermalStart,
                    endIndex: thermalEnd,
                    startAltitude: Double(fixes[thermalStart].gnssAltitude),
                    endAltitude: Double(fixes[thermalEnd].gnssAltitude),
                    avgClimbRate: altGain / duration,
                    duration: duration,
                    location: (lat: sumLat / count, lon: sumLon / count)
                ))
            }
        }

        return thermals
    }

    // MARK: - Glide detection

    /// Detect glide segments between thermals
    private static func detectGlides(_ fixes: [IGCFix], thermals: [ThermalSegment]) -> [GlideSegment] {
        var glides: [GlideSegment] = []
        let sortedThermals = thermals.sorted { $0.startIndex < $1.startIndex }

        var prevEnd = 0

        for thermal in sortedThermals {
            if thermal.startIndex > prevEnd + 10 {
                let startIdx = prevEnd
                let endIdx = thermal.startIndex - 1

                let duration = fixes[endIdx].time.timeIntervalSince(fixes[startIdx].time)

                if duration > 30 {
                    var totalDist: Double = 0
                    for i in startIdx..<endIdx {
                        totalDist += Geo.haversineDistance(
                            lat1: fixes[i].latitude, lon1: fixes[i].longitude,
                            lat2: fixes[i + 1].latitude, lon2: fixes[i + 1].longitude
                        )
                    }

                    let altLoss = Double(fixes[startIdx].gnssAltitude - fixes[endIdx].gnssAltitude)
                    let glideRatio = altLoss > 0 ? totalDist / altLoss : Double.infinity

                    glides.append(GlideSegment(
                        startIndex: startIdx,
                        endIndex: endIdx,
                        startAltitude: Double(fixes[startIdx].gnssAltitude),
                        endAltitude: Double(fixes[endIdx].gnssAltitude),
                        distance: totalDist,
                        glideRatio: glideRatio,
                        duration: duration
                    ))
                }
            }
            prevEnd = thermal.endIndex
        }

        // Trailing glide
        let lastIdx = fixes.count - 1
        if lastIdx > prevEnd + 10 {
            let startIdx = prevEnd
            let endIdx = lastIdx
            let duration = fixes[endIdx].time.timeIntervalSince(fixes[startIdx].time)

            if duration > 30 {
                var totalDist: Double = 0
                for i in startIdx..<endIdx {
                    totalDist += Geo.haversineDistance(
                        lat1: fixes[i].latitude, lon1: fixes[i].longitude,
                        lat2: fixes[i + 1].latitude, lon2: fixes[i + 1].longitude
                    )
                }

                let altLoss = Double(fixes[startIdx].gnssAltitude - fixes[endIdx].gnssAltitude)
                let glideRatio = altLoss > 0 ? totalDist / altLoss : Double.infinity

                glides.append(GlideSegment(
                    startIndex: startIdx,
                    endIndex: endIdx,
                    startAltitude: Double(fixes[startIdx].gnssAltitude),
                    endAltitude: Double(fixes[endIdx].gnssAltitude),
                    distance: totalDist,
                    glideRatio: glideRatio,
                    duration: duration
                ))
            }
        }

        return glides
    }

    // MARK: - Turnpoint crossings

    /// Detect turnpoint cylinder crossings
    private static func detectTurnpointCrossings(_ fixes: [IGCFix], task: XCTask) -> [FlightEvent] {
        var events: [FlightEvent] = []

        for tpIdx in 0..<task.turnpoints.count {
            let tp = task.turnpoints[tpIdx]
            var wasInside = false
            var entryDetected = false

            for i in 0..<fixes.count {
                let fix = fixes[i]
                let inside = Geo.isInsideCylinder(
                    lat: fix.latitude, lon: fix.longitude,
                    centerLat: tp.waypoint.lat, centerLon: tp.waypoint.lon,
                    radius: tp.radius
                )

                if inside && !wasInside {
                    let eventType: FlightEventType
                    if tp.type == "SSS" {
                        eventType = .startCrossing
                    } else if tpIdx == task.turnpoints.count - 1 {
                        eventType = .goalCrossing
                    } else {
                        eventType = .turnpointEntry
                    }

                    events.append(FlightEvent(
                        id: "tp-entry-\(tpIdx)-\(i)",
                        type: eventType,
                        time: fix.time,
                        latitude: fix.latitude,
                        longitude: fix.longitude,
                        altitude: Double(fix.gnssAltitude),
                        description: "Entered \(tp.waypoint.name) (\(tp.type ?? "TP\(tpIdx + 1)"))",
                        details: [
                            "turnpointIndex": Double(tpIdx),
                            "radius": tp.radius,
                        ]
                    ))
                    entryDetected = true
                } else if !inside && wasInside && entryDetected {
                    events.append(FlightEvent(
                        id: "tp-exit-\(tpIdx)-\(i)",
                        type: .turnpointExit,
                        time: fix.time,
                        latitude: fix.latitude,
                        longitude: fix.longitude,
                        altitude: Double(fix.gnssAltitude),
                        description: "Exited \(tp.waypoint.name)",
                        details: ["turnpointIndex": Double(tpIdx)]
                    ))
                }

                wasInside = inside
            }
        }

        return events
    }

    // MARK: - Takeoff and landing detection

    /// Detect takeoff and landing using multiple criteria
    private static func detectTakeoffLanding(_ fixes: [IGCFix]) -> [FlightEvent] {
        var events: [FlightEvent] = []

        guard fixes.count >= 10 else { return events }

        let minGroundSpeed: Double = 5
        let minAltitudeGain: Double = 50
        let minClimbRate: Double = 1.0
        let takeoffTimeWindow: Double = 10
        let landingTimeWindow: Double = 30

        // Find starting altitude (average of first few fixes)
        var startAltitude: Double = 0
        let startSampleSize = min(10, fixes.count)
        for i in 0..<startSampleSize {
            startAltitude += Double(fixes[i].gnssAltitude)
        }
        startAltitude /= Double(startSampleSize)

        // === TAKEOFF DETECTION ===
        var takeoffIndex = -1

        for i in 1..<fixes.count {
            var criteriaMetCount = 0

            // Criteria 1: Instant ground speed check
            if i < fixes.count - 1 {
                let speed = calculateGroundSpeed(fixes[i - 1], fixes[i])
                if speed > minGroundSpeed {
                    criteriaMetCount += 1
                }
            }

            // Criteria 2: Current altitude gain above start
            let altitudeGain = Double(fixes[i].gnssAltitude) - startAltitude
            if altitudeGain > minAltitudeGain {
                criteriaMetCount += 1
            }

            // Criteria 3: Recent climb rate
            let climbWindowSize = min(5, i)
            if climbWindowSize > 0 {
                let climbStartIdx = i - climbWindowSize
                let climbDuration = fixes[i].time.timeIntervalSince(fixes[climbStartIdx].time)
                let altitudeChange = Double(fixes[i].gnssAltitude - fixes[climbStartIdx].gnssAltitude)
                let avgClimbRate = climbDuration > 0 ? altitudeChange / climbDuration : 0

                if avgClimbRate > minClimbRate {
                    criteriaMetCount += 1
                }
            }

            // Found flight indication - verify it sustains
            if criteriaMetCount >= 1 {
                let verifyEndTime = fixes[i].time.timeIntervalSince1970 + takeoffTimeWindow
                var verifyEndIndex = i

                for j in (i + 1)..<fixes.count {
                    if fixes[j].time.timeIntervalSince1970 >= verifyEndTime {
                        verifyEndIndex = j
                        break
                    }
                }

                if verifyEndIndex > i {
                    var stillFlying = false

                    let futureAltGain = Double(fixes[verifyEndIndex].gnssAltitude) - startAltitude
                    if futureAltGain > minAltitudeGain {
                        stillFlying = true
                    }

                    let windowDuration = fixes[verifyEndIndex].time.timeIntervalSince(fixes[i].time)
                    let windowAltChange = Double(fixes[verifyEndIndex].gnssAltitude - fixes[i].gnssAltitude)
                    let windowClimbRate = windowDuration > 0 ? windowAltChange / windowDuration : 0

                    if windowClimbRate > minClimbRate {
                        stillFlying = true
                    }

                    for j in i..<(verifyEndIndex - 1) {
                        let speed = calculateGroundSpeed(fixes[j], fixes[j + 1])
                        if speed > minGroundSpeed {
                            stillFlying = true
                            break
                        }
                    }

                    if stillFlying {
                        takeoffIndex = i
                        break
                    }
                }
            }
        }

        if takeoffIndex >= 0 {
            let takeoffFix = fixes[takeoffIndex]
            events.append(FlightEvent(
                id: "takeoff",
                type: .takeoff,
                time: takeoffFix.time,
                latitude: takeoffFix.latitude,
                longitude: takeoffFix.longitude,
                altitude: Double(takeoffFix.gnssAltitude),
                description: "Takeoff",
                details: [
                    "startAltitude": startAltitude,
                    "altitudeGain": Double(takeoffFix.gnssAltitude) - startAltitude,
                ]
            ))
        }

        // === LANDING DETECTION ===
        var landingIndex = -1

        for i in stride(from: fixes.count - 2, through: Int(landingTimeWindow), by: -1) {
            let windowStartTime = fixes[i].time.timeIntervalSince1970 - landingTimeWindow

            var windowStartIndex = i
            for j in stride(from: i, through: 0, by: -1) {
                if fixes[j].time.timeIntervalSince1970 <= windowStartTime {
                    windowStartIndex = j
                    break
                }
            }

            if windowStartIndex == i { continue }

            var stillFlying = false

            // Check 1: Any significant ground speed?
            for j in windowStartIndex..<i {
                let speed = calculateGroundSpeed(fixes[j], fixes[j + 1])
                if speed > minGroundSpeed / 2 {
                    stillFlying = true
                    break
                }
            }

            // Check 2: Still descending?
            if !stillFlying {
                let altChange = Double(fixes[i].gnssAltitude - fixes[windowStartIndex].gnssAltitude)
                let timeDiff = fixes[i].time.timeIntervalSince(fixes[windowStartIndex].time)
                let vario = timeDiff > 0 ? altChange / timeDiff : 0

                if vario < -0.5 {
                    stillFlying = true
                }
            }

            if stillFlying {
                landingIndex = i
                break
            }
        }

        if landingIndex >= 0 {
            let landingFix = fixes[landingIndex]
            events.append(FlightEvent(
                id: "landing",
                type: .landing,
                time: landingFix.time,
                latitude: landingFix.latitude,
                longitude: landingFix.longitude,
                altitude: Double(landingFix.gnssAltitude),
                description: "Landing"
            ))
        }

        return events
    }

    // MARK: - Altitude extremes

    /// Detect altitude extremes
    private static func detectAltitudeExtremes(_ fixes: [IGCFix]) -> [FlightEvent] {
        var events: [FlightEvent] = []
        guard !fixes.isEmpty else { return events }

        var maxAlt = fixes[0].gnssAltitude
        var minAlt = fixes[0].gnssAltitude
        var maxAltIdx = 0
        var minAltIdx = 0

        for i in 1..<fixes.count {
            if fixes[i].gnssAltitude > maxAlt {
                maxAlt = fixes[i].gnssAltitude
                maxAltIdx = i
            }
            if fixes[i].gnssAltitude < minAlt {
                minAlt = fixes[i].gnssAltitude
                minAltIdx = i
            }
        }

        events.append(FlightEvent(
            id: "max-altitude",
            type: .maxAltitude,
            time: fixes[maxAltIdx].time,
            latitude: fixes[maxAltIdx].latitude,
            longitude: fixes[maxAltIdx].longitude,
            altitude: Double(maxAlt),
            description: "Max altitude: \(maxAlt)m"
        ))

        events.append(FlightEvent(
            id: "min-altitude",
            type: .minAltitude,
            time: fixes[minAltIdx].time,
            latitude: fixes[minAltIdx].latitude,
            longitude: fixes[minAltIdx].longitude,
            altitude: Double(minAlt),
            description: "Min altitude: \(minAlt)m"
        ))

        return events
    }

    // MARK: - Vario extremes

    /// Detect max climb and sink rates
    private static func detectVarioExtremes(_ fixes: [IGCFix]) -> [FlightEvent] {
        var events: [FlightEvent] = []
        let windowSize = 10

        guard fixes.count >= windowSize * 2 else { return events }

        var maxClimb: Double = 0
        var maxSink: Double = 0
        var maxClimbIdx = 0
        var maxSinkIdx = 0

        for i in windowSize..<fixes.count {
            let vario = calculateVario(fixes[i - windowSize], fixes[i])

            if vario > maxClimb {
                maxClimb = vario
                maxClimbIdx = i
            }
            if vario < maxSink {
                maxSink = vario
                maxSinkIdx = i
            }
        }

        if maxClimb > 0.5 {
            events.append(FlightEvent(
                id: "max-climb",
                type: .maxClimb,
                time: fixes[maxClimbIdx].time,
                latitude: fixes[maxClimbIdx].latitude,
                longitude: fixes[maxClimbIdx].longitude,
                altitude: Double(fixes[maxClimbIdx].gnssAltitude),
                description: String(format: "Max climb: +%.1fm/s", maxClimb),
                details: ["climbRate": maxClimb]
            ))
        }

        if maxSink < -1 {
            events.append(FlightEvent(
                id: "max-sink",
                type: .maxSink,
                time: fixes[maxSinkIdx].time,
                latitude: fixes[maxSinkIdx].latitude,
                longitude: fixes[maxSinkIdx].longitude,
                altitude: Double(fixes[maxSinkIdx].gnssAltitude),
                description: String(format: "Max sink: %.1fm/s", maxSink),
                details: ["sinkRate": maxSink]
            ))
        }

        return events
    }

    // MARK: - Public API

    /// Main function to detect all flight events
    public static func detectFlightEvents(
        _ fixes: [IGCFix],
        task: XCTask? = nil
    ) -> [FlightEvent] {
        var allEvents: [FlightEvent] = []

        // Detect takeoff and landing FIRST
        let takeoffLandingEvents = detectTakeoffLanding(fixes)
        allEvents.append(contentsOf: takeoffLandingEvents)

        // Find the takeoff event
        guard let takeoffEvent = takeoffLandingEvents.first(where: { $0.type == .takeoff }) else {
            return allEvents
        }

        // Find the index of the takeoff fix
        guard let takeoffIndex = fixes.firstIndex(where: {
            $0.time.timeIntervalSince1970 == takeoffEvent.time.timeIntervalSince1970
        }) else {
            return allEvents
        }

        // Slice fixes from takeoff onwards for analysis
        let flightFixes = Array(fixes[takeoffIndex...])
        let indexOffset = takeoffIndex

        // Detect thermals
        let thermals = detectThermals(flightFixes)

        for thermal in thermals {
            let adjustedStartIndex = thermal.startIndex + indexOffset
            let adjustedEndIndex = thermal.endIndex + indexOffset

            allEvents.append(FlightEvent(
                id: "thermal-entry-\(adjustedStartIndex)",
                type: .thermalEntry,
                time: fixes[adjustedStartIndex].time,
                latitude: thermal.location.lat,
                longitude: thermal.location.lon,
                altitude: thermal.startAltitude,
                description: String(format: "Thermal entry (%@%.1fm/s avg)",
                                    thermal.avgClimbRate > 0 ? "+" : "", thermal.avgClimbRate),
                details: [
                    "avgClimbRate": thermal.avgClimbRate,
                    "duration": thermal.duration,
                    "altitudeGain": thermal.endAltitude - thermal.startAltitude,
                ],
                segment: TrackSegment(startIndex: adjustedStartIndex, endIndex: adjustedEndIndex)
            ))

            allEvents.append(FlightEvent(
                id: "thermal-exit-\(adjustedEndIndex)",
                type: .thermalExit,
                time: fixes[adjustedEndIndex].time,
                latitude: thermal.location.lat,
                longitude: thermal.location.lon,
                altitude: thermal.endAltitude,
                description: String(format: "Thermal exit (%@%.0fm gained)",
                                    (thermal.endAltitude - thermal.startAltitude) > 0 ? "+" : "",
                                    thermal.endAltitude - thermal.startAltitude),
                details: [
                    "avgClimbRate": thermal.avgClimbRate,
                    "duration": thermal.duration,
                    "altitudeGain": thermal.endAltitude - thermal.startAltitude,
                ],
                segment: TrackSegment(startIndex: adjustedStartIndex, endIndex: adjustedEndIndex)
            ))
        }

        // Detect glides
        let glides = detectGlides(flightFixes, thermals: thermals)

        for glide in glides {
            let adjustedStartIndex = glide.startIndex + indexOffset
            let adjustedEndIndex = glide.endIndex + indexOffset

            let averageSpeed = glide.duration > 0 ? glide.distance / glide.duration : 0

            allEvents.append(FlightEvent(
                id: "glide-start-\(adjustedStartIndex)",
                type: .glideStart,
                time: fixes[adjustedStartIndex].time,
                latitude: fixes[adjustedStartIndex].latitude,
                longitude: fixes[adjustedStartIndex].longitude,
                altitude: glide.startAltitude,
                description: String(format: "Glide start (L/D %.0f)", glide.glideRatio),
                details: [
                    "distance": glide.distance,
                    "glideRatio": glide.glideRatio,
                    "duration": glide.duration,
                    "averageSpeed": averageSpeed,
                ],
                segment: TrackSegment(startIndex: adjustedStartIndex, endIndex: adjustedEndIndex)
            ))

            allEvents.append(FlightEvent(
                id: "glide-end-\(adjustedEndIndex)",
                type: .glideEnd,
                time: fixes[adjustedEndIndex].time,
                latitude: fixes[adjustedEndIndex].latitude,
                longitude: fixes[adjustedEndIndex].longitude,
                altitude: glide.endAltitude,
                description: String(format: "Glide end (%.2fkm)", glide.distance / 1000),
                details: [
                    "distance": glide.distance,
                    "glideRatio": glide.glideRatio,
                    "altitudeLost": glide.startAltitude - glide.endAltitude,
                    "averageSpeed": averageSpeed,
                ],
                segment: TrackSegment(startIndex: adjustedStartIndex, endIndex: adjustedEndIndex)
            ))
        }

        // Detect altitude extremes
        let altitudeEvents = detectAltitudeExtremes(flightFixes)
        allEvents.append(contentsOf: altitudeEvents)

        // Detect vario extremes
        let varioEvents = detectVarioExtremes(flightFixes)
        allEvents.append(contentsOf: varioEvents)

        // Detect turnpoint crossings if task provided
        if let task = task {
            let turnpointEvents = detectTurnpointCrossings(flightFixes, task: task)
            allEvents.append(contentsOf: turnpointEvents)
        }

        // Sort by time
        allEvents.sort { $0.time < $1.time }

        return allEvents
    }

    /// Filter events that are visible in a bounding box
    public static func filterEventsByBounds(
        _ events: [FlightEvent],
        bounds: (north: Double, south: Double, east: Double, west: Double)
    ) -> [FlightEvent] {
        events.filter { event in
            event.latitude >= bounds.south &&
            event.latitude <= bounds.north &&
            event.longitude >= bounds.west &&
            event.longitude <= bounds.east
        }
    }

    /// Get event icon/color based on type
    public static func getEventStyle(_ type: FlightEventType) -> EventStyle {
        switch type {
        case .takeoff:
            return EventStyle(icon: "plane-departure", color: "#22c55e")
        case .landing:
            return EventStyle(icon: "plane-arrival", color: "#ef4444")
        case .thermalEntry:
            return EventStyle(icon: "arrow-up", color: "#f97316")
        case .thermalExit:
            return EventStyle(icon: "arrow-down", color: "#f97316")
        case .glideStart:
            return EventStyle(icon: "arrow-right", color: "#3b82f6")
        case .glideEnd:
            return EventStyle(icon: "arrow-right", color: "#3b82f6")
        case .turnpointEntry:
            return EventStyle(icon: "map-pin", color: "#a855f7")
        case .turnpointExit:
            return EventStyle(icon: "map-pin", color: "#a855f7")
        case .startCrossing:
            return EventStyle(icon: "flag", color: "#22c55e")
        case .goalCrossing:
            return EventStyle(icon: "trophy", color: "#eab308")
        case .maxAltitude:
            return EventStyle(icon: "mountain", color: "#06b6d4")
        case .minAltitude:
            return EventStyle(icon: "valley", color: "#64748b")
        case .maxClimb:
            return EventStyle(icon: "trending-up", color: "#22c55e")
        case .maxSink:
            return EventStyle(icon: "trending-down", color: "#ef4444")
        }
    }
}
