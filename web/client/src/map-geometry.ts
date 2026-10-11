/**
 * The task and flight as map geometry — colours, the altitude-coloured track,
 * cylinders, exit arrowheads, leg and turnpoint labels — exactly as
 * docs/mapbox-interactions-spec.md specifies them. Shared by the website's
 * Mapbox provider (`analysis/map-provider-shared.ts` re-exports it) and the
 * app's native map, so the two draw the same map. Pure: no DOM, no renderer.
 */
import {
  calculateBearing,
  calculateOptimizedTaskLine,
  computeGoalLine,
  computeTurnpointDirections,
  destinationPoint,
  formatAltitude,
  formatCylinderRadius,
  formatDistance,
  getCirclePoints,
  getOptimizedSegmentDistances,
  getSSSIndex,
  goalSemicirclePoints,
  type IGCFix,
  type Turnpoint,
  type UnitPreferences,
  type XCTask,
} from "@glidecomp/engine";

/** A GeoJSON polygon, structurally — the client carries no GeoJSON types. */
export interface PolygonGeometry {
  type: "Polygon";
  coordinates: [number, number][][];
}

export interface PolygonFeature {
  type: "Feature";
  properties: { turnpointIndex: number };
  geometry: PolygonGeometry;
}

export interface Feature<G, P> {
  type: "Feature";
  properties: P;
  geometry: G;
}
export interface LineGeometry {
  type: "LineString";
  coordinates: [number, number][];
}
export interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}
export interface FeatureCollection<F> {
  type: "FeatureCollection";
  features: F[];
}

export const TRACK_OUTLINE_COLOR = '#000000';
export const HIGHLIGHT_COLOR = '#00ffff';
export const TASK_COLOR = '#f97316';

export const TURNPOINT_COLORS: Record<string, string> = {
  SSS: '#22c55e',
  ESS: '#eab308',
  TAKEOFF: '#3b82f6',
  DEFAULT: '#a855f7',
};

export const KEY_EVENT_TYPES = new Set([
  'takeoff',
  'landing',
  'start_reaching',
  'turnpoint_reaching',
  'ess_reaching',
  'goal_reaching',
  'max_altitude',
]);

/** Get the display color for a turnpoint type */
export function getTurnpointColor(type: string): string {
  return TURNPOINT_COLORS[type] || TURNPOINT_COLORS.DEFAULT;
}

// ── Altitude range calculation ───────────────────────────────────────────────

export interface AltitudeRange {
  minAlt: number;
  maxAlt: number;
  altRange: number;
}

/**
 * Calculate the min, max, and range of GNSS altitudes across an array of fixes.
 * Returns Infinity/-Infinity for empty arrays (caller should guard).
 */
export function calculateAltitudeRange(fixes: IGCFix[]): AltitudeRange {
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (const fix of fixes) {
    if (fix.gnssAltitude < minAlt) minAlt = fix.gnssAltitude;
    if (fix.gnssAltitude > maxAlt) maxAlt = fix.gnssAltitude;
  }
  return { minAlt, maxAlt, altRange: maxAlt - minAlt };
}

// ── Track segment building ──────────────────────────────────────────────────

export interface TrackSegment {
  /** Indices into the source fixes array: [startIndex, endIndex) — endIndex is exclusive. */
  startIndex: number;
  endIndex: number;
  /** Altitude value normalised to 0..1 based on the mid-point fix of the segment. */
  normalizedAlt: number;
}

/**
 * Divide a fixes array into at most `maxSegments` contiguous segments,
 * each carrying a normalised altitude value derived from the segment's mid-point fix.
 *
 * The caller is responsible for building the map geometry (GeoJSON) from the
 * returned index ranges.
 *
 * @param fixes         Full array of IGC fixes.
 * @param altRange      Pre-computed altitude range (from `calculateAltitudeRange`).
 * @param minAlt        Pre-computed minimum altitude.
 * @param maxSegments   Maximum number of segments to produce (default 500).
 * @param defaultNormalized  Value to use when altRange is 0 (default 0.5).
 */
