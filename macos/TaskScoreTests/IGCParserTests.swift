import Testing
import Foundation
@testable import TaskScoreLib

@Suite("IGC Parser")
struct IGCParserTests {

    @Suite("parseIGC")
    struct ParseIGC {

        @Test("should parse a minimal IGC file")
        func parseMinimalIGC() {
            let igcContent = """
            AXXX001 FLIGHT RECORDER SERIAL NUMBER
            HFDTE150124
            HFPLTPILOTINCHARGE:John Doe
            HFGTYGLIDERTYPE:Advance Omega X-Alps 3
            B1234564728234N01152432EA0123401567
            B1234574728300N01152500EA0125001600
            """

            let result = IGCParser.parse(igcContent)

            #expect(result.header.date != nil)

            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "UTC")!
            let components = calendar.dateComponents([.year, .month, .day], from: result.header.date!)

            #expect(components.day == 15)
            #expect(components.month == 1) // January
            #expect(components.year == 2024)
            #expect(result.header.pilot == "John Doe")
            #expect(result.header.gliderType == "Advance Omega X-Alps 3")
            #expect(result.fixes.count == 2)
        }

        @Test("should parse B records correctly")
        func parseBRecords() {
            let igcContent = """
            HFDTE010125
            B1230004728234N01152432EA0123401567
            """

            let result = IGCParser.parse(igcContent)
            let fix = result.fixes[0]

            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "UTC")!
            let components = calendar.dateComponents([.hour, .minute, .second], from: fix.time)

            #expect(components.hour == 12)
            #expect(components.minute == 30)
            #expect(components.second == 0)

            // Latitude: 47 degrees, 28.234 minutes = 47 + 28.234/60 = 47.47056...
            #expect(isClose(fix.latitude, 47.4706, tolerance: 0.001))

            // Longitude: 011 degrees, 52.432 minutes = 11 + 52.432/60 = 11.8739...
            #expect(isClose(fix.longitude, 11.8739, tolerance: 0.001))

            #expect(fix.valid == true)
            #expect(fix.pressureAltitude == 1234)
            #expect(fix.gnssAltitude == 1567)
        }

        @Test("should parse Southern and Western coordinates")
        func parseSouthWest() {
            let igcContent = """
            HFDTE010125
            B1230004728234S01152432WA0123401567
            """

            let result = IGCParser.parse(igcContent)
            let fix = result.fixes[0]

            #expect(fix.latitude < 0)
            #expect(fix.longitude < 0)
            #expect(isClose(fix.latitude, -47.4706, tolerance: 0.001))
            #expect(isClose(fix.longitude, -11.8739, tolerance: 0.001))
        }

        @Test("should parse invalid fixes (V flag)")
        func parseInvalidFixes() {
            let igcContent = """
            HFDTE010125
            B1230004728234N01152432EV0123401567
            """

            let result = IGCParser.parse(igcContent)
            #expect(result.fixes[0].valid == false)
        }

        @Test("should handle dates in 1900s and 2000s")
        func parseDateCenturies() {
            let igc2024 = "HFDTE150124"
            let igc1999 = "HFDTE150199"

            let result2024 = IGCParser.parse(igc2024)
            let result1999 = IGCParser.parse(igc1999)

            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "UTC")!

            #expect(calendar.component(.year, from: result2024.header.date!) == 2024)
            #expect(calendar.component(.year, from: result1999.header.date!) == 1999)
        }

        @Test("should parse E records (events)")
        func parseERecords() {
            let igcContent = """
            HFDTE010125
            B1230004728234N01152432EA0123401567
            E123045PEVPilot Event
            """

            let result = IGCParser.parse(igcContent)
            #expect(result.events.count == 1)
            #expect(result.events[0].code == "PEV")
            #expect(result.events[0].description == "Pilot Event")
        }

        @Test("should parse C records (task declaration)")
        func parseCRecords() {
            let igcContent = """
            HFDTE010125
            C4728234N01152432ETakeoff
            C4730000N01155000ESSS Start
            C4735000N01160000ETP1
            C4740000N01165000EESS Goal
            C4745000N01170000ELanding
            """

            let result = IGCParser.parse(igcContent)
            #expect(result.task != nil)
            #expect(result.task!.takeoff != nil)
            #expect(result.task!.takeoff!.name == "Takeoff")
            #expect(result.task!.start != nil)
            #expect(result.task!.start!.name == "SSS Start")
            #expect(result.task!.turnpoints.count == 1)
            #expect(result.task!.finish != nil)
            #expect(result.task!.landing != nil)
        }

        @Test("should handle various H record formats")
        func parseVariousHRecords() {
            let igcContent = """
            HFDTE:150124
            HFPLT:Jane Smith
            HFGTY:Nova Mentor 7
            HFGID:12345
            HFCID:AB
            HFCCL:Sport
            """

            let result = IGCParser.parse(igcContent)
            #expect(result.header.pilot == "Jane Smith")
            #expect(result.header.gliderType == "Nova Mentor 7")
            #expect(result.header.gliderId == "12345")
            #expect(result.header.competitionId == "AB")
            #expect(result.header.competitionClass == "Sport")
        }
    }
}

// Helper for floating point comparisons
func isClose(_ a: Double, _ b: Double, tolerance: Double) -> Bool {
    abs(a - b) < tolerance
}
