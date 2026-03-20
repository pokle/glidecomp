/**
 * Shared utilities for map providers.
 *
 * Extracted from mapbox-provider.ts so both MapBox and Leaflet providers
 * can reuse the same constants, color functions, geometry helpers, and DOM builders.
 */

import {
  andoyerDistance, getCirclePoints, calculateBearing, calculatePointMetrics,
  calculateOptimizedTaskLine, getOptimizedSegmentDistances,
  resolveTurnpointSequence, getSSSIndex,
  type IGCFix, type FlightEvent, type XCTask, type Turnpoint,
  type GlideContext, type GlideMarker, type TurnpointSequenceResult,
} from '@taskscore/engine';
import { formatDistance, formatRadius, formatAltitude, formatSpeed, formatAltitudeChange } from './units-browser';
import { config } from './config';


// ── Constants ───────────────────────────────────────────────────────────────

export const MAP_FONT_FAMILY = "'Atkinson Hyperlegible Next', sans-serif";
export const GLIDE_LABEL_TEXT_SHADOW = '0 0 4px rgba(255,255,255,0.9), 0 0 4px rgba(255,255,255,0.9), 0 0 4px rgba(255,255,255,0.9), 0 0 6px rgba(255,255,255,0.9)';
export const GLIDE_LABEL_SPARSE_MIN_ZOOM = 10;
export const GLIDE_LABEL_SPEED_MIN_ZOOM = 11;
export const GLIDE_LABEL_DETAILS_MIN_ZOOM = 13;

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
 * The caller is responsible for building provider-specific geometry (GeoJSON, Leaflet LatLngs, etc.)
 * from the returned index ranges.
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

/**
 * Calculate altitude gradient stops based on line progress.
 * Returns [progress, color] pairs for MapBox line-gradient or similar interpolation.
 */