export function buildTrackSegments(
  fixes: IGCFix[],
  altRange: number,
  minAlt: number,
  maxSegments: number = 500,
  defaultNormalized: number = 0.5,
): TrackSegment[] {
  if (fixes.length < 2) return [];

  const step = Math.max(1, Math.floor(fixes.length / maxSegments));
  const segments: TrackSegment[] = [];

  for (let i = 0; i < fixes.length - 1; i += step) {
    const end = Math.min(i + step + 1, fixes.length);
    const midIdx = Math.floor((i + end - 1) / 2);
    const normalizedAlt = altRange > 0
      ? (fixes[midIdx].gnssAltitude - minAlt) / altRange
      : defaultNormalized;
    segments.push({ startIndex: i, endIndex: end, normalizedAlt });
  }

  return segments;
}

// ── Altitude color functions ────────────────────────────────────────────────

/**
 * Get color based on normalized altitude (0-1 range).
 * Gradient: earthy brown (low) → green → cyan → sky blue (high)
 */
export function getAltitudeColorNormalized(normalizedAlt: number): string {
  const t = Math.max(0, Math.min(1, normalizedAlt));

  const colors = [
    { pos: 0.0, r: 139, g: 90, b: 43 },    // Saturated Brown #8B5A2B
    { pos: 0.25, r: 67, g: 160, b: 71 },   // Saturated Green #43A047
    { pos: 0.5, r: 3, g: 155, b: 229 },     // Saturated Cyan #039BE5
    { pos: 0.75, r: 41, g: 182, b: 246 },   // Bright Sky Blue #29B6F6
    { pos: 1.0, r: 79, g: 195, b: 247 },    // Sky Blue #4FC3F7
  ];

  let lower = colors[0];
  let upper = colors[colors.length - 1];
  for (let i = 0; i < colors.length - 1; i++) {
    if (t >= colors[i].pos && t <= colors[i + 1].pos) {
      lower = colors[i];
      upper = colors[i + 1];
      break;
    }
  }

  const range = upper.pos - lower.pos;
  const localT = range > 0 ? (t - lower.pos) / range : 0;
  const r = Math.round(lower.r + (upper.r - lower.r) * localT);
  const g = Math.round(lower.g + (upper.g - lower.g) * localT);
  const b = Math.round(lower.b + (upper.b - lower.b) * localT);

  return `rgb(${r}, ${g}, ${b})`;
}

/** Create a GeoJSON circle polygon for cylinder rendering */
export function createCirclePolygon(
  centerLon: number,
  centerLat: number,
  radiusMeters: number,
  numPoints = 64
): PolygonGeometry {
  const points = getCirclePoints(centerLat, centerLon, radiusMeters, numPoints);
  const coords: [number, number][] = points.map(p => [p.lon, p.lat]);
  return {
    type: 'Polygon',
    coordinates: [coords],
  };
}

/**
 * Outward-pointing arrowheads on the rings of EXIT turnpoints — the map
 * notation for "this cylinder is crossed flying out of it" (see
 * docs/mapbox-interactions-spec.md §Task visualization).
 *
 * Only inferred exit turnpoints are marked: a declared-EXIT start is the
 * normal case on race tasks and is already described by the start summary
 * text, so decorating it would just add noise. Three arrowheads per ring,
 * one anchored at the optimized route's tag bearing (where the route
 * actually crosses the boundary) and the others at ±120°.
 *
 * @param optimizedLine - Optional precomputed calculateOptimizedTaskLine
 *   result for the same task.
 */
