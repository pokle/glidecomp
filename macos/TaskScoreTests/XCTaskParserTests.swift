import Testing
import Foundation
@testable import TaskScoreLib

@Suite("XCTask Parser")
struct XCTaskParserTests {

    @Suite("parseXCTask v1 format")
    struct V1Format {

        @Test("should parse a basic v1 task")
        func basicV1() throws {
            let taskJson = """
            {
                "taskType": "CLASSIC",
                "version": 1,
                "earthModel": "WGS84",
                "turnpoints": [
                    { "type": "SSS", "radius": 400, "waypoint": { "name": "Start", "lat": 47.0, "lon": 11.0 } },
                    { "radius": 1000, "waypoint": { "name": "TP1", "lat": 47.5, "lon": 11.5 } },
                    { "type": "ESS", "radius": 400, "waypoint": { "name": "Goal", "lat": 48.0, "lon": 12.0 } }
                ]
            }
            """

            let task = try XCTaskParser.parseXCTask(taskJson)

            #expect(task.taskType == "CLASSIC")
            #expect(task.version == 1)
            #expect(task.earthModel == "WGS84")
            #expect(task.turnpoints.count == 3)
            #expect(task.turnpoints[0].type == "SSS")
            #expect(task.turnpoints[0].waypoint.name == "Start")
            #expect(task.turnpoints[1].radius == 1000)
            #expect(task.turnpoints[2].type == "ESS")
        }

        @Test("should parse task with SSS and goal configuration")
        func sssAndGoal() throws {
            let taskJson = """
            {
                "taskType": "CLASSIC",
                "version": 1,
                "turnpoints": [
                    { "type": "SSS", "radius": 400, "waypoint": { "name": "Start", "lat": 47.0, "lon": 11.0 } },
                    { "type": "ESS", "radius": 400, "waypoint": { "name": "Goal", "lat": 48.0, "lon": 12.0 } }
                ],
                "sss": {
                    "type": "RACE",
                    "direction": "ENTER",
                    "timeGates": ["12:00:00Z", "12:30:00Z"]
                },
                "goal": {
                    "type": "LINE",
                    "deadline": "18:00:00Z"
                }
            }
            """

            let task = try XCTaskParser.parseXCTask(taskJson)

            #expect(task.sss != nil)
            #expect(task.sss!.type == "RACE")
            #expect(task.sss!.direction == "ENTER")
            #expect(task.sss!.timeGates?.count == 2)
            #expect(task.goal != nil)
            #expect(task.goal!.type == "LINE")
        }
    }

    @Suite("parseXCTask v2 format (QR code)")
    struct V2Format {

        @Test("should remove XCTSK: prefix")
        func removePrefix() throws {
            let taskStr = """
            XCTSK:{"taskType":"CLASSIC","version":2,"t":[{"n":"TP1","lat":47.0,"lon":11.0,"r":400}]}
            """

            let task = try XCTaskParser.parseXCTask(taskStr)

            #expect(task.taskType == "CLASSIC")
            #expect(task.version == 2)
        }

        @Test("should parse compact turnpoint format")
        func compactTurnpoints() throws {
            let taskJson = """
            {
                "taskType": "CLASSIC",
                "version": 2,
                "t": [
                    { "n": "Start", "lat": 47.0, "lon": 11.0, "r": 400, "y": "S" },
                    { "n": "TP1", "lat": 47.5, "lon": 11.5, "r": 1000 },
                    { "n": "Goal", "lat": 48.0, "lon": 12.0, "r": 400, "y": "E" }
                ],
                "s": { "t": 1, "d": 1 },
                "g": { "t": 1 }
            }
            """

            let task = try XCTaskParser.parseXCTask(taskJson)

            #expect(task.turnpoints.count == 3)
            #expect(task.turnpoints[0].type == "SSS")
            #expect(task.turnpoints[0].waypoint.name == "Start")
            #expect(task.turnpoints[2].type == "ESS")
            #expect(task.sss?.type == "RACE")
            #expect(task.goal?.type == "LINE")
        }

        @Test("should handle FAI sphere earth model")
        func faiSphere() throws {
            let taskJson = """
            {
                "taskType": "CLASSIC",
                "version": 2,
                "t": [{ "n": "TP", "lat": 47.0, "lon": 11.0, "r": 400 }],
                "e": 1
            }
            """

            let task = try XCTaskParser.parseXCTask(taskJson)
            #expect(task.earthModel == "FAI_SPHERE")
        }
    }

