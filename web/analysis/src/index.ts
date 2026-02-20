// Public API
export { parseIGC, type IGCFile, type IGCFix, type IGCHeader, type IGCEvent, type IGCTask, type IGCTaskPoint } from './igc-parser';
export { detectFlightEvents, filterEventsByBounds, getEventStyle, type FlightEvent, type FlightEventType, type ThermalSegment, type GlideSegment, type TrackSegment } from './event-detector';
export { parseXCTask, igcTaskToXCTask, calculateTaskDistance, getSSSIndex, getESSIndex, getIntermediateTurnpoints, isValidTask, type XCTask, type Turnpoint, type Waypoint, type SSSConfig, type GoalConfig, type IGCTaskConversionOptions } from './xctsk-parser';
export { calculateOptimizedTaskLine, calculateOptimizedTaskDistance, getOptimizedSegmentDistances } from './task-optimizer';
export { parseWaypointsCSV, findWaypoint, findWaypointByName, findWaypointByCoordinates, type WaypointRecord } from './waypoints';
export { haversineDistance, calculateBearing, calculateBearingRadians, destinationPoint, getBoundingBox, isInsideCylinder, getCirclePoints } from './geo';
export { formatUnit, formatSpeed, formatAltitude, formatAltitudeChange, formatDistance, formatClimbRate, formatRadius, getUnitLabel, getCurrentUnit, type FormattedValue, type UnitPreferences, type SpeedUnit, type AltitudeUnit, type DistanceUnit, type ClimbRateUnit } from './units';
export { calculateGlidePositions, calculateGlideMarkers, calculateTotalGlideDistance, type ChevronPosition, type GlideMarker } from './glide-speed';
export { resolveTurnpointSequence, detectCylinderCrossings, type TurnpointSequenceResult, type CylinderCrossing, type TurnpointReaching, type BestProgress, type LegDistance } from './turnpoint-sequence';