export function exitTurnpointArrowFeatures(
  task: XCTask,
  optimizedLine?: { lat: number; lon: number }[],
): PolygonFeature[] {
  if (task.turnpoints.length < 2) return [];
  const line = optimizedLine ?? calculateOptimizedTaskLine(task);
  const directions = computeTurnpointDirections(task, line);
  const sssIdx = getSSSIndex(task);

  const features: PolygonFeature[] = [];
  for (let i = 0; i < task.turnpoints.length; i++) {
    if (directions[i] !== 'exit' || i === sssIdx) continue;
    const tp = task.turnpoints[i];
    const { lat, lon } = tp.waypoint;
    const r = tp.radius;
    // Arrow size scales with the ring but stays visible on small ones and
    // restrained on huge ones.
    const len = Math.min(Math.max(r * 0.12, 80), 600);
    const halfWidthRad = (len * 0.6) / r; // base half-width as an angle at the centre
    const tag = line[i];
    const anchorBearing = tag ? calculateBearing(lat, lon, tag.lat, tag.lon) : 0;

    for (const offset of [0, 120, 240]) {
      const bearingRad = ((anchorBearing + offset) * Math.PI) / 180;
      const apex = destinationPoint(lat, lon, r + len, bearingRad);
      const base1 = destinationPoint(lat, lon, r, bearingRad + halfWidthRad);
      const base2 = destinationPoint(lat, lon, r, bearingRad - halfWidthRad);
      features.push({
        type: 'Feature',
        properties: { turnpointIndex: i },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [apex.lon, apex.lat],
            [base1.lon, base1.lat],
            [base2.lon, base2.lat],
            [apex.lon, apex.lat],
          ]],
        },
      });
    }
  }
  return features;
}

// ── Labels ──────────────────────────────────────────────────────────────

/** Build the display label for a turnpoint: "NAME, R Xkm, A Ym, ROLE" */
export function formatTurnpointLabel(tp: Turnpoint, index: number, prefs: UnitPreferences): string {
  const name = tp.waypoint.name || `TP${index + 1}`;
  // Metric always — a cylinder radius is the task's own number (FAI), not a
  // length to convert for the reader; the altitude beside it does convert.
  const radiusStr = formatCylinderRadius(tp.radius).withUnit;
  const altitude = tp.waypoint.altSmoothed ? `A\u00A0${formatAltitude(tp.waypoint.altSmoothed, { prefs }).withUnit}` : '';
  const role = tp.type || '';

  const labelParts = [name, `R\u00A0${radiusStr}`];
  if (altitude) labelParts.push(altitude);
  if (role) labelParts.push(role);
  return labelParts.join(', ');
}

export interface SegmentLabelData {
  midLat: number;
  midLon: number;
  bearing: number;
  text: string;
}

/** Compute segment midpoints, bearings (normalized so text is never upside down), and distance labels. */
export function computeSegmentLabels(
  optimizedPath: Array<{ lat: number; lon: number }>,
  segmentDistances: number[],
  prefs: UnitPreferences,
): SegmentLabelData[] {
  const labels: SegmentLabelData[] = [];
  for (let i = 0; i < optimizedPath.length - 1; i++) {
    const p1 = optimizedPath[i];
    const p2 = optimizedPath[i + 1];
    const distance = segmentDistances[i];

    const midLat = (p1.lat + p2.lat) / 2;
    const midLon = (p1.lon + p2.lon) / 2;

    // Subtract 90: MapBox/CSS text-rotate is relative to horizontal, bearing is relative to north
    let bearing = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon) - 90;
    // Normalize to -90..90 so text is never upside down
    if (bearing > 90) bearing -= 180;
    else if (bearing < -90) bearing += 180;

    const distStr = formatDistance(distance, { decimals: 1, prefs }).withUnit;
    const legNumber = i + 1;
    const text = `Leg ${legNumber} (${distStr})`;

    labels.push({ midLat, midLon, bearing, text });
  }
  return labels;
}

// ── Whole layers ────────────────────────────────────────────────────────

const collection = <F>(features: F[]): FeatureCollection<F> => ({ type: "FeatureCollection", features });

/** Every source the task's layers draw from (spec §Task). */
export interface TaskMapFeatures {
  /** The optimised route, tagging each cylinder's edge (`task-line`). */
  line: FeatureCollection<Feature<LineGeometry, Record<string, never>>>;
  /** Turnpoint dots and their "NAME, R …, A …, ROLE" labels (`task-points`). */
  points: FeatureCollection<Feature<PointGeometry, { name: string; type: string; radius: number }>>;
  /** Cylinders — a LINE goal's last one is its control semicircle (`task-cylinders`). */
  cylinders: FeatureCollection<Feature<PolygonGeometry, { name: string; type: string; radius: number }>>;
  /** Outward arrowheads on exit turnpoints (`task-exit-arrows`). */
  exitArrows: FeatureCollection<PolygonFeature>;
  /** The goal line itself, for a LINE goal (`task-goal-line`). */
  goalLine: FeatureCollection<Feature<LineGeometry, Record<string, never>>>;
  /** "Leg N (X.X km)" at each leg's midpoint (`task-segment-labels`). */
  segmentLabels: FeatureCollection<Feature<PointGeometry, { distance: string; bearing: number }>>;
}