    @Suite("Real-world tasks")
    struct RealWorldTasks {

        @Test("should parse the XContest 'face' task correctly")
        func faceTask() throws {
            let taskJson = """
            {"earthModel":"WGS84","goal":{"deadline":"08:00:00Z","type":"CYLINDER"},"sss":{"direction":"EXIT","timeGates":["03:00:00Z","03:15:00Z","03:30:00Z","03:45:00Z","04:00:00Z","04:15:00Z","04:30:00Z","04:45:00Z","05:00:00Z","05:15:00Z"],"type":"RACE"},"taskType":"CLASSIC","turnpoints":[{"radius":3000,"type":"SSS","waypoint":{"altSmoothed":932,"description":"ELLIOT","lat":-36.18583297729492,"lon":147.97666931152344,"name":"ELLIOT"}},{"radius":1500,"waypoint":{"altSmoothed":375,"description":"KANGCK","lat":-36.26409912109375,"lon":147.93846130371094,"name":"KANGCK"}},{"radius":5000,"waypoint":{"altSmoothed":309,"description":"BIGARA","lat":-36.26362609863281,"lon":148.0209503173828,"name":"BIGARA"}},{"radius":2000,"waypoint":{"altSmoothed":275,"description":"TOOMA","lat":-35.96784973144531,"lon":148.05804443359375,"name":"TOOMA"}},{"radius":400,"waypoint":{"altSmoothed":676,"description":"LIGHTH","lat":-36.086533,"lon":148.045583,"name":"LIGHTH"}},{"radius":7000,"waypoint":{"altSmoothed":407,"description":"DWYERS","lat":-36.242792,"lon":147.883678,"name":"DWYERS"}},{"radius":1000,"type":"ESS","waypoint":{"altSmoothed":289,"description":"KHANCO","lat":-36.216217041015625,"lon":148.1097869873047,"name":"KHANCO"}}],"version":1}
            """

            let task = try XCTaskParser.parseXCTask(taskJson)

            #expect(task.taskType == "CLASSIC")
            #expect(task.version == 1)
            #expect(task.earthModel == "WGS84")
            #expect(task.turnpoints.count == 7)

            // Check first turnpoint (SSS)
            #expect(task.turnpoints[0].type == "SSS")
            #expect(task.turnpoints[0].radius == 3000)
            #expect(task.turnpoints[0].waypoint.name == "ELLIOT")
            #expect(isClose(task.turnpoints[0].waypoint.lat, -36.186, tolerance: 0.01))
            #expect(isClose(task.turnpoints[0].waypoint.lon, 147.977, tolerance: 0.01))

            // Check last turnpoint (ESS)
            #expect(task.turnpoints[6].type == "ESS")
            #expect(task.turnpoints[6].waypoint.name == "KHANCO")

            // Check SSS config
            #expect(task.sss?.type == "RACE")
            #expect(task.sss?.direction == "EXIT")
            #expect(task.sss?.timeGates?.count == 10)

            // Check goal config
            #expect(task.goal?.type == "CYLINDER")
            #expect(task.goal?.deadline == "08:00:00Z")
        }

        @Test("should handle negative latitudes (southern hemisphere)")
        func negativeLatitudes() throws {
            let taskJson = """
            {
                "taskType": "CLASSIC",
                "version": 1,
                "turnpoints": [
                    { "radius": 400, "waypoint": { "name": "TP1", "lat": -36.5, "lon": 148.0 } },
                    { "radius": 400, "waypoint": { "name": "TP2", "lat": -35.5, "lon": 149.0 } }
                ]
            }
            """

            let task = try XCTaskParser.parseXCTask(taskJson)

            #expect(task.turnpoints[0].waypoint.lat == -36.5)
            #expect(task.turnpoints[0].waypoint.lon == 148.0)
        }
    }

    @Suite("igcTaskToXCTask")
    struct IGCConversion {

