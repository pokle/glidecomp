/**
 * Detection threshold types and defaults.
 *
 * All values are in SI units (m, m/s, seconds, degrees/s).
 * The frontend converts to/from display units when showing these to users.
 */

export interface ThermalThresholds {
  /** Minimum average climb rate (m/s) to enter/stay in a thermal */
  minClimbRate: number;
  /** Minimum thermal duration (seconds) to emit a thermal event */
  minThermalDuration: number;
  /** Minimum time gap (seconds) between consecutive thermals */
  minThermalGap: number;
}

export interface GlideThresholds {
  /** Maximum glide ratio to classify a glide as a "sink" */
  maxGlideRatioForSink: number;
  /** Minimum glide duration (seconds) to emit a glide event */
  minGlideDuration: number;
  /** Minimum index gap between thermals to consider a glide between them */
  minGlideGapIndices: number;
}

export interface VarioThresholds {
  /** Minimum climb rate (m/s) for a "significant climb" vario extreme */
  minSignificantClimb: number;
  /** Maximum sink rate (m/s) for a "significant sink" vario extreme */
  minSignificantSink: number;
  /** Window size (fixes) for vario averaging */
  varioWindowSize: number;
  /** Descent rate (m/s) threshold to consider still on approach, not landed */
  landingDescentThreshold: number;
}

export interface TakeoffLandingThresholds {
  /** Minimum ground speed (m/s) to consider in flight */
  minGroundSpeed: number;
  /** Minimum altitude gain (meters) above start altitude */
  minAltitudeGain: number;
  /** Minimum sustained climb rate (m/s) */
  minClimbRate: number;
  /** Time window (seconds) to verify sustained flight after takeoff */
  takeoffTimeWindow: number;
  /** Time window (seconds) to verify no flight activity for landing */
  landingTimeWindow: number;
  /** Landing speed threshold is this factor of takeoff speed threshold */
  landingSpeedFactor: number;
}

export interface CircleThresholds {
  /** Maximum plausible bearing rate (deg/s); anything beyond is a GPS spike */
  maxBearingRate: number;
  /** Maximum reasonable wind speed (m/s) — reject estimates above this */
  maxReasonableWindSpeed: number;
  /** Minimum ground speed variation (m/s) needed for meaningful wind estimate */
  minGroundSpeedVariation: number;
  /** Lookback window (seconds) for bearing rate computation */
  lookbackSeconds: number;
  /** Minimum turn rate (deg/s) to consider circling */
  minTurnRate: number;
  /** Transition delay (seconds) from CRUISE to CLIMB */
  t1Seconds: number;
  /** Transition delay (seconds) from CLIMB to CRUISE */
  t2Seconds: number;
  /** Minimum fixes per circle */
  minFixesPerCircle: number;
}

export interface DetectionThresholds {
  thermal: ThermalThresholds;
  glide: GlideThresholds;
  vario: VarioThresholds;
  takeoffLanding: TakeoffLandingThresholds;
  circle: CircleThresholds;
}

export const DEFAULT_THRESHOLDS: DetectionThresholds = {
  thermal: {
    minClimbRate: 0.5,
    minThermalDuration: 20,
    minThermalGap: 20,
  },
  glide: {
    maxGlideRatioForSink: 5,
    minGlideDuration: 30,
    minGlideGapIndices: 10,
  },
  vario: {
    minSignificantClimb: 0.5,
    minSignificantSink: -1,
    varioWindowSize: 10,
    landingDescentThreshold: -0.5,
  },
  takeoffLanding: {
    minGroundSpeed: 5,
    minAltitudeGain: 50,
    minClimbRate: 1.0,
    takeoffTimeWindow: 10,
    landingTimeWindow: 30,
    landingSpeedFactor: 0.5,
  },
  circle: {
    maxBearingRate: 50,
    maxReasonableWindSpeed: 30,
    minGroundSpeedVariation: 1,
    lookbackSeconds: 5,
    minTurnRate: 4.0,
    t1Seconds: 8,
    t2Seconds: 15,
    minFixesPerCircle: 8,
  },
};

/** Deep-merge partial thresholds over defaults */
export function resolveThresholds(
  partial?: PartialThresholds
): DetectionThresholds {
  if (!partial) return DEFAULT_THRESHOLDS;

  return {
    thermal: { ...DEFAULT_THRESHOLDS.thermal, ...partial.thermal },
    glide: { ...DEFAULT_THRESHOLDS.glide, ...partial.glide },
    vario: { ...DEFAULT_THRESHOLDS.vario, ...partial.vario },
    takeoffLanding: { ...DEFAULT_THRESHOLDS.takeoffLanding, ...partial.takeoffLanding },
    circle: { ...DEFAULT_THRESHOLDS.circle, ...partial.circle },
  };
}

/** Partial version of DetectionThresholds for user overrides */
export type PartialThresholds = {
  [K in keyof DetectionThresholds]?: Partial<DetectionThresholds[K]>;
};
