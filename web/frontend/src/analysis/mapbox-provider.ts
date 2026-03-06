/**
 * MapBox Provider
 *
 * MapBox GL JS implementation of the MapProvider interface.
 * Handles rendering of flight tracks, task turnpoints, and events.
 * Supports 3D track rendering via Threebox.
 */

import mapboxgl from 'mapbox-gl';
import { Threebox } from 'threebox-plugin';
import { getBoundingBox, getEventStyle, calculateGlideMarkers, calculateGlidePositions, getSegmentLengthMeters, calculateOptimizedTaskLine, getOptimizedSegmentDistances, getUnitLabel, type IGCFix, type XCTask, type FlightEvent, type GlideContext, type TurnpointSequenceResult } from '@taskscore/engine';
import type { MapProvider } from './map-provider';
import { config } from './config';
import {
  MAP_FONT_FAMILY, GLIDE_LABEL_TEXT_SHADOW, GLIDE_LABEL_SPARSE_MIN_ZOOM, GLIDE_LABEL_SPEED_MIN_ZOOM,
  KEY_EVENT_TYPES, getAltitudeColorNormalized,
  findNearestFixIndex as sharedFindNearestFixIndex,
  createCirclePolygon, createGlideLegend, showGlideLegend as sharedShowGlideLegend,
  createTrackPointHUD, updateTrackPointHUD, hideTrackPointHUD as sharedHideTrackPointHUD,
  CROSSHAIR_MAP_SVG,
  buildTrackPointHUDData, buildNextTurnpointContext, ensureTurnpointCache,
  formatGlideLabel, formatTurnpointLabel, computeSegmentLabels, updateGlideLabelElement, updateGlideChevronElement,
  calculateAltitudeRange, buildTrackSegments,
} from './map-provider-shared';

// Set MapBox access token from environment variable
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

// Terrain exaggeration factor — applied to both the Mapbox terrain and
// Threebox 3D track altitudes so the track stays above the terrain surface.
const TERRAIN_EXAGGERATION = 1.5;

// MapBox style options
const MAPBOX_STYLES = [
  { id: 'outdoors', name: 'Outdoors', style: 'mapbox://styles/poklet/cmkceyuoc00ha01svg6lb767k' },
  { id: 'satellite', name: 'Satellite', style: 'mapbox://styles/mapbox/satellite-streets-v12' },
  { id: 'streets', name: 'Streets', style: 'mapbox://styles/mapbox/streets-v12' },
  { id: 'light', name: 'Light', style: 'mapbox://styles/mapbox/light-v11' },
  { id: 'dark', name: 'Dark', style: 'mapbox://styles/mapbox/dark-v11' },
];

/** Helper: set GeoJSON data on a named source, guarding against missing sources. */
function updateGeoJSONSource(
  map: mapboxgl.Map,
  sourceId: string,
  features: GeoJSON.Feature[],
): void {
  (map.getSource(sourceId) as mapboxgl.GeoJSONSource)?.setData({
    type: 'FeatureCollection',
    features,
  });
}

/**
 * Create a MapBox map provider
 */