        @Test("should convert a basic IGC task to XCTask")
        func basicConversion() {
            let igcTask = IGCTask(
                numTurnpoints: 2,
                takeoff: IGCTaskPoint(latitude: -36.186, longitude: 147.976, name: "TAKEOFF"),
                start: IGCTaskPoint(latitude: -36.186, longitude: 147.977, name: "START ELLIOT"),
                turnpoints: [
                    IGCTaskPoint(latitude: -36.266, longitude: 147.873, name: "TURN HALFWY"),
                    IGCTaskPoint(latitude: -36.223, longitude: 147.729, name: "TURN CUDGWE"),
                ],
                finish: IGCTaskPoint(latitude: -36.177, longitude: 147.924, name: "FINISH NCORGL")
            )

            let xcTask = XCTaskParser.igcTaskToXCTask(igcTask)

            #expect(xcTask.taskType == "CLASSIC")
            #expect(xcTask.version == 1)
            #expect(xcTask.earthModel == "WGS84")
            #expect(xcTask.turnpoints.count == 4) // start + 2 turnpoints + finish

            // Check start is SSS
            #expect(xcTask.turnpoints[0].type == "SSS")
            #expect(xcTask.turnpoints[0].waypoint.name == "START ELLIOT")
            #expect(isClose(xcTask.turnpoints[0].waypoint.lat, -36.186, tolerance: 0.001))
            #expect(xcTask.turnpoints[0].radius == 400)

            // Check intermediate turnpoints have no type
            #expect(xcTask.turnpoints[1].type == nil)
            #expect(xcTask.turnpoints[1].waypoint.name == "TURN HALFWY")
            #expect(xcTask.turnpoints[2].type == nil)
            #expect(xcTask.turnpoints[2].waypoint.name == "TURN CUDGWE")

            // Check finish is ESS
            #expect(xcTask.turnpoints[3].type == "ESS")
            #expect(xcTask.turnpoints[3].waypoint.name == "FINISH NCORGL")
        }

        @Test("should use custom radius when provided")
        func customRadius() {
            let igcTask = IGCTask(
                numTurnpoints: 0,
                start: IGCTaskPoint(latitude: -36.186, longitude: 147.977, name: "Start"),
                turnpoints: [],
                finish: IGCTaskPoint(latitude: -36.177, longitude: 147.924, name: "Finish")
            )

            let xcTask = XCTaskParser.igcTaskToXCTask(igcTask, defaultRadius: 1000)

            #expect(xcTask.turnpoints[0].radius == 1000)
            #expect(xcTask.turnpoints[1].radius == 1000)
        }

        @Test("should handle minimal task with only start and finish")
        func minimalTask() {
            let igcTask = IGCTask(
                numTurnpoints: 0,
                start: IGCTaskPoint(latitude: 47.0, longitude: 11.0, name: "Start"),
                turnpoints: [],
                finish: IGCTaskPoint(latitude: 48.0, longitude: 12.0, name: "Goal")
            )

            let xcTask = XCTaskParser.igcTaskToXCTask(igcTask)

            #expect(xcTask.turnpoints.count == 2)
            #expect(xcTask.turnpoints[0].type == "SSS")
            #expect(xcTask.turnpoints[1].type == "ESS")
        }

        @Test("should handle task with empty names")
        func emptyNames() {
            let igcTask = IGCTask(
                numTurnpoints: 1,
                start: IGCTaskPoint(latitude: 47.0, longitude: 11.0, name: ""),
                turnpoints: [
                    IGCTaskPoint(latitude: 47.5, longitude: 11.5, name: ""),
                ],
                finish: IGCTaskPoint(latitude: 48.0, longitude: 12.0, name: "")
            )

            let xcTask = XCTaskParser.igcTaskToXCTask(igcTask)

            #expect(xcTask.turnpoints[0].waypoint.name == "Start")
            #expect(xcTask.turnpoints[1].waypoint.name == "Turnpoint")
            #expect(xcTask.turnpoints[2].waypoint.name == "Finish")
        }
    }

    @Suite("Helper functions")
    struct HelperFunctions {

        let task: XCTask = {
            try! XCTaskParser.parseXCTask("""
            {
                "taskType": "CLASSIC",
                "version": 1,
                "turnpoints": [
                    { "type": "TAKEOFF", "radius": 0, "waypoint": { "name": "Takeoff", "lat": 47.0, "lon": 11.0 } },
                    { "type": "SSS", "radius": 400, "waypoint": { "name": "Start", "lat": 47.1, "lon": 11.1 } },
                    { "radius": 1000, "waypoint": { "name": "TP1", "lat": 47.5, "lon": 11.5 } },
                    { "radius": 1000, "waypoint": { "name": "TP2", "lat": 47.7, "lon": 11.7 } },
                    { "type": "ESS", "radius": 400, "waypoint": { "name": "Goal", "lat": 48.0, "lon": 12.0 } }
                ]
            }
            """)
        }()

        @Test("should find SSS index")
        func sssIndex() {
            #expect(XCTaskParser.getSSSIndex(task) == 1)
        }

        @Test("should find ESS index")
        func essIndex() {
            #expect(XCTaskParser.getESSIndex(task) == 4)
        }

