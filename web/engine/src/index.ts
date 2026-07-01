// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

// Public API
export { sanitizeText } from './sanitize';
export { parseIGC, type IGCFile, type IGCFix, type IGCHeader, type IGCEvent, type IGCTask, type IGCTaskPoint } from './igc-parser';
export { detectFlightEvents, filterEventsByBounds, getEventStyle, type FlightEvent, type FlightEventType, type ThermalSegment, type GlideSegment, type TrackSegment, type EventDetails, type ThermalEventDetails, type GlideEventDetails, type FixIndexDetails, type TurnpointCrossingDetails, type TurnpointReachingDetails, type CircleEventDetails } from './event-detector';
export { parseXCTask, parseXCTaskAsync, toXctskJSON, igcTaskToXCTask, calculateNominalTaskDistance, getSSSIndex, getESSIndex, getGoalIndex, getIntermediateTurnpoints, isValidTask, type XCTask, type Turnpoint, type TurnpointType, type Waypoint, type SSSConfig, type GoalConfig, type IGCTaskConversionOptions } from './xctsk-parser';
export { calculateOptimizedTaskLine, calculateOptimizedTaskDistance, getOptimizedSegmentDistances } from './task-optimizer';
export { parseWaypointsCSV, findWaypoint, findWaypointByName, findWaypointByCoordinates, type WaypointRecord } from './waypoints';
export { andoyerDistance, calculateBearing, calculateBearingRadians, destinationPoint, getBoundingBox, isInsideCylinder, getCirclePoints } from './geo';
export { formatUnit, formatSpeed, formatAltitude, formatAltitudeChange, formatDistance, formatClimbRate, formatRadius, getUnitLabel, getCurrentUnit, getSegmentLengthMeters, type FormattedValue, type UnitPreferences, type SpeedUnit, type AltitudeUnit, type DistanceUnit, type ClimbRateUnit } from './units';
export { calculateGlidePositions, calculateGlideMarkers, calculateTotalGlideDistance, calculatePointMetrics, type ChevronPosition, type GlideMarker, type GlideContext, type GlideContextResolver, type PointMetrics } from './glide-speed';
export { resolveTurnpointSequence, detectCylinderCrossings, type TurnpointSequenceResult, type CylinderCrossing, type TurnpointReaching, type BestProgress, type LegDistance } from './turnpoint-sequence';
export { detectCircles, computeBearingRates, fitCircleLeastSquares, normalizeBearingDelta, type CircleSegment, type CirclingSegment, type FittedCircle, type WindEstimate, type CircleDetectionResult, type TurnDirection } from './circle-detector';
export { extractGlides, extractClimbs, extractSinks, type GlideData, type ClimbData, type SinkData, type ClimbEventDetails } from './segment-extractors';
export { maxBy, minBy } from './array-utils';
export { packTracks, buildPalette, colorForName, metresPerDegree, FLOATS_PER_VERTEX, type PackInput, type PackedTracks, type PilotTrackInput, type TrackFix, type TrackManifest, type TrackPilotMeta, type TrackTaskPoint } from './track-packer';
export { clusterFrame, detectGaggles, gagglesAt, DEFAULT_GAGGLE_PARAMS, type GaggleParams, type PilotState, type Frame, type StartCylinder, type TurnpointXZ, type DetectOptions, type GaggleEpisode, type GaggleResult, type ActiveGaggle } from './cluster-detector';
export { packTracksFromIgc, type PilotIgc, type PackFromIgcInput } from './track-pack-pipeline';
export { DEFAULT_THRESHOLDS, resolveThresholds, type DetectionThresholds, type PartialThresholds, type ThermalThresholds, type GlideThresholds, type VarioThresholds, type TakeoffLandingThresholds, type CircleThresholds } from './thresholds';
export { parseThresholdInput, formatThresholdForDisplay, type ThresholdDimension, type ParsedThresholdInput } from './threshold-parser';
export { scoreTask, scoreFlights, toFlightScoringData, taskForDistanceOrigin, calculateTaskValidity, calculateWeights, calculateDistancePoints, calculateTimePoints, calculateSpeedFraction, calculateLeadingCoefficient, calculateLeadingPoints, calculateArrivalPoints, calculateLaunchValidity, calculateDistanceValidity, calculateTimeValidity, applyMinimumDistance, DEFAULT_GAP_PARAMETERS, type GAPParameters, type TaskScoreResult, type TaskScoreCore, type TaskValidity, type AvailablePoints, type WeightFractions, type PilotScore, type PilotScoreCore, type FlightScoringData, type PilotFlight, type TaskStats } from './gap-scoring';
export { scoreOpenDistance } from './open-distance-scoring';
