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
  getBoundingBox, getEventStyle, calculateGlideMarkers, getCirclePoints,
  calculateOptimizedTaskLine, getOptimizedSegmentDistances,
  calculateBearing, haversineDistance, destinationPoint, calculateBearingRadians,
  type IGCFix, type XCTask, type FlightEvent,
} from '@taskscore/analysis';
import type { MapProvider } from './map-provider';
import { formatDistance, formatRadius, formatAltitude, formatSpeed, formatAltitudeChange } from './units-browser';
import { config } from './config';
import {
  MAP_FONT_FAMILY, GLIDE_LABEL_SPEED_MIN_ZOOM, GLIDE_LABEL_DETAILS_MIN_ZOOM,
  TRACK_COLOR, TRACK_OUTLINE_COLOR, HIGHLIGHT_COLOR, TASK_COLOR,
  getTurnpointColor, KEY_EVENT_TYPES, getAltitudeColorNormalized,
  findNearestFixIndex, createGlideLegend, showGlideLegend,
  createCirclePolygonLatLng,
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

    // Scale control
    new Control.Scale({ maxWidth: 200 }).addTo(map);

    // Fullscreen control
    const fullscreenControl = new Control({ position: 'topleft' });
    fullscreenControl.onAdd = () => {
      const div = document.createElement('div');
      div.className = 'leaflet-bar';
      const btn = document.createElement('a');
      btn.href = '#';
      btn.title = 'Toggle fullscreen';
      btn.setAttribute('role', 'button');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
      btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:30px;height:30px;';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          container.requestFullscreen();
        }
      });
      div.appendChild(btn);
      return div;
    };
    fullscreenControl.addTo(map);

    // ── State ──────────────────────────────────────────────────────────────

    let boundsChangeCallback: (() => void) | null = null;
    let currentFixes: IGCFix[] = [];
    let currentTask: XCTask | null = null;
    let currentEvents: FlightEvent[] = [];

    // Layer groups
    const trackGroup = new LayerGroup();        // solid track (outline + colored line)
    const trackGradientGroup = new LayerGroup(); // altitude-gradient segments
    const taskGroup = new LayerGroup();
    const eventMarkersGroup = new LayerGroup();
    const highlightGroup = new LayerGroup();

    // Add default groups to map
    trackGroup.addTo(map);
    taskGroup.addTo(map);
    eventMarkersGroup.addTo(map);
    highlightGroup.addTo(map);

    // Feature state
    let isAltitudeColorsMode = false;
    let isTaskVisible = true;
    let isTrackVisible = true;
    let glideLegendElement: HTMLElement | null = null;

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
      highlightGroup.eachLayer((layer) => {
        if (layer instanceof Marker) {
          const el = layer.getElement();
          if (el?.dataset.glideLabel === 'true') {
            const speed = el.dataset.speedLabel || '';
            const details = el.dataset.detailLabel || '';

            if (z < GLIDE_LABEL_SPEED_MIN_ZOOM) {
              el.style.display = 'none';
              return;
            }
            el.style.display = '';
            if (z < GLIDE_LABEL_DETAILS_MIN_ZOOM) {
              el.innerHTML = speed;
            } else {
              el.innerHTML = details ? `${speed}<br>${details}` : speed;
            }
          }
        }
      });
    }

    map.on('zoomend', updateGlideLabelVisibility);

    // ── Helpers ────────────────────────────────────────────────────────────

    function clearEventHighlights(): void {
      highlightGroup.clearLayers();
      showGlideLegend(glideLegendElement, false);
    }

    /** Build multi-segment altitude-gradient polylines */
    function buildGradientTrack(fixes: IGCFix[]): void {
      trackGradientGroup.clearLayers();
      if (fixes.length < 2) return;

      let minAlt = Infinity, maxAlt = -Infinity;
      for (const fix of fixes) {
        if (fix.gnssAltitude < minAlt) minAlt = fix.gnssAltitude;
        if (fix.gnssAltitude > maxAlt) maxAlt = fix.gnssAltitude;
      }
      const altRange = maxAlt - minAlt;

      // Outline behind gradient segments (interactive for track click detection)
      const allLatLngs: LatLngExpression[] = fixes.map(f => [f.latitude, f.longitude]);
      const gradientOutline = new Polyline(allLatLngs, {
        color: TRACK_OUTLINE_COLOR,
        weight: 8,
        opacity: 0.6,
      });
      bindTrackClick(gradientOutline);
      trackGradientGroup.addLayer(gradientOutline);

      // Leaflet doesn't support gradients natively, so we approximate with colored segments.
      // This creates separate polylines which is less efficient than MapBox's line-gradient,
      // but provides reasonable performance for typical track sizes (< 20k fixes).
      const maxSegments = 500;
      const numSegments = Math.min(maxSegments, fixes.length - 1);
      const step = Math.max(1, Math.floor(fixes.length / numSegments));

      for (let i = 0; i < fixes.length - 1; i += step) {
        const end = Math.min(i + step + 1, fixes.length);
        const segment: LatLngExpression[] = [];
        for (let j = i; j < end; j++) {
          segment.push([fixes[j].latitude, fixes[j].longitude]);
        }
        const midIdx = Math.floor((i + end - 1) / 2);
        const normalizedAlt = altRange > 0
          ? (fixes[midIdx].gnssAltitude - minAlt) / altRange
          : 0;

        trackGradientGroup.addLayer(
          new Polyline(segment, {
            color: getAltitudeColorNormalized(normalizedAlt),
            weight: 4,
            opacity: 0.95,
            interactive: false,
          })
        );
      }
    }

    /** Update which track rendering is visible */
    function updateTrackRendering(): void {
      if (isAltitudeColorsMode) {
        // Show gradient, hide solid
        if (!map.hasLayer(trackGradientGroup)) trackGradientGroup.addTo(map);
        if (map.hasLayer(trackGroup)) map.removeLayer(trackGroup);
      } else {
        // Show solid, hide gradient
        if (!map.hasLayer(trackGroup)) trackGroup.addTo(map);
        if (map.hasLayer(trackGradientGroup)) map.removeLayer(trackGradientGroup);
      }
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
      supportsAltitudeColors: true,

      setAltitudeColors(enabled: boolean) {
        isAltitudeColorsMode = enabled;
        clearEventHighlights();
        updateTrackRendering();
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
          updateTrackRendering();
          if (!map.hasLayer(eventMarkersGroup)) eventMarkersGroup.addTo(map);
        } else {
          if (map.hasLayer(trackGroup)) map.removeLayer(trackGroup);
          if (map.hasLayer(trackGradientGroup)) map.removeLayer(trackGradientGroup);
          if (map.hasLayer(eventMarkersGroup)) map.removeLayer(eventMarkersGroup);
          clearEventHighlights();
        }
      },

      setTrack(fixes: IGCFix[]) {
        clearEventHighlights();
        currentFixes = fixes;
        trackGroup.clearLayers();
        trackGradientGroup.clearLayers();

        if (fixes.length === 0) return;

        const latlngs: LatLngExpression[] = fixes.map(f => [f.latitude, f.longitude]);

        // Outline (behind)
        const outline = new Polyline(latlngs, {
          color: TRACK_OUTLINE_COLOR,
          weight: 8,
          opacity: 0.6,
        });
        bindTrackClick(outline);
        trackGroup.addLayer(outline);

        // Solid orange track
        const solid = new Polyline(latlngs, {
          color: TRACK_COLOR,
          weight: 4,
          opacity: 0.95,
        });
        bindTrackClick(solid);
        trackGroup.addLayer(solid);

        // Build altitude gradient variant
        buildGradientTrack(fixes);

        // Show the right variant
        updateTrackRendering();

        // Fit bounds
        const bbox = getBoundingBox(fixes);
        map.fitBounds(
          [[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]],
          { padding: [50, 50], animate: true, duration: 1 }
        );
      },

      clearTrack() {
        clearEventHighlights();
        currentFixes = [];
        trackGroup.clearLayers();
        trackGradientGroup.clearLayers();
      },

      async setTask(task: XCTask) {
        currentTask = task;
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
          const name = tp.waypoint.name || `TP${idx + 1}`;
          const radiusStr = formatRadius(tp.radius).withUnit;
          const altitude = tp.waypoint.altSmoothed ? `A\u00A0${formatAltitude(tp.waypoint.altSmoothed).withUnit}` : '';
          const role = tp.type || '';
          const labelParts = [name, `R\u00A0${radiusStr}`];
          if (altitude) labelParts.push(altitude);
          if (role) labelParts.push(role);
          const label = labelParts.join(', ');

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
        for (let i = 0; i < optimizedPath.length - 1; i++) {
          const p1 = optimizedPath[i];
          const p2 = optimizedPath[i + 1];
          const distance = segmentDistances[i];

          const midLat = (p1.lat + p2.lat) / 2;
          const midLon = (p1.lon + p2.lon) / 2;

          let bearing = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon) - 90;
          // Normalize to -90..90 so text is never upside down
          if (bearing > 90) bearing -= 180;
          else if (bearing < -90) bearing += 180;

          const distStr = formatDistance(distance, { decimals: 1 }).withUnit;
          const legNumber = i + 1;

          const labelIcon = new DivIcon({
            html: `<div style="
              transform: rotate(${bearing}deg);
              font-family: ${MAP_FONT_FAMILY};
              font-size: 14px;
              font-weight: 600;
              color: ${TASK_COLOR};
              white-space: nowrap;
              text-shadow: -1px -1px 0 #eee, 1px -1px 0 #eee, -1px 1px 0 #eee, 1px 1px 0 #eee;
              text-align: center;
            ">Leg ${legNumber} (${distStr})</div>`,
            className: '',
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          });

          taskGroup.addLayer(
            new Marker([midLat, midLon], { icon: labelIcon, interactive: false })
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
      },

      clearEvents() {
        currentEvents = [];
        eventMarkersGroup.clearLayers();
        clearEventHighlights();
      },

      panToEvent(event: FlightEvent, options?: { skipPan?: boolean }) {
        clearEventHighlights();

        // Show/hide glide legend
        const isGlideEvent = event.type === 'glide_start' || event.type === 'glide_end';
        if (isGlideEvent) {
          if (!glideLegendElement) {
            glideLegendElement = createGlideLegend(container);
            glideLegendElement.style.display = 'none';
          }
        }
        showGlideLegend(glideLegendElement, isGlideEvent);

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
              const glideMarkers = calculateGlideMarkers(segmentFixes);

              for (const gm of glideMarkers) {
                if (gm.type === 'speed-label') {
                  const speed = formatSpeed(gm.speedMps || 0).withUnit;
                  const glideRatio = gm.glideRatio !== undefined
                    ? `${gm.glideRatio.toFixed(0)}:1`
                    : '\u221E:1';
                  const altDiff = gm.altitudeDiff !== undefined
                    ? formatAltitudeChange(gm.altitudeDiff).withUnit
                    : '';
                  const detailText = `${glideRatio} ${altDiff}`.trim();

                  const labelEl = document.createElement('div');
                  labelEl.style.cssText = `
                    font-family: ${MAP_FONT_FAMILY};
                    font-size: 16px; font-weight: 600; color: #3b82f6;
                    white-space: nowrap; text-align: center; line-height: 1.3;
                    text-shadow: -1px -1px 0 white, 1px -1px 0 white, -1px 1px 0 white, 1px 1px 0 white;
                  `;
                  labelEl.innerHTML = `${speed}<br>${detailText}`;
                  labelEl.dataset.glideLabel = 'true';
                  labelEl.dataset.speedLabel = speed;
                  labelEl.dataset.detailLabel = detailText;

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
                  // Chevron
                  const icon = new DivIcon({
                    html: `<div style="display:flex;align-items:center;justify-content:center;">
                      <svg width="20" height="12" viewBox="0 0 20 12" style="transform:rotate(${gm.bearing}deg);">
                        <path d="M2 10 L10 2 L18 10" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </div>`,
                    className: '',
                    iconSize: [20, 12],
                    iconAnchor: [10, 6],
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
    };

    resolve(renderer);
    } catch (err) {
      reject(err);
    }
  });
}
