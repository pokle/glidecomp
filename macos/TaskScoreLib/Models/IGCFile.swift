import Foundation

/// A single GPS fix from an IGC file B record
public struct IGCFix: Equatable, Sendable {
    public let time: Date
    public let latitude: Double
    public let longitude: Double
    public let pressureAltitude: Int
    public let gnssAltitude: Int
    public let valid: Bool

    public init(time: Date, latitude: Double, longitude: Double,
                pressureAltitude: Int, gnssAltitude: Int, valid: Bool) {
        self.time = time
        self.latitude = latitude
        self.longitude = longitude
        self.pressureAltitude = pressureAltitude
        self.gnssAltitude = gnssAltitude
        self.valid = valid
    }
}

/// Header information from an IGC file
public struct IGCHeader: Equatable, Sendable {
    public var date: Date?
    public var pilot: String?
    public var gliderType: String?
    public var gliderId: String?
    public var competitionId: String?
    public var competitionClass: String?

    public init(date: Date? = nil, pilot: String? = nil, gliderType: String? = nil,
                gliderId: String? = nil, competitionId: String? = nil,
                competitionClass: String? = nil) {
        self.date = date
        self.pilot = pilot
        self.gliderType = gliderType
        self.gliderId = gliderId
        self.competitionId = competitionId
        self.competitionClass = competitionClass
    }
}

/// An event from an IGC file E record
public struct IGCEvent: Equatable, Sendable {
    public let time: Date
    public let code: String
    public let description: String
}

/// A task point from an IGC file C record
public struct IGCTaskPoint: Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let name: String
}

/// A declared task from IGC file C records
public struct IGCTask: Equatable, Sendable {
    public var declarationTime: Date?
    public var flightDate: Date?
    public var taskId: String?
    public var numTurnpoints: Int
    public var description: String?
    public var takeoff: IGCTaskPoint?
    public var start: IGCTaskPoint?
    public var turnpoints: [IGCTaskPoint]
    public var finish: IGCTaskPoint?
    public var landing: IGCTaskPoint?
}

/// A complete parsed IGC file
public struct IGCFileData: Equatable, Sendable {
    public let header: IGCHeader
    public let fixes: [IGCFix]
    public let events: [IGCEvent]
    public let task: IGCTask?
}
