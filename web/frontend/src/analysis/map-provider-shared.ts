/**
 * Shared utilities for map providers.
 *
 * Extracted from mapbox-provider.ts so both MapBox and Leaflet providers
 * can reuse the same constants, color functions, geometry helpers, and DOM builders.
 */

import { haversineDistance, getCirclePoints, type IGCFix } from '@taskscore/analysis';

// ── Constants ───────────────────────────────────────────────────────────────

export const MAP_FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
export const GLIDE_LABEL_SPEED_MIN_ZOOM = 11;
export const GLIDE_LABEL_DETAILS_MIN_ZOOM = 13;

export const TRACK_COLOR = '#f97316';
export const TRACK_OUTLINE_COLOR = '#000000';
export const HIGHLIGHT_COLOR = '#00ffff';
export const TASK_COLOR = '#6366f1';

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

/**
 * Calculate altitude gradient stops based on line progress.
 * Returns [progress, color] pairs for MapBox line-gradient or similar interpolation.
 */
export function calculateAltitudeGradient(fixes: IGCFix[]): [number, string][] {
  if (fixes.length < 2) return [[0, '#3b82f6'], [1, '#3b82f6']];

  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (const fix of fixes) {
    if (fix.gnssAltitude < minAlt) minAlt = fix.gnssAltitude;
    if (fix.gnssAltitude > maxAlt) maxAlt = fix.gnssAltitude;
  }
  const altRange = maxAlt - minAlt;

  const distances: number[] = [0];
  let totalDistance = 0;
  for (let i = 1; i < fixes.length; i++) {
    const dist = haversineDistance(
      fixes[i - 1].latitude, fixes[i - 1].longitude,
      fixes[i].latitude, fixes[i].longitude
    );
    totalDistance += dist;
    distances.push(totalDistance);
  }

  if (totalDistance === 0) return [[0, '#3b82f6'], [1, '#3b82f6']];

  const stops: [number, string][] = [];
  // Limit gradient stops to ~100 for performance (MapBox has 256 stop limit)
  const MAX_GRADIENT_STOPS = 100;
  const sampleInterval = Math.max(1, Math.floor(fixes.length / MAX_GRADIENT_STOPS));

  const firstNormalizedAlt = altRange > 0 ? (fixes[0].gnssAltitude - minAlt) / altRange : 0;
  stops.push([0, getAltitudeColorNormalized(firstNormalizedAlt)]);

  let lastProgress = 0;
  const minProgressIncrement = 0.001;

  for (let i = sampleInterval; i < fixes.length; i += sampleInterval) {
    const progress = distances[i] / totalDistance;
    if (progress > lastProgress + minProgressIncrement) {
      const normalizedAlt = altRange > 0 ? (fixes[i].gnssAltitude - minAlt) / altRange : 0;
      const color = getAltitudeColorNormalized(normalizedAlt);
      stops.push([progress, color]);
      lastProgress = progress;
    }
  }

  if (lastProgress < 1 - minProgressIncrement) {
    const lastFix = fixes[fixes.length - 1];
    const normalizedAlt = altRange > 0 ? (lastFix.gnssAltitude - minAlt) / altRange : 0;
    stops.push([1, getAltitudeColorNormalized(normalizedAlt)]);
  } else {
    const lastFix = fixes[fixes.length - 1];
    const normalizedAlt = altRange > 0 ? (lastFix.gnssAltitude - minAlt) / altRange : 0;
    stops[stops.length - 1] = [1, getAltitudeColorNormalized(normalizedAlt)];
  }

  return stops;
}

// ── Geometry helpers ────────────────────────────────────────────────────────

/**
 * Find the index of the fix closest to the given lat/lon.
 * When the track crosses over itself and multiple fixes are at similar
 * distances, prefer the latest fix (highest index) because map renderers
 * draw later segments on top of earlier ones — so the user is clicking
 * on the topmost (most recent) part of the track.
 */
export function findNearestFixIndex(fixes: IGCFix[], lat: number, lon: number): number {
  if (fixes.length === 0) return -1;

  let minDistance = Infinity;
  let nearestIndex = 0;

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    const distance = haversineDistance(lat, lon, fix.latitude, fix.longitude);
    if (distance < minDistance) {
      minDistance = distance;
      nearestIndex = i;
    }
  }

  // When the track crosses itself, multiple fixes can be very close to the
  // click point. Prefer the latest one (highest index) since it's rendered
  // on top and is what the user visually clicked on.
  // Use a small absolute tolerance (50m) capped so we don't match distant fixes.
  if (minDistance > 200) return nearestIndex; // click is far from track, no ambiguity
  const tolerance = Math.max(minDistance * 2, minDistance + 30);
  for (let i = fixes.length - 1; i > nearestIndex; i--) {
    const fix = fixes[i];
    const distance = haversineDistance(lat, lon, fix.latitude, fix.longitude);
    if (distance <= tolerance) {
      return i;
    }
  }

  return nearestIndex;
}

/** Create a GeoJSON circle polygon for cylinder rendering */
export function createCirclePolygon(
  centerLon: number,
  centerLat: number,
  radiusMeters: number,
  numPoints = 64
): GeoJSON.Polygon {
  const points = getCirclePoints(centerLat, centerLon, radiusMeters, numPoints);
  const coords: [number, number][] = points.map(p => [p.lon, p.lat]);
  return {
    type: 'Polygon',
    coordinates: [coords],
  };
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

/**
 * Create the glide legend help button and append it to the container.
 * Styling is handled by CSS (#glide-legend rules in styles.css).
 */
export function createGlideLegend(container: HTMLElement): HTMLElement {
  const legend = document.createElement('div');
  legend.id = 'glide-legend';
  legend.innerHTML = `
    <button class="glide-legend-btn" title="Glide metrics help">?</button>
    <div class="glide-legend-content">
      <div class="glide-legend-title">Glide Metrics</div>
      <div class="glide-legend-item"><strong>Chevrons:</strong> 1km segment markers</div>
      <div class="glide-legend-item"><strong>Speed:</strong> Average speed of segment</div>
      <div class="glide-legend-item"><strong>L/D:</strong> Glide ratio (distance &divide; altitude lost)</div>
      <div class="glide-legend-item"><strong>Alt:</strong> Altitude change from segment start to end</div>
    </div>
  `;

  const btn = legend.querySelector('.glide-legend-btn');
  btn?.addEventListener('click', () => {
    legend.classList.toggle('expanded');
  });

  container.appendChild(legend);
  return legend;
}

/** Show or hide the glide legend element */
export function showGlideLegend(element: HTMLElement | null, show: boolean): void {
  if (!element) return;
  if (show) {
    element.style.display = 'block';
    element.classList.remove('expanded');
  } else {
    element.style.display = 'none';
  }
}

/** Create circle polygon points as LatLng pairs for Leaflet Polygon */
export function createCirclePolygonLatLng(
  centerLat: number,
  centerLon: number,
  radiusMeters: number,
  numPoints = 64
): [number, number][] {
  const points = getCirclePoints(centerLat, centerLon, radiusMeters, numPoints);
  return points.map(p => [p.lat, p.lon]);
}