        @Test("should calculate task distance")
        func taskDistance() {
            let distance = XCTaskParser.calculateTaskDistance(task)
            #expect(distance > 50000)
            #expect(distance < 200000)
        }

        @Test("should get intermediate turnpoints")
        func intermediateTurnpoints() {
            let intermediate = XCTaskParser.getIntermediateTurnpoints(task)
            #expect(intermediate.count == 2)
            #expect(intermediate[0].waypoint.name == "TP1")
            #expect(intermediate[1].waypoint.name == "TP2")
        }
    }

    @Suite("isValidTask")
    struct Validation {

        @Test("should reject empty turnpoints")
        func emptyTurnpoints() {
            let task = XCTask(taskType: "CLASSIC", version: 1, turnpoints: [])
            #expect(!XCTaskParser.isValidTask(task))
        }

        @Test("should accept valid coordinates")
        func validCoordinates() {
            let task = XCTask(taskType: "CLASSIC", version: 1, turnpoints: [
                XCTaskTurnpoint(radius: 400, waypoint: XCTaskWaypoint(name: "TP", lat: 47.0, lon: 11.0)),
            ])
            #expect(XCTaskParser.isValidTask(task))
        }

        @Test("should reject out-of-range latitude")
        func invalidLatitude() {
            let task = XCTask(taskType: "CLASSIC", version: 1, turnpoints: [
                XCTaskTurnpoint(radius: 400, waypoint: XCTaskWaypoint(name: "TP", lat: 91.0, lon: 11.0)),
            ])
            #expect(!XCTaskParser.isValidTask(task))
        }

        @Test("should reject out-of-range longitude")
        func invalidLongitude() {
            let task = XCTask(taskType: "CLASSIC", version: 1, turnpoints: [
                XCTaskTurnpoint(radius: 400, waypoint: XCTaskWaypoint(name: "TP", lat: 47.0, lon: 181.0)),
            ])
            #expect(!XCTaskParser.isValidTask(task))
        }
    }

    @Suite("Optimized Task Line")
    struct OptimizedTaskLine {

        @Test("should return empty for no turnpoints")
        func emptyTask() {
            let task = XCTask(taskType: "CLASSIC", version: 1, turnpoints: [])
            let path = XCTaskParser.calculateOptimizedTaskLine(task)
            #expect(path.isEmpty)
        }

        @Test("should return single point for one turnpoint")
        func singleTurnpoint() {
            let task = XCTask(taskType: "CLASSIC", version: 1, turnpoints: [
                XCTaskTurnpoint(radius: 400, waypoint: XCTaskWaypoint(name: "TP", lat: 47.0, lon: 11.0)),
            ])
            let path = XCTaskParser.calculateOptimizedTaskLine(task)
            #expect(path.count == 1)
            #expect(path[0].lat == 47.0)
            #expect(path[0].lon == 11.0)
        }

        @Test("should handle two turnpoints")
        func twoTurnpoints() {
            let task = XCTask(taskType: "CLASSIC", version: 1, turnpoints: [
                XCTaskTurnpoint(radius: 400, waypoint: XCTaskWaypoint(name: "Start", lat: 47.0, lon: 11.0)),
                XCTaskTurnpoint(radius: 400, waypoint: XCTaskWaypoint(name: "Goal", lat: 48.0, lon: 12.0)),
            ])

            let path = XCTaskParser.calculateOptimizedTaskLine(task)
            #expect(path.count == 2)

            // Points should be on the cylinder edges, not at centers
            let distStart = Geo.haversineDistance(
                lat1: path[0].lat, lon1: path[0].lon,
                lat2: 47.0, lon2: 11.0
            )
            #expect(isClose(distStart, 400, tolerance: 10))

            let distGoal = Geo.haversineDistance(
                lat1: path[1].lat, lon1: path[1].lon,
                lat2: 48.0, lon2: 12.0
            )
            #expect(isClose(distGoal, 400, tolerance: 10))
        }

        @Test("should calculate optimized distance shorter than center-to-center")
        func optimizedShorter() throws {
            let taskJson = """
            {
                "taskType": "CLASSIC",
                "version": 1,
                "turnpoints": [
                    { "type": "SSS", "radius": 3000, "waypoint": { "name": "Start", "lat": 47.0, "lon": 11.0 } },
                    { "radius": 1000, "waypoint": { "name": "TP1", "lat": 47.3, "lon": 11.3 } },
                    { "type": "ESS", "radius": 2000, "waypoint": { "name": "Goal", "lat": 47.6, "lon": 11.6 } }
                ]
            }
            """

            let task = try XCTaskParser.parseXCTask(taskJson)
            let centerDist = XCTaskParser.calculateTaskDistance(task)
            let optimizedDist = XCTaskParser.calculateOptimizedTaskDistance(task)

            #expect(optimizedDist < centerDist)
            #expect(optimizedDist > 0)
        }