export function calculateAltitudeGradient(fixes: IGCFix[]): [number, string][] {
  if (fixes.length < 2) return [[0, '#3b82f6'], [1, '#3b82f6']];

  const { minAlt, altRange } = calculateAltitudeRange(fixes);

  const distances: number[] = [0];
  let totalDistance = 0;
  for (let i = 1; i < fixes.length; i++) {
    const dist = andoyerDistance(
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
    const distance = andoyerDistance(lat, lon, fix.latitude, fix.longitude);
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
    const distance = andoyerDistance(lat, lon, fix.latitude, fix.longitude);
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
      <div class="glide-legend-item"><strong>Chevrons:</strong> Direction indicators</div>
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

// ── Circular mean helper ─────────────────────────────────────────────────

/**
 * Compute the circular (angular) mean of a set of directions in degrees.
 * Returns a value in the range [0, 360).
 */
function circularMeanDirection(directions: number[]): number {
  let sumSin = 0;
  let sumCos = 0;
  for (const dir of directions) {
    const rad = (dir * Math.PI) / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  let avg = (Math.atan2(sumSin / directions.length, sumCos / directions.length) * 180) / Math.PI;
  if (avg < 0) avg += 360;
  return avg;
}

// ── Wind estimation from nearby circles ─────────────────────────────────

export interface NearbyWindEstimate {
  speed: number;      // m/s
  direction: number;  // degrees, direction wind is FROM (0-360)
  count: number;      // number of circles averaged
}

/**
 * Estimate wind from up to 3 nearest circle_complete events to a fix index.
 * Averages their ground-speed wind estimates using circular mean for direction.
 */
export function estimateWindFromNearbyCircles(
  events: FlightEvent[],
  fixIndex: number,
  maxCircles: number = 3,
): NearbyWindEstimate | null {
  // Collect circles that have wind data, with their distance to fixIndex
  const circlesWithWind: { dist: number; speed: number; direction: number }[] = [];

  for (const e of events) {
    if (e.type !== 'circle_complete' || !e.segment) continue;
    const details = e.details as Record<string, unknown> | undefined;
    if (!details) continue;

    // Prefer ground-speed wind; fall back to drift wind
    let speed = details.windSpeed as number | undefined;
    let dir = details.windDirection as number | undefined;
    if (speed == null || dir == null) {
      speed = details.driftWindSpeed as number | undefined;
      dir = details.driftWindDirection as number | undefined;
    }
    if (speed == null || dir == null) continue;

    // Distance = closest segment boundary to fixIndex
    const midIndex = Math.round((e.segment.startIndex + e.segment.endIndex) / 2);
    const dist = Math.abs(midIndex - fixIndex);
    circlesWithWind.push({ dist, speed, direction: dir });
  }

  if (circlesWithWind.length === 0) return null;

  // Sort by distance and take nearest N
  circlesWithWind.sort((a, b) => a.dist - b.dist);
  const nearest = circlesWithWind.slice(0, maxCircles);

  // Average speed (arithmetic) and direction (circular mean)
  let sumSpeed = 0;
  for (const c of nearest) {
    sumSpeed += c.speed;
  }
  const avgSpeed = sumSpeed / nearest.length;
  const avgDirection = circularMeanDirection(nearest.map(c => c.direction));

  return { speed: avgSpeed, direction: avgDirection, count: nearest.length };
}

// ── Crosshair SVG ───────────────────────────────────────────────────────

/** Crosshair SVG for the map marker (white with drop-shadow for visibility) */
export const CROSSHAIR_MAP_SVG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="filter:drop-shadow(0 0 2px rgba(0,0,0,0.8))">
  <circle cx="12" cy="12" r="4" stroke="white" stroke-width="1.5"/>
  <line x1="12" y1="2" x2="12" y2="8" stroke="white" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="16" x2="12" y2="22" stroke="white" stroke-width="2" stroke-linecap="round"/>
  <line x1="2" y1="12" x2="8" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"/>
  <line x1="16" y1="12" x2="22" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/** Crosshair SVG for the HUD (white, inline with text) */
export const CROSSHAIR_HUD_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="display:inline-block;vertical-align:middle;margin-right:4px">
  <circle cx="12" cy="12" r="4" stroke="white" stroke-width="2"/>
  <line x1="12" y1="2" x2="12" y2="8" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="12" y1="16" x2="12" y2="22" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="2" y1="12" x2="8" y2="12" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="16" y1="12" x2="22" y2="12" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// ── Last-thermal lookup ──────────────────────────────────────────────────

export interface LastThermalData {
  wind: { speed: number; direction: number } | null;
  maxAltitude: number;
  maxAltitudeTime: Date;
  circleCount: number;
}

/**
 * Find the most recent climbing circles before fixIndex and return
 * averaged wind + max altitude from those circles.
 */
export function findLastThermalData(
  events: FlightEvent[],
  fixes: IGCFix[],
  fixIndex: number,
  maxCircles: number = 3,
): LastThermalData | null {
  // Collect climbing circles that end before fixIndex
  const climbingCircles: { endIndex: number; speed: number | null; direction: number | null; startIndex: number }[] = [];

  for (const e of events) {
    if (e.type !== 'circle_complete' || !e.segment) continue;
    if (e.segment.endIndex >= fixIndex) continue;

    const details = e.details as Record<string, unknown> | undefined;
    if (!details) continue;

    const climbRate = details.climbRate as number | undefined;
    if (climbRate == null || climbRate <= 0) continue;

    // Prefer ground-speed wind; fall back to drift wind
    let speed = details.windSpeed as number | undefined;
    let dir = details.windDirection as number | undefined;
    if (speed == null || dir == null) {
      speed = details.driftWindSpeed as number | undefined;
      dir = details.driftWindDirection as number | undefined;
    }

    climbingCircles.push({
      endIndex: e.segment.endIndex,
      startIndex: e.segment.startIndex,
      speed: speed ?? null,
      direction: dir ?? null,
    });
  }

  if (climbingCircles.length === 0) return null;

  // Sort by endIndex descending (most recent first), take up to maxCircles
  climbingCircles.sort((a, b) => b.endIndex - a.endIndex);
  const selected = climbingCircles.slice(0, maxCircles);

  // Find max altitude and its time across all selected circles' fixes
  let maxAlt = -Infinity;
  let maxAltTime = fixes[selected[0].startIndex].time;
  for (const c of selected) {
    const start = Math.max(0, c.startIndex);
    const end = Math.min(fixes.length - 1, c.endIndex);
    for (let i = start; i <= end; i++) {
      if (fixes[i].gnssAltitude > maxAlt) {
        maxAlt = fixes[i].gnssAltitude;
        maxAltTime = fixes[i].time;
      }
    }
  }

  // Average wind using circular mean (only from circles that have wind data)
  const withWind = selected.filter(c => c.speed != null && c.direction != null);
  let wind: { speed: number; direction: number } | null = null;
  if (withWind.length > 0) {
    let sumSpeed = 0;
    for (const c of withWind) {
      sumSpeed += c.speed!;
    }
    const avgSpeed = sumSpeed / withWind.length;
    const avgDirection = circularMeanDirection(withWind.map(c => c.direction!));
    wind = { speed: avgSpeed, direction: avgDirection };
  }

  return { wind, maxAltitude: maxAlt, maxAltitudeTime: maxAltTime, circleCount: selected.length };
}

// ── Track Point HUD helpers ──────────────────────────────────────────────

/** Create the HUD container element and append it to the map container */
export function createTrackPointHUD(container: HTMLElement): HTMLElement {
  const hud = document.createElement('div');
  hud.id = 'track-point-hud';
  hud.style.display = 'none';
  hud.style.left = '8px';
  hud.style.bottom = '32px';
  hud.innerHTML = `
    <div class="hud-drag-handle"></div>
    <button class="hud-toggle" title="Minimize">−</button>
    <div class="hud-body">
      <details open class="hud-group">
        <summary class="hud-summary">${CROSSHAIR_HUD_SVG}Point</summary>
        <div class="hud-alt"></div>
      </details>
      <div class="hud-divider"></div>
      <details open class="hud-group">
        <summary class="hud-summary">1 km avg</summary>
        <div class="hud-speed"></div>
        <div class="hud-req"></div>
      </details>
      <div class="hud-divider hud-thermal-divider"></div>
      <details open class="hud-group hud-thermal-group">
        <summary class="hud-summary">Last Thermal</summary>
        <div class="hud-thermal-alt"></div>
        <div class="hud-wind"></div>
      </details>
    </div>
  `;
  const toggle = hud.querySelector('.hud-toggle') as HTMLButtonElement;
  toggle.addEventListener('click', () => {
    const minimized = hud.classList.toggle('hud-minimized');
    toggle.textContent = minimized ? '+' : '−';
    toggle.title = minimized ? 'Expand' : 'Minimize';
  });
  container.appendChild(hud);
  makeHUDDraggable(hud, container);
  return hud;
}

/** Make the HUD draggable within its container via pointer events */
function makeHUDDraggable(hud: HTMLElement, container: HTMLElement): void {
  let anchoredToTop = false;
  let offsetX = 0;
  let offsetY = 0;

  function convertToTopLeft(): void {
    if (anchoredToTop) return;
    const rect = hud.getBoundingClientRect();
    const parentRect = container.getBoundingClientRect();
    hud.style.top = rect.top - parentRect.top + 'px';
    hud.style.left = rect.left - parentRect.left + 'px';
    hud.style.bottom = '';
    anchoredToTop = true;
  }

  function clamp(): void {
    if (!anchoredToTop) return;
    const parentRect = container.getBoundingClientRect();
    const hudRect = hud.getBoundingClientRect();
    let top = parseFloat(hud.style.top) || 0;
    let left = parseFloat(hud.style.left) || 0;
    const maxTop = parentRect.height - hudRect.height;
    const maxLeft = parentRect.width - hudRect.width;
    top = Math.max(0, Math.min(top, maxTop));
    left = Math.max(0, Math.min(left, maxLeft));
    hud.style.top = top + 'px';
    hud.style.left = left + 'px';
  }

  hud.addEventListener('pointerdown', (e: PointerEvent) => {
    // Don't drag when interacting with buttons or accordion toggles
    const target = e.target as HTMLElement;
    if (target.closest('button, summary, details')) return;

    convertToTopLeft();

    const parentRect = container.getBoundingClientRect();
    const hudRect = hud.getBoundingClientRect();
    offsetX = e.clientX - (hudRect.left - parentRect.left);
    offsetY = e.clientY - (hudRect.top - parentRect.top);

    hud.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  hud.addEventListener('pointermove', (e: PointerEvent) => {
    if (!hud.hasPointerCapture(e.pointerId)) return;
    e.stopPropagation();

    const parentRect = container.getBoundingClientRect();
    const hudRect = hud.getBoundingClientRect();
    let newLeft = e.clientX - offsetX;
    let newTop = e.clientY - offsetY;

    // Clamp within container
    const maxLeft = parentRect.width - hudRect.width;
    const maxTop = parentRect.height - hudRect.height;
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    newTop = Math.max(0, Math.min(newTop, maxTop));

    hud.style.left = newLeft + 'px';
    hud.style.top = newTop + 'px';
  });

  hud.addEventListener('pointerup', (e: PointerEvent) => {
    if (hud.hasPointerCapture(e.pointerId)) {
      hud.releasePointerCapture(e.pointerId);
    }
  });

  hud.addEventListener('pointercancel', (e: PointerEvent) => {
    if (hud.hasPointerCapture(e.pointerId)) {
      hud.releasePointerCapture(e.pointerId);
    }
  });

  // Re-clamp if container resizes
  new ResizeObserver(() => clamp()).observe(container);
}

/** Wind arrow SVG pointing down (south). Rotate by wind-FROM direction to show flow. */
function windArrowSVG(direction: number): string {
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:inline-block;vertical-align:middle;margin-right:3px;transform:rotate(${direction}deg)">
    <line x1="7" y1="1" x2="7" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M3 8 L7 12 L11 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Update HUD content and show it */
export function updateTrackPointHUD(
  el: HTMLElement,
  opts: {
    pointAlt: string;
    pointTime: string;
    speed: string;
    altChange: string;
    req?: string;
    thermal?: { maxAlt: string; maxAltTime: string; wind?: { direction: number; speedText: string } };
  },
): void {
  const altEl = el.querySelector('.hud-alt') as HTMLElement;
  const speedEl = el.querySelector('.hud-speed') as HTMLElement;
  const reqEl = el.querySelector('.hud-req') as HTMLElement;
  const thermalDivider = el.querySelector('.hud-thermal-divider') as HTMLElement;
  const thermalGroup = el.querySelector('.hud-thermal-group') as HTMLElement;
  const thermalAltEl = el.querySelector('.hud-thermal-alt') as HTMLElement;
  const windEl = el.querySelector('.hud-wind') as HTMLElement;

  altEl.textContent = `${opts.pointAlt} at ${opts.pointTime}`;
  speedEl.textContent = `${opts.speed}  ${opts.altChange}`;

  if (opts.req) {
    reqEl.textContent = opts.req;
    reqEl.style.display = '';
  } else {
    reqEl.textContent = '';
    reqEl.style.display = 'none';
  }

  if (opts.thermal) {
    thermalDivider.style.display = '';
    thermalGroup.style.display = '';
    thermalAltEl.textContent = `${opts.thermal.maxAlt} at ${opts.thermal.maxAltTime}`;

    if (opts.thermal.wind) {
      windEl.innerHTML = `${windArrowSVG(opts.thermal.wind.direction)}${opts.thermal.wind.speedText}`;
      windEl.style.display = '';
    } else {
      windEl.innerHTML = '';
      windEl.style.display = 'none';
    }
  } else {
    thermalDivider.style.display = 'none';
    thermalGroup.style.display = 'none';
    windEl.innerHTML = '';
    windEl.style.display = 'none';
  }

  el.style.display = '';
}

/** Hide the HUD element */
export function hideTrackPointHUD(el: HTMLElement | null): void {
  if (el) el.style.display = 'none';
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

// ── Shared business logic ────────────────────────────────────────────────
// Pure functions extracted from MapBox/Leaflet providers to eliminate duplication.
// Each provider calls these, then applies the result using its own map API.

// ── buildTrackPointHUDData ──────────────────────────────────────────────

export interface TrackPointHUDData {
  fix: IGCFix;
  speed: string;
  pointAlt: string;
  pointTime: string;
  altChange: string;
  req?: string;
  thermal?: { maxAlt: string; maxAltTime: string; wind?: { direction: number; speedText: string } };
}

/**
 * Compute all data needed for the track-point HUD display.
 * Returns null if metrics can't be calculated (e.g., insufficient fixes).
 */
export function buildTrackPointHUDData(
  fixes: IGCFix[],
  events: FlightEvent[],
  fixIndex: number,
  getNextTurnpointContext: (time: number) => GlideContext | undefined,
): TrackPointHUDData | null {
  if (fixes.length === 0) return null;

  const fix = fixes[fixIndex];
  const glideStartTime = fix.time.getTime();
  const glideContext = getNextTurnpointContext(glideStartTime);
  const metrics = calculatePointMetrics(fixes, fixIndex, 1000, glideContext);
  if (!metrics) return null;

  const speed = formatSpeed(metrics.speedMps).withUnit;
  const pointAlt = formatAltitude(fix.gnssAltitude).withUnit;
  const pointTime = fix.time.toLocaleTimeString();
  const altChange = formatAltitudeChange(metrics.altitudeDiff).withUnit;

  let req: string | undefined;
  if (metrics.requiredGlideRatio !== undefined && metrics.targetName) {
    req = `\u2198${metrics.requiredGlideRatio.toFixed(0)}:1 to ${metrics.targetName}`;
  }

  let thermal: TrackPointHUDData['thermal'];
  const thermalData = findLastThermalData(events, fixes, fixIndex);
  if (thermalData) {
    thermal = {
      maxAlt: formatAltitude(thermalData.maxAltitude).withUnit,
      maxAltTime: thermalData.maxAltitudeTime.toLocaleTimeString(),
    };
    if (thermalData.wind) {
      thermal.wind = {
        direction: thermalData.wind.direction,
        speedText: formatSpeed(thermalData.wind.speed).withUnit,
      };
    }
  }

  return { fix, speed, pointAlt, pointTime, altChange, req, thermal };
}

// ── buildNextTurnpointContext ────────────────────────────────────────────

/**
 * Resolve the next turnpoint context for glide calculations.
 * The `resolveAltitude` callback lets each provider supply altitude differently:
 *   - MapBox queries terrain elevation, falling back to altSmoothed
 *   - Leaflet uses altSmoothed directly
 */
export function buildNextTurnpointContext(
  task: XCTask,
  fixes: IGCFix[],
  sequenceResult: TurnpointSequenceResult,
  optimizedPath: Array<{ lat: number; lon: number }>,
  glideStartTime: number,
  resolveAltitude: (lat: number, lon: number, altSmoothed: number | undefined) => number | null,
): GlideContext | undefined {
  const sequence = sequenceResult.sequence;

  // Find last reaching with time <= glideStartTime
  let nextTaskIndex: number;
  const lastReached = sequence.filter(r => r.time.getTime() <= glideStartTime);
  if (lastReached.length > 0) {
    nextTaskIndex = lastReached[lastReached.length - 1].taskIndex + 1;
  } else {
    // No TP reached yet — next is SSS
    nextTaskIndex = getSSSIndex(task);
    if (nextTaskIndex < 0) return undefined;
  }

  // Bounds check
  if (nextTaskIndex >= task.turnpoints.length) return undefined;

  const tp = task.turnpoints[nextTaskIndex];

  // Use optimized path point for the target position
  const targetLat = optimizedPath[nextTaskIndex]?.lat ?? tp.waypoint.lat;
  const targetLon = optimizedPath[nextTaskIndex]?.lon ?? tp.waypoint.lon;

  const altitude = resolveAltitude(targetLat, targetLon, tp.waypoint.altSmoothed);
  if (altitude == null) return undefined;

  return {
    nextTurnpoint: { lat: targetLat, lon: targetLon, altitude, name: tp.waypoint.name || `TP${nextTaskIndex + 1}` },
  };
}

/**
 * Ensure cached sequence result and optimized path are computed.
 * Returns the pair, computing lazily if needed.
 */
export function ensureTurnpointCache(
  task: XCTask,
  fixes: IGCFix[],
  cached: { sequenceResult: TurnpointSequenceResult | null; optimizedPath: { lat: number; lon: number }[] | null },
): { sequenceResult: TurnpointSequenceResult; optimizedPath: { lat: number; lon: number }[] } {
  if (!cached.sequenceResult) {
    cached.sequenceResult = resolveTurnpointSequence(task, fixes);
  }
  if (!cached.optimizedPath) {
    cached.optimizedPath = calculateOptimizedTaskLine(task);
  }
  return { sequenceResult: cached.sequenceResult, optimizedPath: cached.optimizedPath };
}

// ── formatGlideLabel ────────────────────────────────────────────────────

export interface FormattedGlideLabel {
  speed: string;
  altitude: string;
  detailText: string;
  reqText: string;
}

/** Format a glide marker's data into display strings for speed, altitude, detail, and required GR. */
export function formatGlideLabel(marker: GlideMarker): FormattedGlideLabel {
  const speedVal = formatSpeed(marker.speedMps || 0);
  const speed = `${speedVal.formatted}\u00A0<span style="font-size:0.7em">${speedVal.unit}</span>`;
  const altVal = marker.altitude !== undefined ? formatAltitude(marker.altitude) : null;
  const altitude = altVal ? `${altVal.formatted}\u00A0<span style="font-size:0.7em">${altVal.unit}</span>` : '';
  const glideRatio = marker.glideRatio !== undefined
    ? `${marker.glideRatio.toFixed(0)}:1`
    : '\u221E:1';
  const altDiff = marker.altitudeDiff !== undefined
    ? formatAltitudeChange(marker.altitudeDiff).withUnit
    : '';
  const detailText = `${glideRatio} ${altDiff}`.trim();

  let reqText = '';
  if (marker.requiredGlideRatio !== undefined && marker.targetName) {
    reqText = `${marker.requiredGlideRatio.toFixed(0)}:1 to ${marker.targetName}`;
  }

  return { speed, altitude, detailText, reqText };
}

// ── formatTurnpointLabel ────────────────────────────────────────────────

/** Build the display label for a turnpoint: "NAME, R Xkm, A Ym, ROLE" */
export function formatTurnpointLabel(tp: Turnpoint, index: number): string {
  const name = tp.waypoint.name || `TP${index + 1}`;
  const radiusStr = formatRadius(tp.radius).withUnit;
  const altitude = tp.waypoint.altSmoothed ? `A\u00A0${formatAltitude(tp.waypoint.altSmoothed).withUnit}` : '';
  const role = tp.type || '';

  const labelParts = [name, `R\u00A0${radiusStr}`];
  if (altitude) labelParts.push(altitude);
  if (role) labelParts.push(role);
  return labelParts.join(', ');
}

// ── computeSegmentLabels ────────────────────────────────────────────────

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

    const distStr = formatDistance(distance, { decimals: 1 }).withUnit;
    const legNumber = i + 1;
    const text = `Leg ${legNumber} (${distStr})`;

    labels.push({ midLat, midLon, bearing, text });
  }
  return labels;
}

// ── updateGlideLabelElement ─────────────────────────────────────────────

/** Check if an element should be hidden at this zoom based on sparse stepping. */
function isSparseHidden(zoom: number, index: number): boolean {
  return zoom < GLIDE_LABEL_SPEED_MIN_ZOOM && index % 3 !== 0;
}

/** Apply zoom-dependent display logic to a single glide-label element.
 *  When `skipZoomFilter` is true, zoom-based hiding is skipped (collision detection handles it instead). */
export function updateGlideLabelElement(
  el: HTMLElement, zoom: number, labelIndex?: number,
  occluded?: boolean, skipZoomFilter?: boolean,
): void {
  if (occluded) {
    el.style.display = 'none';
    return;
  }
  if (!skipZoomFilter) {
    if (zoom < GLIDE_LABEL_SPARSE_MIN_ZOOM) {
      el.style.display = 'none';
      return;
    }
    if (labelIndex !== undefined && !el.dataset.fastest && isSparseHidden(zoom, labelIndex)) {
      el.style.display = 'none';
      return;
    }
  }

  const speed = el.dataset.speedLabel || '';
  const alt = el.dataset.altLabel || '';
  const metricsLine = alt ? `${speed}\u2002${alt}` : speed;
  el.style.display = '';

  if (zoom < GLIDE_LABEL_DETAILS_MIN_ZOOM) {
    el.innerHTML = metricsLine;
  } else {
    const details = el.dataset.detailLabel || '';
    const req = el.dataset.reqLabel || '';
    let html = details ? `${metricsLine}<br>${details}` : metricsLine;
    if (req) html += `<br>${req}`;
    el.innerHTML = html;
  }
}

// ── Screen-space label collision detection ─────────────────────────────────

export interface LabelScreenPos {
  index: number;
  x: number;
  y: number;
  isFastest: boolean;
}

/**
 * Greedy priority-based occlusion: project labels to screen space, sort by
 * priority (fastest first, then lower index), and hide any that overlap an
 * already-placed label.  Returns the set of label indices to hide.
 */
export function computeOccludedLabels(labels: LabelScreenPos[], zoom: number): Set<number> {
  const occluded = new Set<number>();
  if (labels.length === 0) return occluded;

  // Estimate label dimensions based on zoom (compact vs detail mode)
  const w = zoom < GLIDE_LABEL_DETAILS_MIN_ZOOM ? 160 : 180;
  const h = zoom < GLIDE_LABEL_DETAILS_MIN_ZOOM ? 30 : 65;
  const padX = 10;
  const padY = 6;
  const halfW = (w + padX) / 2;
  const halfH = (h + padY) / 2;

  // Sort: fastest first, then by original index (earlier in flight = higher priority)
  const sorted = labels.slice().sort((a, b) => {
    if (a.isFastest !== b.isFastest) return a.isFastest ? -1 : 1;
    return a.index - b.index;
  });

  // Placed label centers for AABB overlap checks
  const placed: { x: number; y: number }[] = [];

  for (const label of sorted) {
    let overlaps = false;
    for (const p of placed) {
      if (Math.abs(label.x - p.x) < halfW * 2 && Math.abs(label.y - p.y) < halfH * 2) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) {
      occluded.add(label.index);
    } else {
      placed.push({ x: label.x, y: label.y });
    }
  }

  return occluded;
}
