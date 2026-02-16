/**
 * ArcGIS Provider
 *
 * ArcGIS Maps SDK for JavaScript implementation of the MapProvider interface.
 * Uses SceneView for built-in 3D terrain, elevation, and camera control.
 * Showcases ArcGIS-native features: geodesic Circle geometry, BasemapGallery,
 * GraphicsLayers, hitTest, and world elevation.
 */

import EsriMap from '@arcgis/core/Map.js';
import SceneView from '@arcgis/core/views/SceneView.js';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js';
import Graphic from '@arcgis/core/Graphic.js';
import Point from '@arcgis/core/geometry/Point.js';
import Polyline from '@arcgis/core/geometry/Polyline.js';
import Circle from '@arcgis/core/geometry/Circle.js';
import esriConfig from '@arcgis/core/config.js';
import ScaleBar from '@arcgis/core/widgets/ScaleBar.js';
import BasemapGallery from '@arcgis/core/widgets/BasemapGallery.js';
import Fullscreen from '@arcgis/core/widgets/Fullscreen.js';
import Home from '@arcgis/core/widgets/Home.js';
import Compass from '@arcgis/core/widgets/Compass.js';

import {
  getBoundingBox, getEventStyle, calculateGlideMarkers,
  calculateOptimizedTaskLine, getOptimizedSegmentDistances,
  calculateBearing, haversineDistance,
  type IGCFix, type XCTask, type FlightEvent,
} from '@taskscore/analysis';
import type { MapProvider } from './map-provider';
import { formatDistance, formatRadius, formatAltitude, formatSpeed, formatAltitudeChange } from './units-browser';
import { config } from './config';
import {
  MAP_FONT_FAMILY, GLIDE_LABEL_SPEED_MIN_ZOOM, GLIDE_LABEL_DETAILS_MIN_ZOOM,
  TRACK_COLOR, TRACK_OUTLINE_COLOR, HIGHLIGHT_COLOR, TASK_COLOR,
  getTurnpointColor, KEY_EVENT_TYPES, getAltitudeColorNormalized,
  calculateAltitudeGradient, findNearestFixIndex,
  createGlideLegend, showGlideLegend as sharedShowGlideLegend,
} from './map-provider-shared';

// ── Types ───────────────────────────────────────────────────────────────────

// ArcGIS uses "auto-casting" — you pass plain objects with a `type` discriminant
// and the SDK casts them to the correct class at runtime. The TypeScript types
// are strict discriminated unions, but our helper functions return compatible objects.
// We use this alias to pass symbol property objects through Graphic constructors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySymbol = any;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Parse CSS hex/rgb color to [r, g, b, a] array for ArcGIS symbols */
function parseColor(color: string): [number, number, number, number] {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return [r, g, b, 1];
  }
  if (color.startsWith('rgb')) {
    const match = color.match(/(\d+)/g);
    if (match && match.length >= 3) {
      return [+match[0], +match[1], +match[2], match[3] ? +match[3] : 1];
    }
  }
  return [0, 0, 0, 1];
}

/** Create a simple line symbol */
function lineSymbol(color: string, width: number, opacity = 1, style = 'solid'): AnySymbol {
  const [r, g, b] = parseColor(color);
  return { type: 'simple-line', color: [r, g, b, opacity], width, style };
}

/** Create a simple fill symbol */
function fillSymbol(fillColor: string, fillOpacity: number, outlineColor: string, outlineWidth: number, outlineOpacity = 1): AnySymbol {
  const [fr, fg, fb] = parseColor(fillColor);
  const [or, og, ob] = parseColor(outlineColor);
  return {
    type: 'simple-fill',
    color: [fr, fg, fb, fillOpacity],
    outline: { color: [or, og, ob, outlineOpacity], width: outlineWidth },
  };
}