        @Test("should return segment distances matching total")
        func segmentDistancesMatchTotal() throws {
            let taskJson = """
            {
                "taskType": "CLASSIC",
                "version": 1,
                "turnpoints": [
                    { "type": "SSS", "radius": 1000, "waypoint": { "name": "Start", "lat": 47.0, "lon": 11.0 } },
                    { "radius": 500, "waypoint": { "name": "TP1", "lat": 47.3, "lon": 11.3 } },
                    { "radius": 500, "waypoint": { "name": "TP2", "lat": 47.5, "lon": 11.1 } },
                    { "type": "ESS", "radius": 1000, "waypoint": { "name": "Goal", "lat": 47.8, "lon": 11.4 } }
                ]
            }
            """

            let task = try XCTaskParser.parseXCTask(taskJson)
            let segments = XCTaskParser.getOptimizedSegmentDistances(task)
            let totalDist = XCTaskParser.calculateOptimizedTaskDistance(task)

            #expect(segments.count == 3)
            let segmentSum = segments.reduce(0, +)
            #expect(isClose(segmentSum, totalDist, tolerance: 1))
        }
    }

    @Suite("Codable XCTask")
    struct CodableTests {

        @Test("should encode and decode XCTask via JSON")
        func roundTrip() throws {
            let original = XCTask(
                taskType: "CLASSIC",
                version: 1,
                earthModel: "WGS84",
                turnpoints: [
                    XCTaskTurnpoint(type: "SSS", radius: 3000, waypoint: XCTaskWaypoint(name: "Start", lat: 47.0, lon: 11.0)),
                    XCTaskTurnpoint(radius: 1000, waypoint: XCTaskWaypoint(name: "TP1", lat: 47.5, lon: 11.5)),
                    XCTaskTurnpoint(type: "ESS", radius: 400, waypoint: XCTaskWaypoint(name: "Goal", lat: 48.0, lon: 12.0)),
                ],
                sss: SSSConfig(type: "RACE", direction: "EXIT", timeGates: ["12:00:00Z"]),
                goal: GoalConfig(type: "CYLINDER", deadline: "18:00:00Z")
            )

            let data = try JSONEncoder().encode(original)
            let decoded = try JSONDecoder().decode(XCTask.self, from: data)

            #expect(decoded.taskType == original.taskType)
            #expect(decoded.version == original.version)
            #expect(decoded.turnpoints.count == 3)
            #expect(decoded.sss?.type == "RACE")
            #expect(decoded.goal?.type == "CYLINDER")
            #expect(decoded.turnpoints[0].type == "SSS")
            #expect(decoded.turnpoints[0].waypoint.name == "Start")
        }
    }
}

@Suite("AirScore URL Parsing")
struct AirScoreURLParsingTests {

    @Test("should parse standard AirScore tracklog URL")
    func standardURL() {
        let url = "https://xc.highcloud.net/tracklog_map.html?trackid=43826&comPk=466&tasPk=2030"
        let parsed = AirScoreClient.parseAirScoreURL(url)

        #expect(parsed != nil)
        #expect(parsed!.comPk == 466)
        #expect(parsed!.tasPk == 2030)
        #expect(parsed!.trackId == 43826)
    }

    @Test("should handle URL without trackId")
    func noTrackId() {
        let url = "https://xc.highcloud.net/task_result.html?comPk=466&tasPk=2030"
        let parsed = AirScoreClient.parseAirScoreURL(url)

        #expect(parsed != nil)
        #expect(parsed!.comPk == 466)
        #expect(parsed!.tasPk == 2030)
        #expect(parsed!.trackId == nil)
    }

    @Test("should return nil for invalid URL")
    func invalidURL() {
        let parsed = AirScoreClient.parseAirScoreURL("not a url")
        #expect(parsed == nil)
    }

    @Test("should return nil for URL missing comPk")
    func missingComPk() {
        let url = "https://xc.highcloud.net/tracklog_map.html?tasPk=2030"
        let parsed = AirScoreClient.parseAirScoreURL(url)
        #expect(parsed == nil)
    }
}
