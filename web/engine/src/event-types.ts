/**
 * Flight-event type vocabulary.
 *
 * The event/segment types shared across the flight-event detectors
 * (thermals, glides, takeoff/landing, extremes, turnpoints) and their
 * consumers. Kept dependency-free so any module — including circle-detector,
 * which needs {@link TrackSegment} — can import the vocabulary without pulling
 * in the detector implementations (avoids an import cycle).
 */

export type FlightEventType =
  | 'takeoff'
  | 'landing'
  | 'thermal_entry'
  | 'thermal_exit'
  | 'glide_start'
  | 'glide_end'
  | 'turnpoint_entry'
  | 'turnpoint_exit'
  | 'start_crossing'
  | 'goal_crossing'
  | 'start_reaching'
  | 'turnpoint_reaching'
  | 'ess_reaching'
  | 'goal_reaching'
  | 'max_altitude'
  | 'min_altitude'
  | 'max_climb'
  | 'max_sink'
  | 'circle_complete';

/**
 * Base interface for track segments (thermals, glides, etc.)
 * Contains the fix array indices that define the segment bounds
 */
export interface TrackSegment {
  startIndex: number;
  endIndex: number;
}

// --- Event detail types ---

export interface ThermalEventDetails {
  avgClimbRate: number;
  duration: number;
  altitudeGain: number;
}

export interface GlideEventDetails {
  distance: number;
  /** L/D ratio; undefined when the pilot gained altitude over the glide (no meaningful ratio) */
  glideRatio?: number;
  duration?: number;
  averageSpeed: number;
  altitudeLost?: number;
}

export interface FixIndexDetails {
  fixIndex: number;
  climbRate?: number;
  sinkRate?: number;
  startAltitude?: number;
  altitudeGain?: number;
}

export interface TurnpointCrossingDetails {
  fixIndex: number;
  turnpointIndex: number;
  turnpointName: string;
  radius: number;
  direction: string;
  distanceToCenter: number;
}

export interface TurnpointReachingDetails {
  fixIndex: number;
  turnpointIndex: number;
  turnpointName: string;
  selectionReason: string;
  candidateCount: number;
  madeGoal: boolean;
  flownDistance: number;
  taskDistance: number;
  speedSectionTime?: number | null;
}

export interface CircleEventDetails {
  turnDirection: string;
  duration: number;
  climbRate: number;
  radius: number;
  centerLat: number;
  centerLon: number;
  fitError: number;
  quality: number;
  strongestLiftBearing: number;
  circleNumber: number;
  windSpeed?: number;
  windDirection?: number;
  driftWindSpeed?: number;
  driftWindDirection?: number;
}

export type EventDetails =
  | ThermalEventDetails
  | GlideEventDetails
  | FixIndexDetails
  | TurnpointCrossingDetails
  | TurnpointReachingDetails
  | CircleEventDetails;

export interface FlightEvent {
  id: string;
  type: FlightEventType;
  time: Date;
  latitude: number;
  longitude: number;
  altitude: number;
  description: string;
  details?: EventDetails;
  /** For segment events (thermals, glides), contains the track indices */
  segment?: TrackSegment;
}

export interface ThermalSegment extends TrackSegment {
  startAltitude: number;
  endAltitude: number;
  avgClimbRate: number;
  duration: number;
  location: { lat: number; lon: number };
}

export interface GlideSegment extends TrackSegment {
  startAltitude: number;
  endAltitude: number;
  distance: number;
  /** L/D ratio; undefined when the pilot gained altitude over the glide (no meaningful ratio) */
  glideRatio?: number;
  duration: number;
}