/** Create a simple marker symbol */
function markerSymbol(color: string, size: number, outlineColor = '#ffffff', outlineWidth = 2): AnySymbol {
  const [r, g, b] = parseColor(color);
  const [or, og, ob] = parseColor(outlineColor);
  return {
    type: 'simple-marker',
    color: [r, g, b, 1],
    size,
    outline: { color: [or, og, ob, 1], width: outlineWidth },
  };
}

/** Create a text symbol */
function textSymbol(text: string, color: string, size: number, haloColor = '#ffffff', haloSize = 2, yoffset = 0): AnySymbol {
  const [r, g, b] = parseColor(color);
  const [hr, hg, hb] = parseColor(haloColor);
  return {
    type: 'text',
    text,
    color: [r, g, b, 1],
    font: { size, family: MAP_FONT_FAMILY, weight: 'bold' },
    haloColor: [hr, hg, hb, 1],
    haloSize,
    yoffset,
  };
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * Create an ArcGIS map provider
 */
export function createArcGISProvider(container: HTMLElement): Promise<MapProvider> {
  return new Promise((resolve, reject) => {
    try {
      // Load ArcGIS CSS dynamically to avoid bloating other providers
      if (!document.getElementById('arcgis-css')) {
        const link = document.createElement('link');
        link.id = 'arcgis-css';
        link.rel = 'stylesheet';
        link.href = 'https://js.arcgis.com/4.34/esri/themes/dark/main.css';
        document.head.appendChild(link);
      }

      // Set API key
      esriConfig.apiKey = import.meta.env.VITE_ARCGIS_API_KEY;

      // Saved map location
      const savedLocation = config.getMapLocation();

      const map = new EsriMap({
        basemap: 'arcgis-topographic',
        ground: 'world-elevation',
      });

      // Graphics layers (bottom to top order)
      const taskLineLayer = new GraphicsLayer({ title: 'Task Line' });
      const taskCylindersLayer = new GraphicsLayer({ title: 'Task Cylinders' });
      const trackOutlineLayer = new GraphicsLayer({ title: 'Track Outline' });
      const trackLayer = new GraphicsLayer({ title: 'Track' });
      const trackGradientLayer = new GraphicsLayer({ title: 'Track Gradient', visible: false });
      const highlightLayer = new GraphicsLayer({ title: 'Highlight' });
      const taskPointsLayer = new GraphicsLayer({ title: 'Task Points' });
      const taskLabelsLayer = new GraphicsLayer({ title: 'Task Labels' });
      const eventMarkersLayer = new GraphicsLayer({ title: 'Event Markers' });
      const activeMarkersLayer = new GraphicsLayer({ title: 'Active Markers' });

      map.addMany([
        taskLineLayer, taskCylindersLayer,
        trackOutlineLayer, trackLayer, trackGradientLayer,
        highlightLayer,
        taskPointsLayer, taskLabelsLayer,
        eventMarkersLayer, activeMarkersLayer,
      ]);

      const viewDiv = container as HTMLDivElement;

      const view = new SceneView({
        container: viewDiv,
        map,
        center: savedLocation ? [savedLocation.center[0], savedLocation.center[1]] : [0, 0],
        zoom: savedLocation?.zoom ?? 2,
        camera: savedLocation ? {
          position: {
            longitude: savedLocation.center[0],
            latitude: savedLocation.center[1],
            z: 0,
          },
          tilt: savedLocation.pitch ?? 45,
          heading: savedLocation.bearing ?? 0,
        } : undefined,
        qualityProfile: 'high',
      });

      // State
      let boundsChangeCallback: (() => void) | null = null;
      let currentFixes: IGCFix[] = [];
      let currentTask: XCTask | null = null;
      let currentEvents: FlightEvent[] = [];
      let glideLegendElement: HTMLElement | null = null;

      // Rendering modes
      let isAltitudeColorsMode = false;
      let is3DMode = false;
      let isTaskVisible = true;
      let isTrackVisible = true;

      // Callbacks
      let trackClickCallback: ((fixIndex: number) => void) | null = null;
      let turnpointClickCallback: ((turnpointIndex: number) => void) | null = null;

      // Location saving
      let saveLocationTimer: ReturnType<typeof setTimeout> | null = null;

      // ── Widgets ─────────────────────────────────────────────────────────

      view.when(() => {
        // Scale bar
        // ScaleBar types expect MapView but works with SceneView at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        view.ui.add(new ScaleBar({ view: view as any, unit: 'metric' }), 'bottom-left');

        // Home button
        view.ui.add(new Home({ view }), 'top-left');

        // Compass
        view.ui.add(new Compass({ view }), 'top-left');

        // Fullscreen
        view.ui.add(new Fullscreen({ view }), 'top-left');

        // Basemap gallery
        // BasemapGallery types expect MapView but works fine with SceneView at runtime
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const basemapGallery = new BasemapGallery({ view: view as any });
        view.ui.add(basemapGallery, 'top-left');

        // Save basemap preference on change
        if (view.map) {
          view.map.watch('basemap', () => {
            if (view.map) {
              const basemap = view.map.basemap;
              if (basemap) {
                config.setPreferences({ mapStyle: basemap.title || 'arcgis-topographic' });
              }
            }
          });
        }

        resolve(renderer);
      });

      view.on('layerview-create-error', (e: unknown) => {
        console.error('ArcGIS layer error:', e);
      });

      // ── Click handling ──────────────────────────────────────────────────

      view.on('click', async (event) => {
        const response = await view.hitTest(event, {
          include: [trackLayer, trackOutlineLayer, trackGradientLayer, taskPointsLayer],
        });

        if (response.results.length === 0) return;

        for (const result of response.results) {
          if (!('graphic' in result)) continue;
          const graphic = result.graphic;

          // Turnpoint click
          if (graphic.layer === taskPointsLayer && turnpointClickCallback && currentTask && isTaskVisible) {
            const tpIndex = graphic.getAttribute('turnpointIndex') as number | null;
            if (tpIndex !== undefined && tpIndex !== null) {
              turnpointClickCallback(tpIndex);
              return;
            }
          }

          // Track click
          if ((graphic.layer === trackLayer || graphic.layer === trackOutlineLayer || graphic.layer === trackGradientLayer)
            && trackClickCallback && currentFixes.length > 0 && isTrackVisible) {
            const mapPoint = result.mapPoint;
            if (mapPoint) {
              const fixIndex = findNearestFixIndex(currentFixes, mapPoint.latitude ?? 0, mapPoint.longitude ?? 0);
              if (fixIndex >= 0) {
                trackClickCallback(fixIndex);
                return;
              }
            }
          }
        }
      });

      // Cursor changes on hover
      view.on('pointer-move', async (event) => {
        const response = await view.hitTest(event, {
          include: [trackLayer, trackOutlineLayer, trackGradientLayer, taskPointsLayer],
        });
        viewDiv.style.cursor = response.results.length > 0 ? 'pointer' : '';
      });

      // ── Bounds change & location persistence ────────────────────────────

      view.watch('extent', () => {
        if (boundsChangeCallback) boundsChangeCallback();

        if (saveLocationTimer) clearTimeout(saveLocationTimer);
        saveLocationTimer = setTimeout(() => {
          const camera = view.camera;
          if (camera) {
            config.setMapLocation({
              center: [camera.position.longitude ?? 0, camera.position.latitude ?? 0],
              zoom: view.zoom ?? 2,
              pitch: camera.tilt,
              bearing: camera.heading,
            });
          }
        }, 5000);
      });

      // ── Glide label zoom visibility ─────────────────────────────────────

      function updateGlideLabelVisibility(): void {
        const z = view.zoom ?? 0;
        for (const graphic of activeMarkersLayer.graphics.toArray()) {
          if (graphic.getAttribute('glideLabel') !== true) continue;
          const speed = (graphic.getAttribute('speedLabel') as string) || '';
          const details = (graphic.getAttribute('detailLabel') as string) || '';

          if (z < GLIDE_LABEL_SPEED_MIN_ZOOM) {
            graphic.visible = false;
            continue;
          }

          graphic.visible = true;
          const text = z < GLIDE_LABEL_DETAILS_MIN_ZOOM
            ? speed
            : (details ? `${speed}\n${details}` : speed);

          graphic.symbol = textSymbol(text, '#3b82f6', 14, '#ffffff', 2);
        }
      }

      view.watch('zoom', updateGlideLabelVisibility);

      // ── Legend ──────────────────────────────────────────────────────────

      function showGlideLegend(show: boolean): void {
        if (show && !glideLegendElement) {
          glideLegendElement = createGlideLegend(container);
          glideLegendElement.style.display = 'none';
        }
        sharedShowGlideLegend(glideLegendElement, show);
      }

      // ── Helpers ────────────────────────────────────────────────────────

      function clearEventHighlights(): void {
        activeMarkersLayer.removeAll();
        highlightLayer.removeAll();
        showGlideLegend(false);
      }

      /** Build colored track segments for altitude gradient mode */
      function buildGradientSegments(fixes: IGCFix[]): Graphic[] {
        if (fixes.length < 2) return [];

        const stops = calculateAltitudeGradient(fixes);
        if (stops.length < 2) return [];

        // Calculate cumulative distances for progress mapping
        const distances: number[] = [0];
        let totalDistance = 0;
        for (let i = 1; i < fixes.length; i++) {
          totalDistance += haversineDistance(
            fixes[i - 1].latitude, fixes[i - 1].longitude,
            fixes[i].latitude, fixes[i].longitude,
          );
          distances.push(totalDistance);
        }
        if (totalDistance === 0) return [];

        // Sample ~100 segments
        const MAX_SEGMENTS = 100;
        const numSegments = Math.min(MAX_SEGMENTS, fixes.length - 1);
        const step = (fixes.length - 1) / numSegments;
        const graphics: Graphic[] = [];

        for (let s = 0; s < numSegments; s++) {
          const startIdx = Math.floor(s * step);
          const endIdx = Math.min(Math.floor((s + 1) * step), fixes.length - 1);
          if (startIdx >= endIdx) continue;

          const path = [];
          for (let i = startIdx; i <= endIdx; i++) {
            path.push([fixes[i].longitude, fixes[i].latitude, fixes[i].gnssAltitude]);
          }

          // Color at midpoint
          const midIdx = Math.floor((startIdx + endIdx) / 2);
          const progress = distances[midIdx] / totalDistance;

          // Find bracketing stops
          let color = stops[0][1];
          for (let i = 0; i < stops.length - 1; i++) {
            if (progress >= stops[i][0] && progress <= stops[i + 1][0]) {
              color = stops[i][1];
              break;
            }
          }

          graphics.push(new Graphic({
            geometry: new Polyline({ paths: [path], hasZ: true }),
            symbol: lineSymbol(color, 4, 0.95),
          }));
        }

        return graphics;
      }

      /** Build 3D track with altitude colors using elevation */
      function build3DTrack(fixes: IGCFix[]): Graphic[] {
        if (fixes.length < 2) return [];

        let minAlt = Infinity;
        let maxAlt = -Infinity;
        for (const fix of fixes) {
          if (fix.gnssAltitude < minAlt) minAlt = fix.gnssAltitude;
          if (fix.gnssAltitude > maxAlt) maxAlt = fix.gnssAltitude;
        }
        const altRange = maxAlt - minAlt;

        const MAX_SEGMENTS = 100;
        const numSegments = Math.min(MAX_SEGMENTS, fixes.length - 1);
        const step = (fixes.length - 1) / numSegments;
        const graphics: Graphic[] = [];

        for (let s = 0; s < numSegments; s++) {
          const startIdx = Math.floor(s * step);
          const endIdx = Math.min(Math.floor((s + 1) * step), fixes.length - 1);
          if (startIdx >= endIdx) continue;

          const path = [];
          for (let i = startIdx; i <= endIdx; i++) {
            path.push([fixes[i].longitude, fixes[i].latitude, fixes[i].gnssAltitude]);
          }

          const midIdx = Math.floor((startIdx + endIdx) / 2);
          const normalizedAlt = altRange > 0 ? (fixes[midIdx].gnssAltitude - minAlt) / altRange : 0;
          const color = getAltitudeColorNormalized(normalizedAlt);
          const [r, g, b] = parseColor(color);

          graphics.push(new Graphic({
            geometry: new Polyline({ paths: [path], hasZ: true }),
            symbol: {
              type: 'line-3d',
              symbolLayers: [{
                type: 'line',
                material: { color: [r, g, b, 1] },
                size: 4,
              }],
            } as AnySymbol,
          }));
        }

        // Drop lines for depth perception
        const dropLineInterval = Math.max(1, Math.floor(fixes.length / 50));
        for (let i = 0; i < fixes.length; i += dropLineInterval) {
          const fix = fixes[i];
          graphics.push(new Graphic({
            geometry: new Polyline({
              paths: [[[fix.longitude, fix.latitude, fix.gnssAltitude], [fix.longitude, fix.latitude, 0]]],
              hasZ: true,
            }),
            symbol: lineSymbol('#888888', 1, 0.3),
          }));
        }

        return graphics;
      }

      /** Update track rendering based on current mode */
      function updateTrackRendering(): void {
        if (is3DMode) {
          trackLayer.visible = false;
          trackOutlineLayer.visible = false;
          trackGradientLayer.visible = true;
          trackGradientLayer.removeAll();
          trackGradientLayer.addMany(build3DTrack(currentFixes));
          trackGradientLayer.elevationInfo = { mode: 'absolute-height' };
        } else if (isAltitudeColorsMode) {
          trackLayer.visible = false;
          trackOutlineLayer.visible = true;
          trackGradientLayer.visible = true;
          trackGradientLayer.removeAll();
          trackGradientLayer.addMany(buildGradientSegments(currentFixes));
          trackGradientLayer.elevationInfo = { mode: 'on-the-ground' };
        } else {
          trackLayer.visible = true;
          trackOutlineLayer.visible = true;
          trackGradientLayer.visible = false;
        }
      }

      // ── Renderer (MapProvider implementation) ──────────────────────────

      const renderer: MapProvider = {
        supports3D: true,
        supportsAltitudeColors: true,

        set3DMode(enabled: boolean) {
          is3DMode = enabled;
          clearEventHighlights();
          updateTrackRendering();

          // Tilt camera for 3D view
          if (enabled) {
            view.goTo({ tilt: 65 }, { duration: 1000 });
          } else {
            view.goTo({ tilt: 0 }, { duration: 1000 });
          }
        },

        setAltitudeColors(enabled: boolean) {
          isAltitudeColorsMode = enabled;
          clearEventHighlights();
          updateTrackRendering();
        },

        setTaskVisibility(visible: boolean) {
          isTaskVisible = visible;
          taskLineLayer.visible = visible;
          taskCylindersLayer.visible = visible;
          taskPointsLayer.visible = visible;
          taskLabelsLayer.visible = visible;
        },

        setTrackVisibility(visible: boolean) {
          isTrackVisible = visible;
          trackLayer.visible = visible && !isAltitudeColorsMode && !is3DMode;
          trackOutlineLayer.visible = visible && !is3DMode;
          trackGradientLayer.visible = visible && (isAltitudeColorsMode || is3DMode);
          eventMarkersLayer.visible = visible;

          if (!visible) {
            clearEventHighlights();
          }
        },

        setTrack(fixes: IGCFix[]) {
          clearEventHighlights();
          currentFixes = fixes;

          trackLayer.removeAll();
          trackOutlineLayer.removeAll();
          trackGradientLayer.removeAll();

          if (fixes.length === 0) return;

          const path = fixes.map(f => [f.longitude, f.latitude, f.gnssAltitude]);

          // Outline
          trackOutlineLayer.add(new Graphic({
            geometry: new Polyline({ paths: [path], hasZ: true }),
            symbol: lineSymbol(TRACK_OUTLINE_COLOR, 8, 0.6),
          }));

          // Solid track
          trackLayer.add(new Graphic({
            geometry: new Polyline({ paths: [path], hasZ: true }),
            symbol: lineSymbol(TRACK_COLOR, 4, 0.95),
          }));

          // Fit to track bounds
          const bounds = getBoundingBox(fixes);
          view.goTo({
            target: new Polyline({
              paths: [[[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]]],
            }),
          }, { duration: 1000 });

          // Update rendering if in a special mode
          if (isAltitudeColorsMode || is3DMode) {
            updateTrackRendering();
          }
        },

        clearTrack() {
          clearEventHighlights();
          currentFixes = [];
          trackLayer.removeAll();
          trackOutlineLayer.removeAll();
          trackGradientLayer.removeAll();
        },

        async setTask(task: XCTask) {
          currentTask = task;

          taskLineLayer.removeAll();
          taskCylindersLayer.removeAll();
          taskPointsLayer.removeAll();
          taskLabelsLayer.removeAll();

          if (!task || task.turnpoints.length === 0) return;

          // Optimized task line
          const optimizedPath = calculateOptimizedTaskLine(task);
          const linePath = optimizedPath.map(p => [p.lon, p.lat]);

          taskLineLayer.add(new Graphic({
            geometry: new Polyline({ paths: [linePath] }),
            symbol: lineSymbol(TASK_COLOR, 2, 0.8, 'short-dash'),
          }));

          // Direction arrows along task line
          for (let i = 0; i < optimizedPath.length - 1; i++) {
            const p1 = optimizedPath[i];
            const p2 = optimizedPath[i + 1];
            const legDist = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
            const arrowInterval = 5000;
            const numArrows = Math.floor(legDist / arrowInterval);

            for (let a = 1; a <= numArrows; a++) {
              const frac = a / (numArrows + 1);
              const lat = p1.lat + (p2.lat - p1.lat) * frac;
              const lon = p1.lon + (p2.lon - p1.lon) * frac;
              const bearing = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);

              taskLineLayer.add(new Graphic({
                geometry: new Point({ longitude: lon, latitude: lat }),
                symbol: {
                  type: 'simple-marker',
                  style: 'triangle',
                  color: TASK_COLOR,
                  size: 8,
                  angle: -bearing,
                  outline: { color: [255, 255, 255, 0.6], width: 0.5 },
                } as AnySymbol,
              }));
            }
          }

          // Segment distance labels
          const segmentDistances = getOptimizedSegmentDistances(task);
          for (let i = 0; i < optimizedPath.length - 1; i++) {
            const p1 = optimizedPath[i];
            const p2 = optimizedPath[i + 1];
            const midLat = (p1.lat + p2.lat) / 2;
            const midLon = (p1.lon + p2.lon) / 2;

            const distStr = formatDistance(segmentDistances[i], { decimals: 1 }).withUnit;
            const legNumber = i + 1;
            const label = `Leg ${legNumber} (${distStr})`;

            taskLabelsLayer.add(new Graphic({
              geometry: new Point({ longitude: midLon, latitude: midLat }),
              symbol: textSymbol(label, TASK_COLOR, 13, '#eeeeee', 2),
            }));
          }

          // Turnpoints: cylinders + dots + labels
          for (let idx = 0; idx < task.turnpoints.length; idx++) {
            const tp = task.turnpoints[idx];
            const color = getTurnpointColor(tp.type || '');

            // Cylinder (native geodesic Circle)
            const circle = new Circle({
              center: new Point({ longitude: tp.waypoint.lon, latitude: tp.waypoint.lat }),
              radius: tp.radius,
              radiusUnit: 'meters',
              geodesic: true,
              numberOfPoints: 64,
            });

            taskCylindersLayer.add(new Graphic({
              geometry: circle,
              symbol: fillSymbol(color, 0.15, color, 2, 0.8),
            }));

            // Center dot
            taskPointsLayer.add(new Graphic({
              geometry: new Point({ longitude: tp.waypoint.lon, latitude: tp.waypoint.lat }),
              symbol: markerSymbol(color, 10),
              attributes: { turnpointIndex: idx },
            }));

            // Label
            const name = tp.waypoint.name || `TP${idx + 1}`;
            const radiusStr = formatRadius(tp.radius).withUnit;
            const altitude = tp.waypoint.altSmoothed ? `A\u00A0${formatAltitude(tp.waypoint.altSmoothed).withUnit}` : '';
            const role = tp.type || '';
            const labelParts = [name, `R\u00A0${radiusStr}`];
            if (altitude) labelParts.push(altitude);
            if (role) labelParts.push(role);

            taskLabelsLayer.add(new Graphic({
              geometry: new Point({ longitude: tp.waypoint.lon, latitude: tp.waypoint.lat }),
              symbol: textSymbol(labelParts.join(', '), '#1e293b', 13, '#ffffff', 2, -20),
            }));
          }

          // If no track loaded, fit to task
          if (currentFixes.length === 0) {
            const points = task.turnpoints.map(tp => [tp.waypoint.lon, tp.waypoint.lat]);
            view.goTo({
              target: new Polyline({ paths: [points] }),
            }, { duration: 1000 });
          }
        },

        clearTask() {
          currentTask = null;
          taskLineLayer.removeAll();
          taskCylindersLayer.removeAll();
          taskPointsLayer.removeAll();
          taskLabelsLayer.removeAll();
        },

        setEvents(events: FlightEvent[]) {
          currentEvents = events;
          eventMarkersLayer.removeAll();

          for (const event of events) {
            if (!KEY_EVENT_TYPES.has(event.type)) continue;
            const style = getEventStyle(event.type);

            eventMarkersLayer.add(new Graphic({
              geometry: new Point({ longitude: event.longitude, latitude: event.latitude }),
              symbol: markerSymbol(style.color, 14),
              attributes: { eventType: event.type, description: event.description },
            }));
          }
        },

        clearEvents() {
          currentEvents = [];
          eventMarkersLayer.removeAll();
          clearEventHighlights();
        },

        panToEvent(event: FlightEvent, options?: { skipPan?: boolean }) {
          clearEventHighlights();

          const isGlideEvent = event.type === 'glide_start' || event.type === 'glide_end';
          showGlideLegend(isGlideEvent);

          // Highlight segment
          if (event.segment && currentFixes.length > 0) {
            const { startIndex, endIndex } = event.segment;
            const segmentFixes = currentFixes.slice(startIndex, endIndex + 1);

            if (segmentFixes.length > 1) {
              const segPath = segmentFixes.map(f => [f.longitude, f.latitude, f.gnssAltitude]);
              highlightLayer.add(new Graphic({
                geometry: new Polyline({ paths: [segPath], hasZ: true }),
                symbol: lineSymbol(HIGHLIGHT_COLOR, 6, 0.9),
              }));

              // Glide chevrons and speed labels
              if (isGlideEvent) {
                const glideMarkers = calculateGlideMarkers(segmentFixes);

                for (const marker of glideMarkers) {
                  if (marker.type === 'speed-label') {
                    const speed = formatSpeed(marker.speedMps || 0).withUnit;
                    const glideRatio = marker.glideRatio !== undefined
                      ? `${marker.glideRatio.toFixed(0)}:1`
                      : '\u221E:1';
                    const altDiff = marker.altitudeDiff !== undefined
                      ? formatAltitudeChange(marker.altitudeDiff).withUnit
                      : '';
                    const detailText = `${glideRatio} ${altDiff}`.trim();

                    activeMarkersLayer.add(new Graphic({
                      geometry: new Point({ longitude: marker.lon, latitude: marker.lat }),
                      symbol: textSymbol(`${speed}\n${detailText}`, '#3b82f6', 14, '#ffffff', 2),
                      attributes: {
                        glideLabel: true,
                        speedLabel: speed,
                        detailLabel: detailText,
                      },
                    }));
                  } else {
                    // Chevron as a rotated triangle marker
                    activeMarkersLayer.add(new Graphic({
                      geometry: new Point({ longitude: marker.lon, latitude: marker.lat }),
                      symbol: {
                        type: 'simple-marker',
                        style: 'triangle',
                        color: [59, 130, 246, 1],
                        size: 10,
                        angle: -(marker.bearing || 0),
                        outline: { color: [255, 255, 255, 0.8], width: 1 },
                      } as AnySymbol,
                    }));
                  }
                }

                updateGlideLabelVisibility();
              }
            }
          }

          // Endpoint markers
          const style = getEventStyle(event.type);

          if (event.segment && currentFixes.length > 0) {
            const startFix = currentFixes[event.segment.startIndex];
            const endFix = currentFixes[event.segment.endIndex];

            // Start marker (ring)
            activeMarkersLayer.add(new Graphic({
              geometry: new Point({ longitude: startFix.longitude, latitude: startFix.latitude }),
              symbol: {
                type: 'simple-marker',
                style: 'circle',
                color: [0, 0, 0, 0],
                size: 14,
                outline: { color: parseColor(style.color), width: 3 },
              } as AnySymbol,
            }));

            // End marker (filled)
            activeMarkersLayer.add(new Graphic({
              geometry: new Point({ longitude: endFix.longitude, latitude: endFix.latitude }),
              symbol: markerSymbol(style.color, 14, '#ffffff', 3),
            }));
          } else {
            // Single point event
            activeMarkersLayer.add(new Graphic({
              geometry: new Point({ longitude: event.longitude, latitude: event.latitude }),
              symbol: markerSymbol(style.color, 14, '#ffffff', 3),
            }));
          }

          // Pan to event
          if (!options?.skipPan) {
            view.goTo({
              target: new Point({ longitude: event.longitude, latitude: event.latitude }),
              zoom: view.zoom ?? undefined,
            }, { duration: 1000 });
          }
        },

        getBounds() {
          const extent = view.extent;
          if (!extent) {
            return { north: 90, south: -90, east: 180, west: -180 };
          }
          return {
            north: extent.ymax,
            south: extent.ymin,
            east: extent.xmax,
            west: extent.xmin,
          };
        },

        onBoundsChange(callback: () => void) {
          boundsChangeCallback = callback;
        },

        destroy() {
          eventMarkersLayer.removeAll();
          activeMarkersLayer.removeAll();
          view.destroy();
        },

        invalidateSize() {
          // SceneView auto-resizes via ResizeObserver
        },

        onTrackClick(callback: (fixIndex: number) => void) {
          trackClickCallback = callback;
        },

        onTurnpointClick(callback: (turnpointIndex: number) => void) {
          turnpointClickCallback = callback;
        },

        panToTurnpoint(turnpointIndex: number) {
          if (!currentTask || turnpointIndex < 0 || turnpointIndex >= currentTask.turnpoints.length) return;
          const tp = currentTask.turnpoints[turnpointIndex];
          view.goTo({
            target: new Point({ longitude: tp.waypoint.lon, latitude: tp.waypoint.lat }),
            zoom: view.zoom ?? undefined,
          }, { duration: 1000 });
        },
      };

    } catch (err) {
      reject(err);
    }
  });
}