export function createMapBoxProvider(container: HTMLElement): Promise<MapProvider> {
  return new Promise((resolve, reject) => {
    try {
      // Get saved or default style
      const savedStyleId = config.getPreferences().mapStyle;
      const savedStyle = savedStyleId ? MAPBOX_STYLES.find(s => s.id === savedStyleId) : null;
      const initialStyle = savedStyle ?? MAPBOX_STYLES[0];

      const savedLocation = config.getMapLocation();
      const map = new mapboxgl.Map({
        container,
        style: initialStyle.style,
        center: savedLocation?.center,
        zoom: savedLocation?.zoom ?? 2,
        pitch: savedLocation?.pitch ?? 45,
        bearing: savedLocation?.bearing ?? 0,
        maxPitch: 85,
        localFontFamily: MAP_FONT_FAMILY,
      });

      // State
      let boundsChangeCallback: (() => void) | null = null;
      let currentFixes: IGCFix[] = [];
      let currentTask: XCTask | null = null;
      let currentEvents: FlightEvent[] = [];
      const eventMarkers: mapboxgl.Marker[] = [];
      let activePopup: mapboxgl.Popup | null = null;
      let activeMarkers: mapboxgl.Marker[] = [];
      let glideLegendElement: HTMLElement | null = null;
      let hudElement: HTMLElement | null = null;

      // 3D rendering state
      let tb: Threebox | null = null;
      let is3DMode = false;
      let threeDObjects: unknown[] = [];

      // Task visibility state
      let isTaskVisible = true;

      // Track visibility state
      let isTrackVisible = true;

      // Speed overlay state (separate from activeMarkers so it persists across event selections)
      let isSpeedOverlayActive = false;
      let speedOverlayMarkers: mapboxgl.Marker[] = [];

      // HUD crosshair marker (separate from activeMarkers so segment markers aren't cleared)
      let hudCrosshairMarker: mapboxgl.Marker | null = null;

      function clearHudCrosshair(): void {
        if (hudCrosshairMarker) {
          hudCrosshairMarker.remove();
          hudCrosshairMarker = null;
        }
      }

      // Cached turnpoint sequence and optimized path (invalidated on track/task change)
      let cachedSequenceResult: TurnpointSequenceResult | null = null;
      let cachedOptimizedPath: { lat: number; lon: number }[] | null = null;

      // Track click callback
      let trackClickCallback: ((fixIndex: number) => void) | null = null;

      // Turnpoint click callback
      let turnpointClickCallback: ((turnpointIndex: number) => void) | null = null;

      /** Hide glide speed labels and chevrons when zoomed out to prevent overlap clutter. */
      function updateGlideLabelVisibility(): void {
        const zoom = map.getZoom();

        function processMarker(el: HTMLElement): void {
          if (el.dataset.glideLabel === 'true') {
            const labelIndex = parseInt(el.dataset.labelIndex || '0', 10);
            updateGlideLabelElement(el, zoom, labelIndex);
          } else if (el.dataset.glideChevron === 'true') {
            const chevronIndex = parseInt(el.dataset.chevronIndex || '0', 10);
            updateGlideChevronElement(el, zoom, chevronIndex);
          }
        }

        for (const marker of activeMarkers) processMarker(marker.getElement());
        for (const marker of speedOverlayMarkers) processMarker(marker.getElement());
      }

      /** Lazily create and show/hide the glide legend */
      function showGlideLegend(show: boolean): void {
        if (show && !glideLegendElement) {
          glideLegendElement = createGlideLegend(container);
          glideLegendElement.style.display = 'none';
        }
        sharedShowGlideLegend(glideLegendElement, show);
      }

      /**
       * Resolve target altitude at a point — try terrain first, fall back to turnpoint altSmoothed.
       */
      function getElevationAtPoint(lat: number, lon: number, turnpointAltSmoothed: number | undefined): number | null {
        const terrainElev = map.queryTerrainElevation([lon, lat], { exaggerated: false });
        if (terrainElev != null) return terrainElev;
        if (turnpointAltSmoothed != null) return turnpointAltSmoothed;
        return null;
      }

      /**
       * Get the GlideContext for a glide starting at glideStartTime.
       * Finds the next turnpoint after the last one reached before glideStartTime.
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
          glideStartTime, getElevationAtPoint,
        );
      }

      /** Remove all speed overlay markers from the map (does not change isSpeedOverlayActive) */
      function clearSpeedOverlay(): void {
        for (const marker of speedOverlayMarkers) {
          marker.remove();
        }
        speedOverlayMarkers = [];
        updateGeoJSONSource(map, 'speed-fastest-segment', []);
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
            const coordinates = segFixes.map(f => [f.longitude, f.latitude, f.gnssAltitude]);
            updateGeoJSONSource(map, 'speed-fastest-segment', [{
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates },
            }]);
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
              font-size: 20px;
              font-weight: 600;
              color: ${isFastest ? FASTEST_COLOR : '#333'};
              white-space: nowrap;
              text-shadow: ${GLIDE_LABEL_TEXT_SHADOW};
              text-align: center;
              line-height: 1.3;
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

            const labelMarker = new mapboxgl.Marker({ element: labelEl })
              .setLngLat([gm.lon, gm.lat])
              .addTo(map);
            if (isFastest) labelMarker.getElement().style.zIndex = '1';
            speedOverlayMarkers.push(labelMarker);
          } else {
            const chevronEl = document.createElement('div');
            chevronEl.dataset.glideChevron = 'true';
            chevronEl.dataset.chevronIndex = String(chevronCount);
            chevronCount++;
            chevronEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
            chevronEl.innerHTML = `<svg width="20" height="12" viewBox="0 0 20 12" style="transform:rotate(${gm.bearing}deg);">
              <path d="M2 10 L10 2 L18 10" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg><span style="font-size:10px;color:black;font-family:${MAP_FONT_FAMILY};white-space:nowrap;text-shadow:${GLIDE_LABEL_TEXT_SHADOW};">${chevronCount}${distUnitLabel}</span>`;

            const chevronMarker = new mapboxgl.Marker({
              element: chevronEl,
              rotationAlignment: 'map',
              pitchAlignment: 'map',
            })
              .setLngLat([gm.lon, gm.lat])
              .addTo(map);
            speedOverlayMarkers.push(chevronMarker);
          }
        }

        // Apply zoom-dependent label visibility
        updateGlideLabelVisibility();
      }

      /**
       * Clear all event-related highlights from the map
       * (segment highlight, markers, legend)
       */
      function clearEventHighlights(): void {
        // Remove popup if present
        if (activePopup) {
          activePopup.remove();
          activePopup = null;
        }

        // Remove all active markers (chevrons, speed labels, endpoint markers)
        for (const marker of activeMarkers) {
          marker.remove();
        }
        activeMarkers = [];

        clearHudCrosshair();

        // Clear highlight segment source
        updateGeoJSONSource(map, 'highlight-segment', []);

        // Hide glide legend and HUD
        showGlideLegend(false);
        sharedHideTrackPointHUD(hudElement);
      }

      /**
       * Add custom sources and layers for track/task visualization
       */
      function addCustomLayers(): void {
        // Remove existing custom layers to ensure correct ordering
        const customLayers = [
          'task-segment-labels',
          'task-labels',
          'task-points',
          'highlight-segment',
          'speed-fastest-segment',
          'track-line',
          'track-line-outline',
          'task-cylinders-stroke',
          'task-cylinders-fill',
          'task-line-arrows',
          'task-line',
        ];
        for (const layerId of customLayers) {
          if (map.getLayer(layerId)) {
            map.removeLayer(layerId);
          }
        }

        // Add sources (only if they don't exist)
        // Track source with minimal simplification for visibility at all zoom levels
        if (!map.getSource('track')) {
          map.addSource('track', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            tolerance: 0.1, // Minimal simplification
          });
        }

        // Other sources with default simplification
        const sourcesToAdd = ['task-line', 'task-points', 'task-cylinders', 'task-segment-labels', 'highlight-segment', 'speed-fastest-segment'];
        for (const sourceId of sourcesToAdd) {
          if (!map.getSource(sourceId)) {
            map.addSource(sourceId, {
              type: 'geojson',
              data: { type: 'FeatureCollection', features: [] },
            });
          }
        }

        // Add layers in order from bottom to top
        const width_mul = 0.7;

        // 1. Task line (dashed route with directional arrows)
        map.addLayer({
          id: 'task-line',
          type: 'line',
          source: 'task-line',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#6366f1',
            'line-width': 2,
            'line-dasharray': [4, 4],
            'line-opacity': 0.8,
          },
        });

        // 1b. Arrow icons along task line to show direction
        if (!map.hasImage('task-arrow')) {
          const size = 20;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d')!;
          // Draw arrow matching track line style: orange fill with black outline
          ctx.beginPath();
          ctx.moveTo(size, size / 2);     // right tip
          ctx.lineTo(1, 1);               // top-left
          ctx.lineTo(1, size - 1);        // bottom-left
          ctx.closePath();
          ctx.fillStyle = '#6366f1';
          ctx.globalAlpha = 0.8;
          ctx.fill();
          const imageData = ctx.getImageData(0, 0, size, size);
          map.addImage('task-arrow', { width: size, height: size, data: new Uint8Array(imageData.data.buffer) });
        }

        map.addLayer({
          id: 'task-line-arrows',
          type: 'symbol',
          source: 'task-line',
          layout: {
            'symbol-placement': 'line',
            'symbol-spacing': 40,
            'icon-image': 'task-arrow',
            'icon-size': 0.55,
            'icon-allow-overlap': true,
            'icon-rotation-alignment': 'map',
          },
        });

        // 2. Task cylinders fill
        map.addLayer({
          id: 'task-cylinders-fill',
          type: 'fill',
          source: 'task-cylinders',
          paint: {
            'fill-color': [
              'case',
              ['==', ['get', 'type'], 'SSS'], '#22c55e',
              ['==', ['get', 'type'], 'ESS'], '#eab308',
              ['==', ['get', 'type'], 'TAKEOFF'], '#3b82f6',
              '#a855f7',
            ],
            'fill-opacity': 0.15,
          },
        });

        // 3. Task cylinders stroke
        map.addLayer({
          id: 'task-cylinders-stroke',
          type: 'line',
          source: 'task-cylinders',
          paint: {
            'line-color': [
              'case',
              ['==', ['get', 'type'], 'SSS'], '#22c55e',
              ['==', ['get', 'type'], 'ESS'], '#eab308',
              ['==', ['get', 'type'], 'TAKEOFF'], '#3b82f6',
              '#a855f7',
            ],
            'line-width': 2,
            'line-opacity': 0.8,
          },
        });

        // 4. Track outline (shadow for visibility)
        map.addLayer({
          id: 'track-line-outline',
          type: 'line',
          source: 'track',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#000000',
            // Altitude-adaptive width: wider at high altitude for depth effect
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              3, ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, 4 * width_mul, 1, 12 * width_mul],
              8, ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, 6 * width_mul, 1, 18 * width_mul],
              12, ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, 5 * width_mul, 1, 16 * width_mul],
            ],
            'line-opacity': 0.6,
          },
        });

        // 5. Track line with altitude-based colors and width
        map.addLayer({
          id: 'track-line',
          type: 'line',
          source: 'track',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            // Altitude-based coloring: brown (low) → green → cyan → sky blue (high)
            'line-color': [
              'interpolate', ['linear'], ['get', 'normalizedAlt'],
              0, '#8B5A2B',
              0.25, '#43A047',
              0.5, '#039BE5',
              0.75, '#29B6F6',
              1, '#4FC3F7',
            ],
            'line-width': [
              'interpolate', ['linear'], ['zoom'],
              3, ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, 2 * width_mul, 1, 6 * width_mul],
              8, ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, 3 * width_mul, 1, 9 * width_mul],
              12, ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, 3 * width_mul, 1, 9 * width_mul],
            ],
            'line-opacity': 0.95,
          },
        });

        // 5b. Highlight segment (for selected events)
        map.addLayer({
          id: 'highlight-segment',
          type: 'line',
          source: 'highlight-segment',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#00ffff',
            'line-width': 6,
            'line-opacity': 0.9,
          },
        });

        // 5c. Speed fastest segment (red overlay for fastest speed segment)
        map.addLayer({
          id: 'speed-fastest-segment',
          type: 'line',
          source: 'speed-fastest-segment',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#ef4444',
            'line-width': 6,
            'line-opacity': 0.9,
          },
        });

        // 6. Task points (turnpoint circles)
        map.addLayer({
          id: 'task-points',
          type: 'circle',
          source: 'task-points',
          paint: {
            'circle-radius': 6,
            'circle-color': [
              'case',
              ['==', ['get', 'type'], 'SSS'], '#22c55e',
              ['==', ['get', 'type'], 'ESS'], '#eab308',
              ['==', ['get', 'type'], 'TAKEOFF'], '#3b82f6',
              '#a855f7',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });

        // 7. Task point labels
        map.addLayer({
          id: 'task-labels',
          type: 'symbol',
          source: 'task-points',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 20,
            'text-offset': [0, 1.5],
            'text-anchor': 'top',
          },
          paint: {
            'text-color': '#1e293b',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
          },
        });

        // 8. Task segment distance labels
        map.addLayer({
          id: 'task-segment-labels',
          type: 'symbol',
          source: 'task-segment-labels',
          layout: {
            'text-field': ['get', 'distance'],
            'text-size': 16,
            'text-rotate': ['get', 'bearing'],
            'text-rotation-alignment': 'map',
            'text-offset': [0, 0],
            'text-anchor': 'center',
          },
          paint: {
            'text-color': '#6366f1',
            'text-halo-color': '#eeeeee',
            'text-halo-width': 2,
          },
        });
      }

      /**
       * Restore data after style change
       */
      function restoreData(): void {
        if (currentFixes.length > 0) {
          renderer.setTrack(currentFixes);
        }
        if (currentTask) {
          renderer.setTask(currentTask);
        }
        if (currentEvents.length > 0) {
          renderer.setEvents(currentEvents);
        }
        updateTrackRendering();
      }

      // Custom panel toggle control (top-right, added first so it's topmost)
      let panelToggleCallback: (() => void) | null = null;
      class PanelToggleControl implements mapboxgl.IControl {
        private container: HTMLElement | null = null;
        onAdd(): HTMLElement {
          this.container = document.createElement('div');
          this.container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.title = 'Toggle panel';
          btn.setAttribute('aria-label', 'Toggle panel');
          btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:29px;height:29px;border:none;cursor:pointer;background:transparent;';
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>';
          btn.addEventListener('click', () => panelToggleCallback?.());
          this.container.appendChild(btn);
          return this.container;
        }
        onRemove(): void {
          this.container?.remove();
          this.container = null;
        }
      }
      map.addControl(new PanelToggleControl(), 'top-right');

      // Navigation controls (top-right, below panel toggle)
      map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }));
      map.addControl(new mapboxgl.FullscreenControl());
      map.addControl(new mapboxgl.ScaleControl({ maxWidth: 200 }));

      // Custom menu button control (top-left, added first so it's topmost)
      let menuButtonCallback: (() => void) | null = null;
      class MenuButtonControl implements mapboxgl.IControl {
        private container: HTMLElement | null = null;
        onAdd(): HTMLElement {
          this.container = document.createElement('div');
          this.container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.title = 'Menu (\u2318K)';
          btn.setAttribute('aria-label', 'Menu (\u2318K)');
          btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:29px;height:29px;border:none;cursor:pointer;background:transparent;';
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>';
          btn.addEventListener('click', () => menuButtonCallback?.());
          this.container.appendChild(btn);
          return this.container;
        }
        onRemove(): void {
          this.container?.remove();
          this.container = null;
        }
      }
      map.addControl(new MenuButtonControl(), 'top-left');

      // Style selector control (top-left, below menu button)
      class MapBoxStyleControl implements mapboxgl.IControl {
        private container: HTMLElement | null = null;

        onAdd(): HTMLElement {
          this.container = document.createElement('div');
          this.container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';

          const select = document.createElement('select');
          select.style.cssText = 'padding: 6px 8px; border: none; background: white; color: #1e293b; cursor: pointer; font-size: 12px;';

          for (const style of MAPBOX_STYLES) {
            const option = document.createElement('option');
            option.value = style.id;
            option.textContent = style.name;
            select.appendChild(option);
          }

          select.value = initialStyle.id;

          select.addEventListener('change', () => {
            const selectedStyle = MAPBOX_STYLES.find(s => s.id === select.value);
            if (selectedStyle) {
              map.setStyle(selectedStyle.style);
              config.setPreferences({ mapStyle: selectedStyle.id });
            }
          });

          this.container.appendChild(select);
          return this.container;
        }

        onRemove(): void {
          this.container?.remove();
          this.container = null;
        }
      }

      map.addControl(new MapBoxStyleControl(), 'top-left');

      // Handle style changes
      let isInitialLoad = true;
      map.on('style.load', () => {
        // Add 3D terrain
        if (!map.getSource('mapbox-dem')) {
          map.addSource('mapbox-dem', {
            type: 'raster-dem',
            url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
            tileSize: 512,
            maxzoom: 14,
          });
        }
        map.setTerrain({ source: 'mapbox-dem', exaggeration: TERRAIN_EXAGGERATION });

        // Add sky layer for atmosphere effect
        if (!map.getLayer('sky')) {
          map.addLayer({
            id: 'sky',
            type: 'sky',
            paint: {
              'sky-type': 'atmosphere',
              'sky-atmosphere-sun': [0.0, 90.0],
              'sky-atmosphere-sun-intensity': 15,
            },
          });
        }

        addCustomLayers();
        if (!isInitialLoad) {
          restoreData();
        }
      });

      // Keep glide labels hidden while zoomed out.
      map.on('zoom', updateGlideLabelVisibility);

      function findNearestFixIndex(clickLat: number, clickLon: number): number {
        return sharedFindNearestFixIndex(currentFixes, clickLat, clickLon);
      }

      map.on('load', () => {
        isInitialLoad = false;

        // Initialize Threebox for 3D rendering.
        // Mapbox GL JS v3 uses WebGL2; pass the matching context so Threebox
        // shares it rather than relying on Three.js fallback behaviour.
        const gl = map.getCanvas().getContext('webgl2') || map.getCanvas().getContext('webgl');
        tb = new Threebox(
          map,
          gl,
          {
            defaultLights: true,
          }
        );

        // Add custom layer for Threebox rendering
        map.addLayer({
          id: 'threebox-layer',
          type: 'custom',
          renderingMode: '3d',
          onAdd: function () {
            // Layer added
          },
          render: function () {
            if (tb) {
              tb.update();
            }
          },
        });

        // Track click and hover handlers
        const trackLayers = ['track-line', 'track-line-outline'];

        // Click handler for track
        for (const layerId of trackLayers) {
          map.on('click', layerId, (e) => {
            if (!trackClickCallback || currentFixes.length === 0) return;
            if (!isTrackVisible) return;

            const { lng, lat } = e.lngLat;
            const fixIndex = findNearestFixIndex(lat, lng);
            if (fixIndex >= 0) {
              trackClickCallback(fixIndex);
            }
          });
        }

        // Hover effects - change cursor to pointer when hovering over track
        for (const layerId of trackLayers) {
          map.on('mouseenter', layerId, () => {
            if (currentFixes.length === 0 || !isTrackVisible) return;
            map.getCanvas().style.cursor = 'pointer';
          });

          map.on('mouseleave', layerId, () => {
            map.getCanvas().style.cursor = '';
          });
        }

        // Turnpoint click handler
        map.on('click', 'task-points', (e) => {
          if (!turnpointClickCallback || !currentTask || !isTaskVisible) return;
          if (!e.features || e.features.length === 0) return;

          // Find which turnpoint was clicked based on coordinates
          const clickedCoords = e.features[0].geometry;
          if (clickedCoords.type !== 'Point') return;

          const [clickLon, clickLat] = clickedCoords.coordinates;

          // Find the matching turnpoint index
          for (let i = 0; i < currentTask.turnpoints.length; i++) {
            const tp = currentTask.turnpoints[i];
            if (Math.abs(tp.waypoint.lon - clickLon) < 0.0001 &&
                Math.abs(tp.waypoint.lat - clickLat) < 0.0001) {
              turnpointClickCallback(i);
              break;
            }
          }
        });

        // Hover effects for turnpoints
        map.on('mouseenter', 'task-points', () => {
          if (!currentTask || !isTaskVisible) return;
          map.getCanvas().style.cursor = 'pointer';
        });

        map.on('mouseleave', 'task-points', () => {
          map.getCanvas().style.cursor = '';
        });

        resolve(renderer);
      });

      map.on('error', (e) => {
        console.error('MapBox error:', e.error);
      });

      // Track bounds changes and persist map location
      let saveLocationTimer: ReturnType<typeof setTimeout> | null = null;
      map.on('moveend', () => {
        if (boundsChangeCallback) {
          boundsChangeCallback();
        }
        // Debounce saving to avoid excessive localStorage writes during animations
        if (saveLocationTimer) clearTimeout(saveLocationTimer);
        saveLocationTimer = setTimeout(() => {
          const center = map.getCenter();
          config.setMapLocation({
            center: [center.lng, center.lat],
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing(),
          });
        }, 5000);
      });

      /**
       * Clear all 3D objects from the scene
       */
      function clear3DTrack(): void {
        if (!tb) return;
        for (const obj of threeDObjects) {
          tb.remove(obj);
        }
        threeDObjects = [];
      }

      /**
       * Render the track as 3D tubes using Threebox
       */
      function render3DTrack(fixes: IGCFix[]): void {
        if (!tb || fixes.length < 2) return;

        clear3DTrack();

        // Calculate min and max altitude for color scaling
        const { minAlt, altRange } = calculateAltitudeRange(fixes);

        // Create line segments for the track
        // We'll create the track as connected line segments with altitude
        // Scale altitude by terrain exaggeration so the track stays above the
        // visually exaggerated terrain surface (otherwise it clips into terrain
        // when viewed from directly above).
        for (let i = 1; i < fixes.length; i++) {
          const prev = fixes[i - 1];
          const curr = fixes[i];

          // Normalize altitude for color
          const normalizedAlt = altRange > 0 ? (prev.gnssAltitude - minAlt) / altRange : 0;

          // Create a line segment between consecutive points
          // Threebox uses [longitude, latitude, altitude] format
          const lineSegment = tb.line({
            geometry: [
              [prev.longitude, prev.latitude, prev.gnssAltitude * TERRAIN_EXAGGERATION],
              [curr.longitude, curr.latitude, curr.gnssAltitude * TERRAIN_EXAGGERATION],
            ],
            color: getAltitudeColorNormalized(normalizedAlt),
            width: 3,
            opacity: 0.9,
          });
          // Disable depth testing so the track renders on top of terrain
          // (prevents z-fighting when viewed from directly above)
          const lsMat = (lineSegment as { material?: { depthTest: boolean } }).material;
          if (lsMat) lsMat.depthTest = false;
          tb.add(lineSegment);
          threeDObjects.push(lineSegment);
        }

        // Add vertical "drop lines" every N points for depth perception
        const dropLineInterval = Math.max(1, Math.floor(fixes.length / 50));
        for (let i = 0; i < fixes.length; i += dropLineInterval) {
          const fix = fixes[i];
          const dropLine = tb.line({
            geometry: [
              [fix.longitude, fix.latitude, fix.gnssAltitude * TERRAIN_EXAGGERATION],
              [fix.longitude, fix.latitude, 0],
            ],
            color: '#888888',
            width: 1,
            opacity: 0.3,
          });
          const dlMat = (dropLine as { material?: { depthTest: boolean } }).material;
          if (dlMat) dlMat.depthTest = false;
          tb.add(dropLine);
          threeDObjects.push(dropLine);
        }
      }

      // Altitude color functions and gradient calculation are imported from map-provider-shared


      /**
       * Update track rendering based on current mode
       */
      function updateTrackRendering(): void {
        if (is3DMode) {
          // Hide all 2D track layers
          if (map.getLayer('track-line')) {
            map.setLayoutProperty('track-line', 'visibility', 'none');
          }
          if (map.getLayer('track-line-outline')) {
            map.setLayoutProperty('track-line-outline', 'visibility', 'none');
          }
          // Show 3D track
          render3DTrack(currentFixes);
        } else {
          // Show 2D track layers
          if (map.getLayer('track-line')) {
            map.setLayoutProperty('track-line', 'visibility', 'visible');
          }
          if (map.getLayer('track-line-outline')) {
            map.setLayoutProperty('track-line-outline', 'visibility', 'visible');
          }
          // Hide 3D track
          clear3DTrack();
        }
      }

      const renderer: MapProvider = {
        supports3D: true,
        supportsSpeedOverlay: true,

        setSpeedOverlay(enabled: boolean) {
          isSpeedOverlayActive = enabled;
          if (enabled) {
            clearEventHighlights();
            renderSpeedOverlay();
            showGlideLegend(true);
          } else {
            clearSpeedOverlay();
            showGlideLegend(false);
          }
        },

        set3DMode(enabled: boolean) {
          is3DMode = enabled;
          clearEventHighlights();
          updateTrackRendering();
        },

        setTaskVisibility(visible: boolean) {
          isTaskVisible = visible;
          const visibility = visible ? 'visible' : 'none';
          const taskLayers = [
            'task-line',
            'task-line-arrows',
            'task-cylinders-fill',
            'task-cylinders-stroke',
            'task-points',
            'task-labels',
            'task-segment-labels',
          ];
          for (const layerId of taskLayers) {
            if (map.getLayer(layerId)) {
              map.setLayoutProperty(layerId, 'visibility', visibility);
            }
          }
        },

        setTrackVisibility(visible: boolean) {
          isTrackVisible = visible;

          if (visible) {
            // Restore track based on current mode
            updateTrackRendering();
          } else {
            // Hide all track layers
            const trackLayers = [
              'track-line',
              'track-line-outline',
              'highlight-segment',
            ];
            for (const layerId of trackLayers) {
              if (map.getLayer(layerId)) {
                map.setLayoutProperty(layerId, 'visibility', 'none');
              }
            }
            // Clear 3D track objects
            clear3DTrack();
          }

          // Toggle event markers visibility
          for (const marker of eventMarkers) {
            const el = marker.getElement();
            if (el) {
              el.style.display = visible ? '' : 'none';
            }
          }

          // Clear any active highlights when hiding
          if (!visible) {
            clearEventHighlights();
          }
        },
        setTrack(fixes: IGCFix[]) {
          clearEventHighlights();
          currentFixes = fixes;
          cachedSequenceResult = null;
          cachedOptimizedPath = null;

          if (fixes.length === 0) {
            updateGeoJSONSource(map, 'track', []);
            return;
          }

          // Calculate altitude range for normalization
          const { minAlt, altRange } = calculateAltitudeRange(fixes);

          // Batch consecutive fixes into multi-point segments for reliable rendering.
          // Individual 2-point segments get dropped at Mapbox vector tile boundaries,
          // causing visible breaks on long flights. ~500 segments balances visual
          // fidelity of altitude-based styling with rendering robustness.
          const segments = buildTrackSegments(fixes, altRange, minAlt);
          const features = segments.map(seg => {
            const coordinates: [number, number][] = [];
            for (let j = seg.startIndex; j < seg.endIndex; j++) {
              coordinates.push([fixes[j].longitude, fixes[j].latitude]);
            }
            return {
              type: 'Feature' as const,
              properties: { normalizedAlt: seg.normalizedAlt },
              geometry: {
                type: 'LineString' as const,
                coordinates,
              },
            };
          });

          updateGeoJSONSource(map, 'track', features);

          // Fit map to track bounds
          const bounds = getBoundingBox(fixes);
          const padding = 50;

          map.fitBounds(
            [
              [bounds.minLon, bounds.minLat],
              [bounds.maxLon, bounds.maxLat],
            ],
            { padding, duration: 1000 }
          );

          // Update rendering based on current mode
          if (is3DMode) {
            render3DTrack(fixes);
          }
        },

        clearTrack() {
          clearEventHighlights();
          clearSpeedOverlay();
          currentFixes = [];
          cachedSequenceResult = null;
          cachedOptimizedPath = null;
          updateGeoJSONSource(map, 'track', []);
          // Clear 3D track if present
          if (map.getLayer('track-3d')) {
            map.setLayoutProperty('track-3d', 'visibility', 'none');
          }
        },

        async setTask(task: XCTask) {
          currentTask = task;
          cachedSequenceResult = null;
          cachedOptimizedPath = null;

          if (!task || task.turnpoints.length === 0) {
            updateGeoJSONSource(map, 'task-line', []);
            updateGeoJSONSource(map, 'task-points', []);
            updateGeoJSONSource(map, 'task-cylinders', []);
            updateGeoJSONSource(map, 'task-segment-labels', []);
            return;
          }

          // Create optimized task line that tags cylinder edges
          const optimizedPath = calculateOptimizedTaskLine(task);
          const lineCoords = optimizedPath.map(p => [p.lon, p.lat]);

          updateGeoJSONSource(map, 'task-line', [{
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: lineCoords,
            },
          }]);

          // Create segment distance labels
          const segmentDistances = getOptimizedSegmentDistances(task);
          const segmentLabels = computeSegmentLabels(optimizedPath, segmentDistances);
          const segmentLabelFeatures = segmentLabels.map(label => ({
            type: 'Feature' as const,
            properties: {
              distance: label.text,
              bearing: label.bearing,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [label.midLon, label.midLat],
            },
          }));

          updateGeoJSONSource(map, 'task-segment-labels', segmentLabelFeatures);

          // Create turnpoint markers
          const pointFeatures = task.turnpoints.map((tp, idx) => ({
            type: 'Feature' as const,
            properties: {
              name: formatTurnpointLabel(tp, idx),
              type: tp.type || '',
              radius: tp.radius,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [tp.waypoint.lon, tp.waypoint.lat],
            },
          }));

          updateGeoJSONSource(map, 'task-points', pointFeatures);

          // Create cylinder polygons
          const cylinderFeatures = task.turnpoints.map((tp, idx) => ({
            type: 'Feature' as const,
            properties: {
              name: tp.waypoint.name || `TP${idx + 1}`,
              type: tp.type || '',
              radius: tp.radius,
            },
            geometry: createCirclePolygon(
              tp.waypoint.lon,
              tp.waypoint.lat,
              tp.radius
            ),
          }));

          updateGeoJSONSource(map, 'task-cylinders', cylinderFeatures);

          // If no track is loaded, fit to task bounds
          if (currentFixes.length === 0) {
            const bounds = new mapboxgl.LngLatBounds();
            for (const tp of task.turnpoints) {
              bounds.extend([tp.waypoint.lon, tp.waypoint.lat]);
            }
            map.fitBounds(bounds, { padding: 50, duration: 1000 });
          }
        },

        clearTask() {
          currentTask = null;
          cachedSequenceResult = null;
          cachedOptimizedPath = null;
          updateGeoJSONSource(map, 'task-line', []);
          updateGeoJSONSource(map, 'task-points', []);
          updateGeoJSONSource(map, 'task-cylinders', []);
          updateGeoJSONSource(map, 'task-segment-labels', []);
        },

        setEvents(events: FlightEvent[]) {
          currentEvents = events;

          // Remove old markers
          for (const marker of eventMarkers) {
            marker.remove();
          }
          eventMarkers.length = 0;

          // Add new markers (only for key events to avoid clutter)
          for (const event of events) {
            if (!KEY_EVENT_TYPES.has(event.type)) continue;

            const style = getEventStyle(event.type);

            const el = document.createElement('div');
            el.className = 'event-marker';
            el.style.width = '20px';
            el.style.height = '20px';
            el.style.borderRadius = '50%';
            el.style.backgroundColor = style.color;
            el.style.border = '2px solid white';
            el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';
            el.style.cursor = 'pointer';

            const marker = new mapboxgl.Marker({ element: el })
              .setLngLat([event.longitude, event.latitude])
              .setPopup(
                new mapboxgl.Popup({ offset: 25 }).setHTML(`
                  <strong>${event.description}</strong><br>
                  ${event.time.toLocaleTimeString()}
                `)
              )
              .addTo(map);

            eventMarkers.push(marker);
          }

          // Re-render speed overlay if it was active
          if (isSpeedOverlayActive) {
            renderSpeedOverlay();
          }
        },

        clearEvents() {
          currentEvents = [];
          for (const marker of eventMarkers) {
            marker.remove();
          }
          eventMarkers.length = 0;
          clearEventHighlights();
          clearSpeedOverlay();
        },

        panToEvent(event: FlightEvent, options?: { skipPan?: boolean }) {
          // Close any existing popup, markers, and HUD
          if (activePopup) {
            activePopup.remove();
            activePopup = null;
          }
          for (const marker of activeMarkers) {
            marker.remove();
          }
          activeMarkers = [];
          clearHudCrosshair();
          sharedHideTrackPointHUD(hudElement);

          // Show/hide glide legend based on event type (keep visible if speed overlay is active)
          const isGlideEvent = event.type === 'glide_start' || event.type === 'glide_end';
          showGlideLegend(isGlideEvent || isSpeedOverlayActive);

          // Highlight segment if event has one
          if (event.segment && currentFixes.length > 0) {
            const { startIndex, endIndex } = event.segment;
            const segmentFixes = currentFixes.slice(startIndex, endIndex + 1);

            if (segmentFixes.length > 1) {
              const coordinates = segmentFixes.map(fix => [fix.longitude, fix.latitude, fix.gnssAltitude]);

              updateGeoJSONSource(map, 'highlight-segment', [{
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates,
                },
              }]);

              // For glide events, add direction chevrons every ~1km with speed labels
              if (event.type === 'glide_start' || event.type === 'glide_end') {
                const glideMarkers = calculateGlideMarkers(segmentFixes, getNextTurnpointContext, getSegmentLengthMeters(config.getUnits().distance));

                const highlightDistLabel = getUnitLabel('distance', config.getUnits());
                let highlightChevronCount = 0;
                let highlightLabelIndex = 0;

                for (const marker of glideMarkers) {
                  if (marker.type === 'speed-label') {
                    const { speed, detailText, reqText } = formatGlideLabel(marker);

                    const labelEl = document.createElement('div');
                    labelEl.style.cssText = `
                      font-family: ${MAP_FONT_FAMILY};
                      font-size: 20px;
                      font-weight: 600;
                      color: #333;
                      white-space: nowrap;
                      text-shadow: ${GLIDE_LABEL_TEXT_SHADOW};
                      text-align: center;
                      line-height: 1.3;
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

                    const labelMarker = new mapboxgl.Marker({ element: labelEl })
                      .setLngLat([marker.lon, marker.lat])
                      .addTo(map);
                    activeMarkers.push(labelMarker);
                  } else {
                    const chevronEl = document.createElement('div');
                    chevronEl.dataset.glideChevron = 'true';
                    chevronEl.dataset.chevronIndex = String(highlightChevronCount);
                    highlightChevronCount++;
                    chevronEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;';
                    chevronEl.innerHTML = `<svg width="20" height="12" viewBox="0 0 20 12" style="transform:rotate(${marker.bearing}deg);">
                      <path d="M2 10 L10 2 L18 10" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg><span style="font-size:10px;color:black;font-family:${MAP_FONT_FAMILY};white-space:nowrap;text-shadow:${GLIDE_LABEL_TEXT_SHADOW};">${highlightChevronCount}${highlightDistLabel}</span>`;

                    const chevronMarker = new mapboxgl.Marker({
                      element: chevronEl,
                      rotationAlignment: 'map',
                      pitchAlignment: 'map',
                    })
                      .setLngLat([marker.lon, marker.lat])
                      .addTo(map);
                    activeMarkers.push(chevronMarker);
                  }
                }

                updateGlideLabelVisibility();
              }
            }
          } else {
            updateGeoJSONSource(map, 'highlight-segment', []);
          }

          const style = getEventStyle(event.type);

          // Inject throbbing animation keyframes if not already present
          if (!document.getElementById('throb-animation-style')) {
            const styleSheet = document.createElement('style');
            styleSheet.id = 'throb-animation-style';
            styleSheet.textContent = `
              @keyframes throb {
                0%, 100% { box-shadow: 0 0 0 0 currentColor; }
                50% { box-shadow: 0 0 0 20px transparent; }
              }
              .throb-marker {
                animation: throb 0.5s ease-in-out 4;
              }
            `;
            document.head.appendChild(styleSheet);
          }

          // Determine which marker should throb based on event type
          const isStartEvent = event.type === 'thermal_entry' || event.type === 'glide_start';

          // Create markers at segment endpoints or event point
          if (event.segment && currentFixes.length > 0) {
            const startFix = currentFixes[event.segment.startIndex];
            const endFix = currentFixes[event.segment.endIndex];

            // Start marker (ring/outline style)
            const startEl = document.createElement('div');
            startEl.style.width = '14px';
            startEl.style.height = '14px';
            startEl.style.borderRadius = '50%';
            startEl.style.backgroundColor = 'transparent';
            startEl.style.border = `3px solid ${style.color}`;
            startEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
            if (isStartEvent) {
              startEl.classList.add('throb-marker');
            }

            const startMarker = new mapboxgl.Marker({ element: startEl })
              .setLngLat([startFix.longitude, startFix.latitude])
              .addTo(map);
            activeMarkers.push(startMarker);

            // End marker (filled style)
            const endEl = document.createElement('div');
            endEl.style.width = '14px';
            endEl.style.height = '14px';
            endEl.style.borderRadius = '50%';
            endEl.style.backgroundColor = style.color;
            endEl.style.border = '3px solid white';
            endEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
            if (!isStartEvent) {
              endEl.classList.add('throb-marker');
            }

            const endMarker = new mapboxgl.Marker({ element: endEl })
              .setLngLat([endFix.longitude, endFix.latitude])
              .addTo(map);
            activeMarkers.push(endMarker);
          } else {
            // For point events, show single marker with throb
            const markerEl = document.createElement('div');
            markerEl.style.width = '16px';
            markerEl.style.height = '16px';
            markerEl.style.borderRadius = '50%';
            markerEl.style.backgroundColor = style.color;
            markerEl.style.border = '3px solid white';
            markerEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
            markerEl.classList.add('throb-marker');

            const marker = new mapboxgl.Marker({ element: markerEl })
              .setLngLat([event.longitude, event.latitude])
              .addTo(map);
            activeMarkers.push(marker);
          }

          // Pan to the event location (preserve current zoom level) unless skipPan is true
          if (!options?.skipPan) {
            map.flyTo({
              center: [event.longitude, event.latitude],
              zoom: map.getZoom(),
              duration: 1000,
            });
          }
        },

        getBounds() {
          const bounds = map.getBounds();
          if (!bounds) {
            return { north: 90, south: -90, east: 180, west: -180 };
          }
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
          for (const marker of eventMarkers) {
            marker.remove();
          }
          map.remove();
        },

        invalidateSize() {
          map.resize();
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
          map.flyTo({
            center: [tp.waypoint.lon, tp.waypoint.lat],
            zoom: map.getZoom(), // Keep current zoom level
            duration: 1000,
          });
        },

        showTrackPointHUD(fixIndex: number) {
          const data = buildTrackPointHUDData(currentFixes, currentEvents, fixIndex, getNextTurnpointContext);
          if (!data) return;

          // Clear previous crosshair only (not segment markers)
          clearHudCrosshair();

          // Hide glide legend (same position as HUD)
          showGlideLegend(false);

          // Add crosshair marker on the map
          const crosshairEl = document.createElement('div');
          crosshairEl.innerHTML = CROSSHAIR_MAP_SVG;
          crosshairEl.style.pointerEvents = 'none';
          hudCrosshairMarker = new mapboxgl.Marker({ element: crosshairEl })
            .setLngLat([data.fix.longitude, data.fix.latitude])
            .addTo(map);

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

    } catch (err) {
      reject(err);
    }
  });
}

// createCirclePolygon is imported from map-provider-shared