export function taskMapFeatures(task: XCTask, prefs: UnitPreferences): TaskMapFeatures {
  if (task.turnpoints.length === 0) {
    return {
      line: collection([]),
      points: collection([]),
      cylinders: collection([]),
      exitArrows: collection([]),
      goalLine: collection([]),
      segmentLabels: collection([]),
    };
  }
  const optimizedPath = calculateOptimizedTaskLine(task);
  const goalLine = computeGoalLine(task);
  const last = task.turnpoints.length - 1;
  return {
    line: collection([
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: optimizedPath.map((p) => [p.lon, p.lat]) },
      },
    ]),
    points: collection(
      task.turnpoints.map((tp, idx) => ({
        type: "Feature" as const,
        properties: { name: formatTurnpointLabel(tp, idx, prefs), type: tp.type || "", radius: tp.radius },
        geometry: { type: "Point" as const, coordinates: [tp.waypoint.lon, tp.waypoint.lat] as [number, number] },
      })),
    ),
    cylinders: collection(
      task.turnpoints.map((tp, idx) => ({
        type: "Feature" as const,
        properties: { name: tp.waypoint.name || `TP${idx + 1}`, type: tp.type || "", radius: tp.radius },
        geometry:
          goalLine && idx === last
            ? {
                type: "Polygon" as const,
                coordinates: [goalSemicirclePoints(goalLine).map((p) => [p.lon, p.lat] as [number, number])],
              }
            : createCirclePolygon(tp.waypoint.lon, tp.waypoint.lat, tp.radius),
      })),
    ),
    exitArrows: collection(exitTurnpointArrowFeatures(task, optimizedPath)),
    goalLine: collection(
      goalLine
        ? [
            {
              type: "Feature" as const,
              properties: {},
              geometry: {
                type: "LineString" as const,
                coordinates: [
                  [goalLine.end1.lon, goalLine.end1.lat],
                  [goalLine.end2.lon, goalLine.end2.lat],
                ] as [number, number][],
              },
            },
          ]
        : [],
    ),
    segmentLabels: collection(
      computeSegmentLabels(optimizedPath, getOptimizedSegmentDistances(task), prefs).map((label) => ({
        type: "Feature" as const,
        properties: { distance: label.text, bearing: label.bearing },
        geometry: { type: "Point" as const, coordinates: [label.midLon, label.midLat] as [number, number] },
      })),
    ),
  };
}

/**
 * The flight as per-segment lines, each carrying `normalizedAlt` for the
 * altitude-driven colour and width (spec §Flight Track). `range` is the WHOLE
 * flight's, so a track clipped to a moment keeps the colours it had.
 */
export function trackLineFeatures(
  fixes: IGCFix[],
  range: AltitudeRange = calculateAltitudeRange(fixes),
): Feature<LineGeometry, { normalizedAlt: number }>[] {
  return buildTrackSegments(fixes, range.altRange, range.minAlt).map((seg) => {
    const coordinates: [number, number][] = [];
    for (let j = seg.startIndex; j < seg.endIndex; j++) {
      coordinates.push([fixes[j].longitude, fixes[j].latitude]);
    }
    return {
      type: "Feature",
      properties: { normalizedAlt: seg.normalizedAlt },
      geometry: { type: "LineString", coordinates },
    };
  });
}

/**
 * Index of the fix closest in time to `timeMs` (fix times are ascending).
 * Binary search — tracklogs run to tens of thousands of fixes.
 */
export function nearestFixIndexByTime(fixes: IGCFix[], timeMs: number): number {
  let lo = 0;
  let hi = fixes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fixes[mid].time.getTime() < timeMs) lo = mid + 1;
    else hi = mid;
  }
  if (
    lo > 0 &&
    timeMs - fixes[lo - 1].time.getTime() < fixes[lo].time.getTime() - timeMs
  ) {
    return lo - 1;
  }
  return lo;
}
