/**
 * Leaflet Provider
 *
 * Leaflet 2.0 implementation of the MapProvider interface.
 * Handles rendering of flight tracks, task turnpoints, and events.
 * 2D only (no 3D support).
 */

import {
  LeafletMap, TileLayer, Polyline, Polygon, CircleMarker, Marker,
  DivIcon, LayerGroup, Control, LatLngBounds,
  type LatLngExpression, type LeafletMouseEvent,
} from 'leaflet';
import {
  getBoundingBox, getEventStyle, calculateGlideMarkers, calculateGlidePositions, getSegmentLengthMeters,
  calculateOptimizedTaskLine, getOptimizedSegmentDistances, getUnitLabel,
  calculateBearing, haversineDistance, destinationPoint, calculateBearingRadians,
  type IGCFix, type XCTask, type FlightEvent, type GlideContext, type TurnpointSequenceResult,
} from '@taskscore/engine';
import type { MapProvider } from './map-provider';
import { config } from './config';
import {
  MAP_FONT_FAMILY, GLIDE_LABEL_TEXT_SHADOW, GLIDE_LABEL_SPARSE_MIN_ZOOM, GLIDE_LABEL_SPEED_MIN_ZOOM,
  TRACK_OUTLINE_COLOR, HIGHLIGHT_COLOR, TASK_COLOR,
  getTurnpointColor, KEY_EVENT_TYPES, getAltitudeColorNormalized,
  findNearestFixIndex, createGlideLegend, showGlideLegend,
  createCirclePolygonLatLng,
  createTrackPointHUD, updateTrackPointHUD, hideTrackPointHUD as sharedHideTrackPointHUD,
  CROSSHAIR_MAP_SVG,
  buildTrackPointHUDData, buildNextTurnpointContext, ensureTurnpointCache,
  formatGlideLabel, formatTurnpointLabel, computeSegmentLabels, updateGlideLabelElement, updateGlideChevronElement,
  calculateAltitudeRange, buildTrackSegments,
} from './map-provider-shared';

// Tile layer definitions
const TILE_LAYERS = {
  outdoors: {
    name: 'Outdoors',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: {
      attribution: 'Map data &copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors, <a href="https://opentopomap.org">OpenTopoMap</a>',
      maxZoom: 17,
    },
  },
  streets: {
    name: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
      maxZoom: 19,
    },
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 19,
    },
  },
};

/**
 * Factory for creating simple Leaflet control buttons with a consistent look.
 * Returns a Control that renders as a single button inside a leaflet-bar div.
 */
function createLeafletControlButton(opts: {
  position: 'topleft' | 'topright' | 'bottomleft' | 'bottomright';
  title: string;
  ariaLabel?: string;
  innerHTML: string;
  onClick: (e: MouseEvent) => void;
}): Control {
  const ctrl = new Control({ position: opts.position });
  ctrl.onAdd = () => {
    const div = document.createElement('div');
    div.className = 'leaflet-bar';
    const btn = document.createElement('a');
    btn.href = '#';
    btn.title = opts.title;
    btn.setAttribute('role', 'button');
    btn.setAttribute('aria-label', opts.ariaLabel ?? opts.title);
    btn.innerHTML = opts.innerHTML;
    btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:30px;height:30px;';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      opts.onClick(e);
    });
    div.appendChild(btn);
    return div;
  };
  return ctrl;
}

/**
 * Create a Leaflet map provider
 */
export function createLeafletProvider(container: HTMLElement): Promise<MapProvider> {
  return new Promise((resolve, reject) => {
    try {
      // Saved map location
      const savedLocation = config.getMapLocation();
      const center: LatLngExpression = savedLocation
        ? [savedLocation.center[1], savedLocation.center[0]]
        : [0, 0];
      const zoom = savedLocation?.zoom ?? 2;

      // Create map (using default SVG renderer — Canvas renderer in Leaflet 2.0-alpha.1
      // has a bug causing vectors to render offset/disappear after map moves.
      // Fixed on main, should ship in alpha.2. Re-test preferCanvas: true after upgrading.
      // See: https://github.com/Leaflet/Leaflet/issues/10061)
      const map = new LeafletMap(container, {
        center,
        zoom,
        zoomControl: false,
      });

    // Tile layers
    const tileLayerEntries = {
      outdoors: new TileLayer(TILE_LAYERS.outdoors.url, TILE_LAYERS.outdoors.options),
      streets: new TileLayer(TILE_LAYERS.streets.url, TILE_LAYERS.streets.options),
      satellite: new TileLayer(TILE_LAYERS.satellite.url, TILE_LAYERS.satellite.options),
    };

    // Restore saved tile layer or default to outdoors
    const savedStyle = config.getPreferences().mapStyle;
    const initialKey = savedStyle && savedStyle in tileLayerEntries
      ? savedStyle as keyof typeof tileLayerEntries
      : 'outdoors';
    tileLayerEntries[initialKey].addTo(map);

    // Panel toggle control (top-right, added first so it's topmost)
    let panelToggleCallback: (() => void) | null = null;
    createLeafletControlButton({
      position: 'topright',
      title: 'Toggle panel',
      innerHTML: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>',
      onClick: () => panelToggleCallback?.(),
    }).addTo(map);

    // Menu button control (top-left, added first so it's topmost)
    let menuButtonCallback: (() => void) | null = null;
    createLeafletControlButton({
      position: 'topleft',
      title: 'Menu (\u2318K)',
      innerHTML: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>',
      onClick: () => menuButtonCallback?.(),
    }).addTo(map);

    // Zoom control (top-left, below menu button)
    // Control.Zoom exists at runtime but isn't typed in Leaflet 2.0-alpha.1
    new (Control as unknown as { Zoom: new () => Control }).Zoom().addTo(map);

    // Layer control
    const baseLayers: Record<string, TileLayer> = {
      [TILE_LAYERS.outdoors.name]: tileLayerEntries.outdoors,
      [TILE_LAYERS.streets.name]: tileLayerEntries.streets,
      [TILE_LAYERS.satellite.name]: tileLayerEntries.satellite,
    };
    new Control.Layers(baseLayers, null, { position: 'topleft' }).addTo(map);

    // Save tile layer preference on change
    const nameToKey: Record<string, string> = {
      [TILE_LAYERS.outdoors.name]: 'outdoors',
      [TILE_LAYERS.streets.name]: 'streets',
      [TILE_LAYERS.satellite.name]: 'satellite',
    };
    map.on('baselayerchange', (e: { name: string }) => {
      const key = nameToKey[e.name];
      if (key) config.setPreferences({ mapStyle: key });
    });

    // Fullscreen control
    createLeafletControlButton({
      position: 'topleft',
      title: 'Toggle fullscreen',
      innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>',
      onClick: () => {
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          container.requestFullscreen();
        }
      },
    }).addTo(map);

    // Scale control
    new Control.Scale({ maxWidth: 200 }).addTo(map);

    // ── State ──────────────────────────────────────────────────────────────

    let boundsChangeCallback: (() => void) | null = null;
    let currentFixes: IGCFix[] = [];
    let currentTask: XCTask | null = null;
    let currentEvents: FlightEvent[] = [];

    // Layer groups
    const trackGroup = new LayerGroup();        // altitude-gradient track
    const taskGroup = new LayerGroup();
    const eventMarkersGroup = new LayerGroup();
    const highlightGroup = new LayerGroup();
    const speedOverlayGroup = new LayerGroup();  // speed overlay (separate from highlight)

    // Add default groups to map
    trackGroup.addTo(map);
    taskGroup.addTo(map);
    eventMarkersGroup.addTo(map);
    highlightGroup.addTo(map);
    speedOverlayGroup.addTo(map);

    // Feature state
    let isTaskVisible = true;
    let isTrackVisible = true;
    let isSpeedOverlayActive = false;
    let glideLegendElement: HTMLElement | null = null;
    let hudElement: HTMLElement | null = null;

    // Cached turnpoint sequence and optimized path (invalidated on track/task change)
    let cachedSequenceResult: TurnpointSequenceResult | null = null;
    let cachedOptimizedPath: { lat: number; lon: number }[] | null = null;

    // Callbacks
    let trackClickCallback: ((fixIndex: number) => void) | null = null;
    let turnpointClickCallback: ((turnpointIndex: number) => void) | null = null;

    // Turnpoint data for click handling
    let turnpointMarkers: { marker: CircleMarker; index: number }[] = [];

    // ── Map state persistence ──────────────────────────────────────────────

    let saveLocationTimer: ReturnType<typeof setTimeout> | null = null;
    map.on('moveend', () => {
      if (boundsChangeCallback) boundsChangeCallback();
      if (saveLocationTimer) clearTimeout(saveLocationTimer);
      saveLocationTimer = setTimeout(() => {
        const c = map.getCenter();
        config.setMapLocation({
          center: [c.lng, c.lat],
          zoom: map.getZoom(),
          pitch: 0,
          bearing: 0,
        });
      }, 5000);
    });

    // ── Glide label zoom handling ──────────────────────────────────────────

    function updateGlideLabelVisibility(): void {
      const z = map.getZoom();

      function processMarker(el: HTMLElement | undefined): void {
        if (!el) return;
        // Leaflet DivIcon wraps our HTML in a container div,
        // so check both the wrapper and its first child for data attributes.
        const target = el.dataset.glideLabel ? el
          : (el.firstElementChild as HTMLElement | null)?.dataset.glideLabel ? el.firstElementChild as HTMLElement
          : null;
        if (target) {
          const labelIndex = parseInt(target.dataset.labelIndex || '0', 10);
          updateGlideLabelElement(target, z, labelIndex);
          return;
        }
        const chevronDataEl = el.dataset.glideChevron ? el
          : (el.firstElementChild as HTMLElement | null)?.dataset.glideChevron ? el.firstElementChild as HTMLElement
          : null;
        if (chevronDataEl) {
          const chevronIndex = parseInt(chevronDataEl.dataset.chevronIndex || '0', 10);
          updateGlideChevronElement(el, z, chevronIndex);
        }
      }

      highlightGroup.eachLayer((layer) => {
        if (layer instanceof Marker) processMarker(layer.getElement());
      });
      speedOverlayGroup.eachLayer((layer) => {
        if (layer instanceof Marker) processMarker(layer.getElement());
      });
    }

    map.on('zoomend', updateGlideLabelVisibility);

    // ── Helpers ────────────────────────────────────────────────────────────

    /**
     * Get the GlideContext for a glide starting at glideStartTime.
     * Leaflet has no terrain, so altitude always comes from turnpoint altSmoothed.
     */
    function getNextTurnpointContext(glideStartTime: number): GlideContext | undefined {
      if (!currentTask || currentFixes.length === 0) return undefined;

      const cache = ensureTurnpointCache(currentTask, currentFixes, {
        sequenceResult: cachedSequenceResult,
        optimizedPath: cachedOptimizedPath,
      });
      cachedSequenceResult = cache.sequenceResult;
      cachedOptimizedPath = cache.optimizedPath;

      return buildNextTurnpointContext(
        currentTask, currentFixes, cache.sequenceResult, cache.optimizedPath,
        glideStartTime, (_lat, _lon, alt) => alt ?? null,
      );
    }

    /** Remove all speed overlay markers (does not change isSpeedOverlayActive) */
    function clearSpeedOverlay(): void {
      speedOverlayGroup.clearLayers();
    }

    /** Render speed overlay for all glide segments */
    function renderSpeedOverlay(): void {
      clearSpeedOverlay();
      if (currentFixes.length < 2) return;
      const segLen = getSegmentLengthMeters(config.getUnits().distance);

      // Treat the entire track as one continuous segment
      const markers = calculateGlideMarkers(currentFixes, getNextTurnpointContext, segLen);
      const positions = calculateGlidePositions(currentFixes, segLen / 2);

      // Find the fastest speed-label
      let fastestIdx = -1;
      let maxSpeed = -1;
      for (let i = 0; i < markers.length; i++) {
        if (markers[i].type === 'speed-label' && (markers[i].speedMps ?? 0) > maxSpeed) {
          maxSpeed = markers[i].speedMps ?? 0;
          fastestIdx = i;
        }
      }

      // Draw red polyline for the fastest segment
      if (fastestIdx >= 0 && positions.length > 0) {
        const startTime = fastestIdx > 0 ? positions[fastestIdx - 1].time : currentFixes[0].time.getTime();
        const endTime = fastestIdx + 1 < positions.length ? positions[fastestIdx + 1].time : currentFixes[currentFixes.length - 1].time.getTime();

        let startFixIdx = 0;
        for (let i = 0; i < currentFixes.length; i++) {
          if (currentFixes[i].time.getTime() >= startTime) { startFixIdx = i; break; }
        }
        let endFixIdx = currentFixes.length - 1;
        for (let i = 0; i < currentFixes.length; i++) {
          if (currentFixes[i].time.getTime() >= endTime) { endFixIdx = i; break; }
        }

        const segFixes = currentFixes.slice(startFixIdx, endFixIdx + 1);
        if (segFixes.length > 1) {
          const segLatLngs: LatLngExpression[] = segFixes.map(f => [f.latitude, f.longitude]);
          speedOverlayGroup.addLayer(new Polyline(segLatLngs, {
            color: '#ef4444',
            weight: 6,
            opacity: 0.9,
            interactive: false,
          }));
        }
      }

      const FASTEST_COLOR = '#ef4444';
      const NORMAL_COLOR = '#3b82f6';

      const distUnitLabel = getUnitLabel('distance', config.getUnits());
      let chevronCount = 0;
      let labelIndex = 0;

      for (let i = 0; i < markers.length; i++) {
        const gm = markers[i];
        const isFastest = i === fastestIdx ||
          (i === fastestIdx - 1 && gm.type === 'chevron') ||
          (i === fastestIdx + 1 && gm.type === 'chevron');
        const color = isFastest ? FASTEST_COLOR : NORMAL_COLOR;

        if (gm.type === 'speed-label') {
          const { speed, detailText, reqText } = formatGlideLabel(gm);
          const speedDisplay = isFastest ? `${speed} (fastest)` : speed;

          const labelEl = document.createElement('div');
          labelEl.style.cssText = `
            font-family: ${MAP_FONT_FAMILY};
            font-size: 20px; font-weight: 600; color: ${isFastest ? FASTEST_COLOR : '#333'};
            white-space: nowrap; text-align: center; line-height: 1.3;
            text-shadow: ${GLIDE_LABEL_TEXT_SHADOW};
          `;
          labelEl.innerHTML = reqText
            ? `${speedDisplay}<br>${detailText}<br>${reqText}`
            : `${speedDisplay}<br>${detailText}`;
          labelEl.dataset.glideLabel = 'true';
          labelEl.dataset.speedLabel = speedDisplay;
          labelEl.dataset.detailLabel = detailText;
          labelEl.dataset.reqLabel = reqText;
          labelEl.dataset.labelIndex = String(labelIndex);
          if (isFastest) labelEl.dataset.fastest = 'true';
          labelIndex++;

          const icon = new DivIcon({
            html: labelEl.outerHTML,
            className: '',
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          });
          speedOverlayGroup.addLayer(
            new Marker([gm.lat, gm.lon], { icon })
          );
        } else {
          const chevronIdx = chevronCount;
          chevronCount++;
          const icon = new DivIcon({
            html: `<div data-glide-chevron="true" data-chevron-index="${chevronIdx}" style="display:flex;flex-direction:column;align-items:center;">
              <svg width="20" height="12" viewBox="0 0 20 12" style="transform:rotate(${gm.bearing}deg);">
                <path d="M2 10 L10 2 L18 10" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span style="font-size:10px;color:black;font-family:${MAP_FONT_FAMILY};white-space:nowrap;text-shadow:${GLIDE_LABEL_TEXT_SHADOW};">${chevronCount}${distUnitLabel}</span>
            </div>`,
            className: '',
            iconSize: [40, 24],
            iconAnchor: [20, 8],
          });
          speedOverlayGroup.addLayer(
            new Marker([gm.lat, gm.lon], { icon })
          );
        }
      }

      updateGlideLabelVisibility();
    }

    function clearEventHighlights(): void {
      highlightGroup.clearLayers();
      showGlideLegend(glideLegendElement, false);
      sharedHideTrackPointHUD(hudElement);
    }

    /** Make a track polyline clickable */
    function bindTrackClick(polyline: Polyline): void {
      polyline.on('click', (e: LeafletMouseEvent) => {
        if (!trackClickCallback || currentFixes.length === 0 || !isTrackVisible) return;
        const idx = findNearestFixIndex(currentFixes, e.latlng.lat, e.latlng.lng);
        if (idx >= 0) trackClickCallback(idx);
      });
    }

    // ── Renderer (MapProvider) ─────────────────────────────────────────────

    const renderer: MapProvider = {
      supports3D: false,
      supportsSpeedOverlay: true,

      setSpeedOverlay(enabled: boolean) {
        isSpeedOverlayActive = enabled;
        if (enabled) {
          renderSpeedOverlay();
          if (!glideLegendElement) {
            glideLegendElement = createGlideLegend(container);
            glideLegendElement.style.display = 'none';
          }
          showGlideLegend(glideLegendElement, true);
        } else {
          clearSpeedOverlay();
          showGlideLegend(glideLegendElement, false);
        }
      },

      setTaskVisibility(visible: boolean) {
        isTaskVisible = visible;
        if (visible) {
          if (!map.hasLayer(taskGroup)) taskGroup.addTo(map);
        } else {
          if (map.hasLayer(taskGroup)) map.removeLayer(taskGroup);
        }
      },

      setTrackVisibility(visible: boolean) {
        isTrackVisible = visible;
        if (visible) {
          if (!map.hasLayer(trackGroup)) trackGroup.addTo(map);
          if (!map.hasLayer(eventMarkersGroup)) eventMarkersGroup.addTo(map);
        } else {
          if (map.hasLayer(trackGroup)) map.removeLayer(trackGroup);
          if (map.hasLayer(eventMarkersGroup)) map.removeLayer(eventMarkersGroup);
          clearEventHighlights();
        }
      },

      setTrack(fixes: IGCFix[]) {
        clearEventHighlights();
        currentFixes = fixes;
        cachedSequenceResult = null;
        cachedOptimizedPath = null;
        trackGroup.clearLayers();

        if (fixes.length === 0) return;

        const latlngs: LatLngExpression[] = fixes.map(f => [f.latitude, f.longitude]);

        // Invisible hit area for click detection
        const hitArea = new Polyline(latlngs, {
          color: '#000000',
          weight: 16,
          opacity: 0.01,
        });
        bindTrackClick(hitArea);
        trackGroup.addLayer(hitArea);

        // Calculate altitude range for normalization
        const { minAlt, altRange } = calculateAltitudeRange(fixes);

        // Pre-compute segments with altitude data
        // Higher altitude segments render wider, creating a depth effect in top-down view
        const trackSegments = buildTrackSegments(fixes, altRange, minAlt);
        const segments = trackSegments.map(seg => {
          const latlngs: LatLngExpression[] = [];
          for (let j = seg.startIndex; j < seg.endIndex; j++) {
            latlngs.push([fixes[j].latitude, fixes[j].longitude]);
          }
          return { latlngs, normalizedAlt: seg.normalizedAlt };
        });

        // Outline segments (bottom layer) - wider at higher altitude
        for (const seg of segments) {
          trackGroup.addLayer(new Polyline(seg.latlngs, {
            color: TRACK_OUTLINE_COLOR,
            weight: 4 + seg.normalizedAlt * 8,
            opacity: 0.6,
            interactive: false,
          }));
        }

        // Altitude-colored segments (top layer) - wider at higher altitude
        for (const seg of segments) {
          trackGroup.addLayer(new Polyline(seg.latlngs, {
            color: getAltitudeColorNormalized(seg.normalizedAlt),
            weight: 2 + seg.normalizedAlt * 4,
            opacity: 0.95,
            interactive: false,
          }));
        }

        // Fit bounds
        const bbox = getBoundingBox(fixes);
        map.fitBounds(
          [[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]],
          { padding: [50, 50], animate: true, duration: 1 }
        );
      },

      clearTrack() {
        clearEventHighlights();
        clearSpeedOverlay();
        currentFixes = [];
        cachedSequenceResult = null;
        cachedOptimizedPath = null;
        trackGroup.clearLayers();
      },

      async setTask(task: XCTask) {
        currentTask = task;
        cachedSequenceResult = null;
        cachedOptimizedPath = null;
        taskGroup.clearLayers();
        turnpointMarkers = [];

        if (!task || task.turnpoints.length === 0) return;

        // Optimized task line
        const optimizedPath = calculateOptimizedTaskLine(task);
        const lineLatLngs: LatLngExpression[] = optimizedPath.map(p => [p.lat, p.lon]);

        // Dashed task line
        taskGroup.addLayer(
          new Polyline(lineLatLngs, {
            color: TASK_COLOR,
            weight: 2,
            opacity: 0.8,
            dashArray: '8, 8',
            interactive: false,
          })
        );

        // Arrow markers along each segment
        for (let i = 0; i < optimizedPath.length - 1; i++) {
          const p1 = optimizedPath[i];
          const p2 = optimizedPath[i + 1];
          const legDist = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
          const bearing = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);
          const bearingRad = calculateBearingRadians(p1.lat, p1.lon, p2.lat, p2.lon);

          // Place arrows every ~3km
          const arrowInterval = 3000;
          const numArrows = Math.floor(legDist / arrowInterval);
          for (let a = 1; a <= numArrows; a++) {
            const dist = a * arrowInterval;
            const pt = destinationPoint(p1.lat, p1.lon, dist, bearingRad);
            const arrowIcon = new DivIcon({
              html: `<svg width="16" height="16" viewBox="0 0 20 20" style="transform:rotate(${bearing - 90}deg);">
                <path d="M20 10 L2 2 L2 18 Z" fill="${TASK_COLOR}" opacity="0.8"/>
              </svg>`,
              className: '',
              iconSize: [16, 16],
              iconAnchor: [8, 8],
            });
            taskGroup.addLayer(new Marker([pt.lat, pt.lon], { icon: arrowIcon, interactive: false }));
          }
        }

        // Cylinders, turnpoint dots, and labels
        for (let idx = 0; idx < task.turnpoints.length; idx++) {
          const tp = task.turnpoints[idx];
          const color = getTurnpointColor(tp.type || '');
          const latlng: [number, number] = [tp.waypoint.lat, tp.waypoint.lon];

          // Cylinder polygon
          const circlePoly = createCirclePolygonLatLng(tp.waypoint.lat, tp.waypoint.lon, tp.radius);
          taskGroup.addLayer(
            new Polygon(circlePoly, {
              color,
              fillColor: color,
              fillOpacity: 0.15,
              weight: 2,
              opacity: 0.8,
              interactive: false,
            })
          );

          // Turnpoint dot
          const dot = new CircleMarker(latlng, {
            radius: 6,
            color: '#ffffff',
            weight: 2,
            fillColor: color,
            fillOpacity: 1,
          });

          // Label
          const label = formatTurnpointLabel(tp, idx);

          const labelIcon = new DivIcon({
            html: `<div style="
              font-family: ${MAP_FONT_FAMILY};
              font-size: 12px;
              font-weight: 600;
              color: #1e293b;
              white-space: nowrap;
              text-shadow: -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white, 1px 1px 2px white, 0 0 4px white;
              text-align: center;
            ">${label}</div>`,
            className: '',
            iconSize: [0, 0],
            iconAnchor: [0, 12],
          });
          taskGroup.addLayer(new Marker(latlng, { icon: labelIcon, interactive: false }));

          // Click handler
          const tpIndex = idx;
          dot.on('click', () => {
            if (turnpointClickCallback && isTaskVisible) {
              turnpointClickCallback(tpIndex);
            }
          });

          taskGroup.addLayer(dot);
          turnpointMarkers.push({ marker: dot, index: idx });
        }

        // Segment distance labels
        const segmentDistances = getOptimizedSegmentDistances(task);
        const segmentLabels = computeSegmentLabels(optimizedPath, segmentDistances);
        for (const sl of segmentLabels) {
          const labelIcon = new DivIcon({
            html: `<div style="
              transform: rotate(${sl.bearing}deg);
              font-family: ${MAP_FONT_FAMILY};
              font-size: 16px;
              font-weight: 600;
              color: ${TASK_COLOR};
              white-space: nowrap;
              text-shadow: -1px -1px 0 #eee, 1px -1px 0 #eee, -1px 1px 0 #eee, 1px 1px 0 #eee;
              text-align: center;
            ">${sl.text}</div>`,
            className: '',
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          });

          taskGroup.addLayer(
            new Marker([sl.midLat, sl.midLon], { icon: labelIcon, interactive: false })
          );
        }

        // Fit to task bounds if no track loaded
        if (currentFixes.length === 0) {
          const bounds = new LatLngBounds(
            [task.turnpoints[0].waypoint.lat, task.turnpoints[0].waypoint.lon],
            [task.turnpoints[0].waypoint.lat, task.turnpoints[0].waypoint.lon]
          );
          for (const tp of task.turnpoints) {
            bounds.extend([tp.waypoint.lat, tp.waypoint.lon]);
          }
          map.fitBounds(bounds, { padding: [50, 50] });
        }
      },

      clearTask() {
        currentTask = null;
        cachedSequenceResult = null;
        cachedOptimizedPath = null;
        taskGroup.clearLayers();
        turnpointMarkers = [];
      },

      setEvents(events: FlightEvent[]) {
        currentEvents = events;
        eventMarkersGroup.clearLayers();

        for (const event of events) {
          if (!KEY_EVENT_TYPES.has(event.type)) continue;

          const style = getEventStyle(event.type);
          const el = document.createElement('div');
          el.style.cssText = `
            width:20px; height:20px; border-radius:50%;
            background:${style.color}; border:2px solid white;
            box-shadow:0 2px 4px rgba(0,0,0,0.3); cursor:pointer;
          `;

          const icon = new DivIcon({
            html: el.outerHTML,
            className: '',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });

          const marker = new Marker(
            [event.latitude, event.longitude],
            { icon }
          );

          marker.bindPopup(
            `<strong>${event.description}</strong><br>${event.time.toLocaleTimeString()}`,
            { offset: [0, -10] }
          );

          eventMarkersGroup.addLayer(marker);
        }

        // Re-render speed overlay if it was active
        if (isSpeedOverlayActive) {
          renderSpeedOverlay();
        }
      },

      clearEvents() {
        currentEvents = [];
        eventMarkersGroup.clearLayers();
        clearEventHighlights();
        clearSpeedOverlay();
      },

      panToEvent(event: FlightEvent, options?: { skipPan?: boolean }) {
        clearEventHighlights();

        // Show/hide glide legend (keep visible if speed overlay is active)
        const isGlideEvent = event.type === 'glide_start' || event.type === 'glide_end';
        if (isGlideEvent || isSpeedOverlayActive) {
          if (!glideLegendElement) {
            glideLegendElement = createGlideLegend(container);
            glideLegendElement.style.display = 'none';
          }
        }
        showGlideLegend(glideLegendElement, isGlideEvent || isSpeedOverlayActive);

        // Highlight segment
        if (event.segment && currentFixes.length > 0) {
          const { startIndex, endIndex } = event.segment;
          const segmentFixes = currentFixes.slice(startIndex, endIndex + 1);

          if (segmentFixes.length > 1) {
            const segLatLngs: LatLngExpression[] = segmentFixes.map(f => [f.latitude, f.longitude]);

            highlightGroup.addLayer(
              new Polyline(segLatLngs, {
                color: HIGHLIGHT_COLOR,
                weight: 6,
                opacity: 0.9,
                interactive: false,
              })
            );

            // Glide chevrons and speed labels
            if (isGlideEvent) {
              const glideMarkers = calculateGlideMarkers(segmentFixes, getNextTurnpointContext, getSegmentLengthMeters(config.getUnits().distance));

              const highlightDistLabel = getUnitLabel('distance', config.getUnits());
              let highlightChevronCount = 0;
              let highlightLabelIndex = 0;

              for (const gm of glideMarkers) {
                if (gm.type === 'speed-label') {
                  const { speed, detailText, reqText } = formatGlideLabel(gm);

                  const labelEl = document.createElement('div');
                  labelEl.style.cssText = `
                    font-family: ${MAP_FONT_FAMILY};
                    font-size: 20px; font-weight: 600; color: #333;
                    white-space: nowrap; text-align: center; line-height: 1.3;
                    text-shadow: ${GLIDE_LABEL_TEXT_SHADOW};
                  `;
                  labelEl.innerHTML = reqText
                    ? `${speed}<br>${detailText}<br>${reqText}`
                    : `${speed}<br>${detailText}`;
                  labelEl.dataset.glideLabel = 'true';
                  labelEl.dataset.speedLabel = speed;
                  labelEl.dataset.detailLabel = detailText;
                  labelEl.dataset.reqLabel = reqText;
                  labelEl.dataset.labelIndex = String(highlightLabelIndex);
                  highlightLabelIndex++;

                  const icon = new DivIcon({
                    html: labelEl.outerHTML,
                    className: '',
                    iconSize: [0, 0],
                    iconAnchor: [0, 0],
                  });
                  highlightGroup.addLayer(
                    new Marker([gm.lat, gm.lon], { icon })
                  );
                } else {
                  const chevronIdx = highlightChevronCount;
                  highlightChevronCount++;
                  const icon = new DivIcon({
                    html: `<div data-glide-chevron="true" data-chevron-index="${chevronIdx}" style="display:flex;flex-direction:column;align-items:center;">
                      <svg width="20" height="12" viewBox="0 0 20 12" style="transform:rotate(${gm.bearing}deg);">
                        <path d="M2 10 L10 2 L18 10" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      <span style="font-size:10px;color:black;font-family:${MAP_FONT_FAMILY};white-space:nowrap;text-shadow:${GLIDE_LABEL_TEXT_SHADOW};">${highlightChevronCount}${highlightDistLabel}</span>
                    </div>`,
                    className: '',
                    iconSize: [40, 24],
                    iconAnchor: [20, 8],
                  });
                  highlightGroup.addLayer(
                    new Marker([gm.lat, gm.lon], { icon })
                  );
                }
              }

              updateGlideLabelVisibility();
            }
          }
        }

        // Endpoint markers
        const style = getEventStyle(event.type);
        const isStartEvent = event.type === 'thermal_entry' || event.type === 'glide_start';

        if (event.segment && currentFixes.length > 0) {
          const startFix = currentFixes[event.segment.startIndex];
          const endFix = currentFixes[event.segment.endIndex];

          // Start marker (ring)
          const startIcon = new DivIcon({
            html: `<div style="
              width:14px; height:14px; border-radius:50%;
              background:transparent; border:3px solid ${style.color};
              box-shadow:0 2px 6px rgba(0,0,0,0.4);
            " class="${isStartEvent ? 'throb-marker' : ''}"></div>`,
            className: '',
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          });
          highlightGroup.addLayer(
            new Marker([startFix.latitude, startFix.longitude], { icon: startIcon })
          );

          // End marker (filled)
          const endIcon = new DivIcon({
            html: `<div style="
              width:14px; height:14px; border-radius:50%;
              background:${style.color}; border:3px solid white;
              box-shadow:0 2px 6px rgba(0,0,0,0.4);
            " class="${!isStartEvent ? 'throb-marker' : ''}"></div>`,
            className: '',
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          });
          highlightGroup.addLayer(
            new Marker([endFix.latitude, endFix.longitude], { icon: endIcon })
          );
        } else {
          // Single point marker
          const markerIcon = new DivIcon({
            html: `<div style="
              width:16px; height:16px; border-radius:50%;
              background:${style.color}; border:3px solid white;
              box-shadow:0 2px 6px rgba(0,0,0,0.4);
            " class="throb-marker"></div>`,
            className: '',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          });
          highlightGroup.addLayer(
            new Marker([event.latitude, event.longitude], { icon: markerIcon })
          );
        }

        // Pan to event (no zoom change)
        if (!options?.skipPan) {
          map.panTo([event.latitude, event.longitude], { animate: true, duration: 1 });
        }
      },

      getBounds() {
        const bounds = map.getBounds();
        return {
          north: bounds.getNorth(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          west: bounds.getWest(),
        };
      },

      onBoundsChange(callback: () => void) {
        boundsChangeCallback = callback;
      },

      destroy() {
        map.remove();
      },

      invalidateSize() {
        map.invalidateSize();
      },

      onTrackClick(callback: (fixIndex: number) => void) {
        trackClickCallback = callback;
      },

      onTurnpointClick(callback: (turnpointIndex: number) => void) {
        turnpointClickCallback = callback;
      },

      panToTurnpoint(turnpointIndex: number) {
        if (!currentTask || turnpointIndex < 0 || turnpointIndex >= currentTask.turnpoints.length) {
          return;
        }
        const tp = currentTask.turnpoints[turnpointIndex];
        map.panTo([tp.waypoint.lat, tp.waypoint.lon], { animate: true, duration: 1 });
      },

      showTrackPointHUD(fixIndex: number) {
        const data = buildTrackPointHUDData(currentFixes, currentEvents, fixIndex, getNextTurnpointContext);
        if (!data) return;

        // Hide glide legend (same position as HUD)
        showGlideLegend(glideLegendElement, false);

        // Add crosshair marker on the map
        const crosshairIcon = new DivIcon({
          html: CROSSHAIR_MAP_SVG,
          className: '',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        highlightGroup.addLayer(
          new Marker([data.fix.latitude, data.fix.longitude], { icon: crosshairIcon, interactive: false })
        );

        // Show HUD
        if (!hudElement) {
          hudElement = createTrackPointHUD(container);
        }
        updateTrackPointHUD(hudElement, data);
      },

      hideTrackPointHUD() {
        sharedHideTrackPointHUD(hudElement);
      },

      onMenuButtonClick(callback: () => void) {
        menuButtonCallback = callback;
      },

      onPanelToggleClick(callback: () => void) {
        panelToggleCallback = callback;
      },
    };

    resolve(renderer);
    } catch (err) {
      reject(err);
    }
  });
}
