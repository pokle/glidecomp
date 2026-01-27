/**
 * MapBox Provider
 *
 * MapBox GL JS implementation of the MapProvider interface.
 * Handles rendering of flight tracks, task turnpoints, and events.
 * Supports 3D track rendering via Threebox.
 */

import mapboxgl from 'mapbox-gl';
import { Threebox } from 'threebox-plugin';
import { IGCFix, getBoundingBox } from './igc-parser';
import { XCTask } from './xctsk-parser';
import { FlightEvent, getEventStyle } from './event-detector';
import { calculateGlideMarkers } from './glide-speed';
import type { MapProvider } from './map-provider';
import { haversineDistance, getCirclePoints } from './geo';
import { formatDistance, formatRadius, formatAltitude, formatSpeed, formatAltitudeChange } from './units';

// Set MapBox access token from environment variable
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

// MapBox style options
const MAPBOX_STYLES = [
  { id: 'outdoors', name: 'Outdoors', style: 'mapbox://styles/mapbox/outdoors-v12' },
  { id: 'satellite', name: 'Satellite', style: 'mapbox://styles/mapbox/satellite-streets-v12' },
  { id: 'streets', name: 'Streets', style: 'mapbox://styles/mapbox/streets-v12' },
  { id: 'light', name: 'Light', style: 'mapbox://styles/mapbox/light-v11' },
  { id: 'dark', name: 'Dark', style: 'mapbox://styles/mapbox/dark-v11' },
];

/**
 * Create a MapBox map provider
 */
export function createMapBoxProvider(container: HTMLElement): Promise<MapProvider> {
  return new Promise((resolve, reject) => {
    try {
      // Get default style
      const defaultStyle = MAPBOX_STYLES[0].style;

      const map = new mapboxgl.Map({
        container,
        style: defaultStyle,
        // center: [-36, 147],
        zoom: 2,
        pitch: 45,
        maxPitch: 85,
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

      // 3D rendering state
      let tb: Threebox | null = null;
      let is3DMode = false;
      let threeDObjects: unknown[] = [];

      // Altitude colors state
      let isAltitudeColorsMode = false;
      let altitudeGradientStops: [number, string][] = [];

      // Task visibility state
      let isTaskVisible = true;

      // Track visibility state
      let isTrackVisible = true;

      /**
       * Show or hide the glide legend help button
       */
      function showGlideLegend(show: boolean): void {
        if (show) {
          if (!glideLegendElement) {
            glideLegendElement = document.createElement('div');
            glideLegendElement.id = 'glide-legend';
            glideLegendElement.innerHTML = `
              <button class="glide-legend-btn" title="Glide metrics help">?</button>
              <div class="glide-legend-content">
                <div class="glide-legend-title">Glide Metrics</div>
                <div class="glide-legend-item"><strong>Chevrons:</strong> 500m segment markers</div>
                <div class="glide-legend-item"><strong>Speed:</strong> Average speed of segment</div>
                <div class="glide-legend-item"><strong>L/D:</strong> Glide ratio (distance ÷ altitude lost)</div>
                <div class="glide-legend-item"><strong>Alt:</strong> Altitude change from segment start to end</div>
              </div>
            `;
            glideLegendElement.style.cssText = `
              position: absolute;
              bottom: 30px;
              right: 10px;
              z-index: 1000;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            `;

            // Add styles for the legend
            const style = document.createElement('style');
            style.id = 'glide-legend-style';
            style.textContent = `
              #glide-legend .glide-legend-btn {
                width: 28px;
                height: 28px;
                border-radius: 50%;
                border: none;
                background: #3b82f6;
                color: white;
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                transition: transform 0.2s;
              }
              #glide-legend .glide-legend-btn:hover {
                transform: scale(1.1);
              }
              #glide-legend .glide-legend-content {
                display: none;
                position: absolute;
                bottom: 36px;
                right: 0;
                background: white;
                border-radius: 8px;
                padding: 12px;
                min-width: 260px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
              }
              #glide-legend.expanded .glide-legend-content {
                display: block;
              }
              #glide-legend .glide-legend-title {
                font-weight: 600;
                font-size: 14px;
                margin-bottom: 8px;
                color: #1e3a5f;
                border-bottom: 1px solid #e5e7eb;
                padding-bottom: 6px;
              }
              #glide-legend .glide-legend-item {
                font-size: 12px;
                color: #374151;
                margin: 6px 0;
                line-height: 1.4;
              }
              #glide-legend .glide-legend-item strong {
                color: #3b82f6;
              }
            `;

            if (!document.getElementById('glide-legend-style')) {
              document.head.appendChild(style);
            }

            // Toggle expanded state on click
            const btn = glideLegendElement.querySelector('.glide-legend-btn');
            btn?.addEventListener('click', () => {
              glideLegendElement?.classList.toggle('expanded');
            });

            container.appendChild(glideLegendElement);
          }
          glideLegendElement.style.display = 'block';
          glideLegendElement.classList.remove('expanded');
        } else {
          if (glideLegendElement) {
            glideLegendElement.style.display = 'none';
          }
        }
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

        // Clear highlight segment source
        (map.getSource('highlight-segment') as mapboxgl.GeoJSONSource)?.setData({
          type: 'FeatureCollection',
          features: [],
        });

        // Hide glide legend
        showGlideLegend(false);
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
          'track-line-gradient',
          'track-line',
          'track-line-outline',
          'task-cylinders-stroke',
          'task-cylinders-fill',
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

        // Track gradient source with lineMetrics for altitude-based coloring
        if (!map.getSource('track-gradient')) {
          map.addSource('track-gradient', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
            lineMetrics: true, // Required for line-gradient
            tolerance: 0.1,
          });
        }

        // Other sources with default simplification
        const sourcesToAdd = ['task-line', 'task-points', 'task-cylinders', 'task-segment-labels', 'highlight-segment'];
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

        // 1. Task line (dashed route)
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
            // Zoom-adaptive width: thicker at low zoom for visibility
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              3, 8 * width_mul,    // At zoom 3, width 8
              8, 12 * width_mul,   // At zoom 8, width 12
              12, 10 * width_mul,  // At zoom 12, width 10
            ],
            'line-opacity': 0.6,
          },
        });

        // 5. Track line - bright orange for visibility at all zoom levels
        map.addLayer({
          id: 'track-line',
          type: 'line',
          source: 'track',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': '#f97316', // Bright orange
            // Zoom-adaptive width: thicker at low zoom for visibility
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              3, 4 * width_mul,    // At zoom 3, width 4
              8, 6 * width_mul,    // At zoom 8, width 6
              12, 6 * width_mul,   // At zoom 12, width 6
            ],
            'line-opacity': 0.95,
          },
        });

        // 5a. Track line with altitude gradient (hidden by default)
        map.addLayer({
          id: 'track-line-gradient',
          type: 'line',
          source: 'track-gradient',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
            'visibility': 'none', // Hidden by default
          },
          paint: {
            // Default gradient - will be updated with altitude data
            'line-gradient': [
              'interpolate',
              ['linear'],
              ['line-progress'],
              0, '#3b82f6',
              1, '#ef4444',
            ],
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              3, 4 * width_mul,
              8, 6 * width_mul,
              12, 6 * width_mul,
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
            'text-size': 12,
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
            'text-size': 11,
            'text-offset': [0, 0],
            'text-anchor': 'center',
          },
          paint: {
            'text-color': '#6366f1',
            'text-halo-color': '#ffffff',
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
      }

      // Add navigation controls
      map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }));
      map.addControl(new mapboxgl.ScaleControl({ maxWidth: 200 }));
      map.addControl(new mapboxgl.FullscreenControl());

      // Add style selector control
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

          select.addEventListener('change', () => {
            const selectedStyle = MAPBOX_STYLES.find(s => s.id === select.value);
            if (selectedStyle) {
              map.setStyle(selectedStyle.style);
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
        map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });

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

      map.on('load', () => {
        isInitialLoad = false;

        // Initialize Threebox for 3D rendering
        tb = new Threebox(
          map,
          map.getCanvas().getContext('webgl'),
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

        resolve(renderer);
      });

      map.on('error', (e) => {
        console.error('MapBox error:', e.error);
      });

      // Track bounds changes
      map.on('moveend', () => {
        if (boundsChangeCallback) {
          boundsChangeCallback();
        }
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
        let minAlt = Infinity;
        let maxAlt = -Infinity;
        for (const fix of fixes) {
          if (fix.gnssAltitude < minAlt) minAlt = fix.gnssAltitude;
          if (fix.gnssAltitude > maxAlt) maxAlt = fix.gnssAltitude;
        }
        const altRange = maxAlt - minAlt;

        // Create line segments for the track
        // We'll create the track as connected line segments with altitude
        for (let i = 1; i < fixes.length; i++) {
          const prev = fixes[i - 1];
          const curr = fixes[i];

          // Normalize altitude for color
          const normalizedAlt = altRange > 0 ? (prev.gnssAltitude - minAlt) / altRange : 0;

          // Create a line segment between consecutive points
          // Threebox uses [longitude, latitude, altitude] format
          const lineSegment = tb.line({
            geometry: [
              [prev.longitude, prev.latitude, prev.gnssAltitude],
              [curr.longitude, curr.latitude, curr.gnssAltitude],
            ],
            color: getAltitudeColorNormalized(normalizedAlt),
            width: 3,
            opacity: 0.9,
          });
          tb.add(lineSegment);
          threeDObjects.push(lineSegment);
        }

        // Add vertical "drop lines" every N points for depth perception
        const dropLineInterval = Math.max(1, Math.floor(fixes.length / 50));
        for (let i = 0; i < fixes.length; i += dropLineInterval) {
          const fix = fixes[i];
          const dropLine = tb.line({
            geometry: [
              [fix.longitude, fix.latitude, fix.gnssAltitude],
              [fix.longitude, fix.latitude, 0],
            ],
            color: '#888888',
            width: 1,
            opacity: 0.3,
          });
          tb.add(dropLine);
          threeDObjects.push(dropLine);
        }
      }

      /**
       * Get color based on normalized altitude (0-1 range)
       * Uses a gradient from earthy brown (low) through green to sky blue (high)
       */
      function getAltitudeColorNormalized(normalizedAlt: number): string {
        // Clamp to 0-1
        const t = Math.max(0, Math.min(1, normalizedAlt));

        // Color stops: brown (low) -> green -> light blue -> sky blue (high)
        // More saturated colors for better distinction
        const colors = [
          { pos: 0.0, r: 139, g: 90, b: 43 },    // Saturated Brown #8B5A2B
          { pos: 0.25, r: 67, g: 160, b: 71 },   // Saturated Green #43A047
          { pos: 0.5, r: 3, g: 155, b: 229 },    // Saturated Cyan #039BE5
          { pos: 0.75, r: 41, g: 182, b: 246 },  // Bright Sky Blue #29B6F6
          { pos: 1.0, r: 79, g: 195, b: 247 },   // Sky Blue #4FC3F7
        ];

        // Find the two colors to interpolate between
        let lower = colors[0];
        let upper = colors[colors.length - 1];
        for (let i = 0; i < colors.length - 1; i++) {
          if (t >= colors[i].pos && t <= colors[i + 1].pos) {
            lower = colors[i];
            upper = colors[i + 1];
            break;
          }
        }

        // Interpolate
        const range = upper.pos - lower.pos;
        const localT = range > 0 ? (t - lower.pos) / range : 0;
        const r = Math.round(lower.r + (upper.r - lower.r) * localT);
        const g = Math.round(lower.g + (upper.g - lower.g) * localT);
        const b = Math.round(lower.b + (upper.b - lower.b) * localT);

        return `rgb(${r}, ${g}, ${b})`;
      }

      /**
       * Get color based on altitude using fixed thresholds (for 3D mode)
       * Earthy colors (brown) at low altitude, sky colors (blue) at high altitude
       */
      function getAltitudeColor(altitude: number): string {
        if (altitude < 500) return '#8D6E63';      // Brown
        if (altitude < 1000) return '#A1887F';     // Light Brown
        if (altitude < 1500) return '#66BB6A';     // Green
        if (altitude < 2000) return '#29B6F6';     // Light Blue
        if (altitude < 2500) return '#81D4FA';     // Sky Blue
        return '#E3F2FD';                           // Pale Sky
      }

      // Alias for backwards compatibility with local code
      const calculateDistance = haversineDistance;

      /**
       * Calculate altitude gradient stops based on line progress
       * Colors are scaled relative to the flight's min/max altitude
       */
      function calculateAltitudeGradient(fixes: IGCFix[]): [number, string][] {
        if (fixes.length < 2) return [[0, '#3b82f6'], [1, '#3b82f6']];

        // Calculate min and max altitude for this flight
        let minAlt = Infinity;
        let maxAlt = -Infinity;
        for (const fix of fixes) {
          if (fix.gnssAltitude < minAlt) minAlt = fix.gnssAltitude;
          if (fix.gnssAltitude > maxAlt) maxAlt = fix.gnssAltitude;
        }
        const altRange = maxAlt - minAlt;

        // Calculate cumulative distances
        const distances: number[] = [0];
        let totalDistance = 0;
        for (let i = 1; i < fixes.length; i++) {
          const dist = calculateDistance(
            fixes[i - 1].latitude, fixes[i - 1].longitude,
            fixes[i].latitude, fixes[i].longitude
          );
          totalDistance += dist;
          distances.push(totalDistance);
        }

        if (totalDistance === 0) return [[0, '#3b82f6'], [1, '#3b82f6']];

        // Sample points along the track for gradient stops (limit to ~100 stops for smoother gradients)
        const stops: [number, string][] = [];
        const sampleInterval = Math.max(1, Math.floor(fixes.length / 100));

        // Start with progress 0
        const firstNormalizedAlt = altRange > 0 ? (fixes[0].gnssAltitude - minAlt) / altRange : 0;
        stops.push([0, getAltitudeColorNormalized(firstNormalizedAlt)]);

        let lastProgress = 0;
        const minProgressIncrement = 0.001; // Minimum progress increment to avoid duplicates

        for (let i = sampleInterval; i < fixes.length; i += sampleInterval) {
          const progress = distances[i] / totalDistance;

          // Only add if progress is strictly greater than the last value
          if (progress > lastProgress + minProgressIncrement) {
            // Normalize altitude to 0-1 range based on this flight's min/max
            const normalizedAlt = altRange > 0 ? (fixes[i].gnssAltitude - minAlt) / altRange : 0;
            const color = getAltitudeColorNormalized(normalizedAlt);
            stops.push([progress, color]);
            lastProgress = progress;
          }
        }

        // Ensure we have the last point at exactly 1.0
        if (lastProgress < 1 - minProgressIncrement) {
          const lastFix = fixes[fixes.length - 1];
          const normalizedAlt = altRange > 0 ? (lastFix.gnssAltitude - minAlt) / altRange : 0;
          stops.push([1, getAltitudeColorNormalized(normalizedAlt)]);
        } else {
          // Replace the last stop with exactly 1.0
          const lastFix = fixes[fixes.length - 1];
          const normalizedAlt = altRange > 0 ? (lastFix.gnssAltitude - minAlt) / altRange : 0;
          stops[stops.length - 1] = [1, getAltitudeColorNormalized(normalizedAlt)];
        }

        return stops;
      }

      /**
       * Update the gradient layer with altitude colors
       */
      function updateGradientLayer(): void {
        if (!map.getLayer('track-line-gradient') || altitudeGradientStops.length < 2) return;

        // Build the gradient expression
        const gradientExpr: ['interpolate', ['linear'], ['line-progress'], ...unknown[]] =
          ['interpolate', ['linear'], ['line-progress']];
        for (const [progress, color] of altitudeGradientStops) {
          gradientExpr.push(progress, color);
        }

        map.setPaintProperty('track-line-gradient', 'line-gradient', gradientExpr as mapboxgl.Expression);
      }

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
          if (map.getLayer('track-line-gradient')) {
            map.setLayoutProperty('track-line-gradient', 'visibility', 'none');
          }
          // Show 3D track
          render3DTrack(currentFixes);
        } else if (isAltitudeColorsMode) {
          // Show gradient track, hide solid track
          if (map.getLayer('track-line')) {
            map.setLayoutProperty('track-line', 'visibility', 'none');
          }
          if (map.getLayer('track-line-outline')) {
            map.setLayoutProperty('track-line-outline', 'visibility', 'visible');
          }
          if (map.getLayer('track-line-gradient')) {
            map.setLayoutProperty('track-line-gradient', 'visibility', 'visible');
          }
          // Hide 3D track
          clear3DTrack();
        } else {
          // Show solid track, hide gradient track
          if (map.getLayer('track-line')) {
            map.setLayoutProperty('track-line', 'visibility', 'visible');
          }
          if (map.getLayer('track-line-outline')) {
            map.setLayoutProperty('track-line-outline', 'visibility', 'visible');
          }
          if (map.getLayer('track-line-gradient')) {
            map.setLayoutProperty('track-line-gradient', 'visibility', 'none');
          }
          // Hide 3D track
          clear3DTrack();
        }
      }

      const renderer: MapProvider = {
        supports3D: true,
        supportsAltitudeColors: true,

        set3DMode(enabled: boolean) {
          is3DMode = enabled;
          clearEventHighlights();
          updateTrackRendering();
        },

        setAltitudeColors(enabled: boolean) {
          isAltitudeColorsMode = enabled;
          clearEventHighlights();
          updateTrackRendering();
        },

        setTaskVisibility(visible: boolean) {
          isTaskVisible = visible;
          const visibility = visible ? 'visible' : 'none';
          const taskLayers = [
            'task-line',
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
              'track-line-gradient',
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

          if (fixes.length === 0) {
            (map.getSource('track') as mapboxgl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            (map.getSource('track-gradient') as mapboxgl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            altitudeGradientStops = [];
            return;
          }

          // Create a single continuous LineString for better rendering at all zoom levels
          const coordinates = fixes.map(fix => [fix.longitude, fix.latitude, fix.gnssAltitude]);

          // Calculate average altitude for basic coloring
          const avgAltitude = fixes.reduce((sum, fix) => sum + fix.gnssAltitude, 0) / fixes.length;

          // Update solid track source
          (map.getSource('track') as mapboxgl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: {
                altitude: avgAltitude,
              },
              geometry: {
                type: 'LineString',
                coordinates,
              },
            }],
          });

          // Update gradient track source (same geometry, but with lineMetrics)
          (map.getSource('track-gradient') as mapboxgl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates,
              },
            }],
          });

          // Calculate altitude gradient stops and update the gradient layer
          altitudeGradientStops = calculateAltitudeGradient(fixes);
          updateGradientLayer();

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

        async setTask(task: XCTask) {
          currentTask = task;

          if (!task || task.turnpoints.length === 0) {
            (map.getSource('task-line') as mapboxgl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            (map.getSource('task-points') as mapboxgl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            (map.getSource('task-cylinders') as mapboxgl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            (map.getSource('task-segment-labels') as mapboxgl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            return;
          }

          // Create optimized task line that tags cylinder edges
          const { calculateOptimizedTaskLine, getOptimizedSegmentDistances } = await import('./xctsk-parser');
          const optimizedPath = calculateOptimizedTaskLine(task);
          const lineCoords = optimizedPath.map(p => [p.lon, p.lat]);

          (map.getSource('task-line') as mapboxgl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: lineCoords,
                },
              },
            ],
          });

          // Create segment distance labels
          const segmentDistances = getOptimizedSegmentDistances(task);
          const segmentLabelFeatures = [];
          for (let i = 0; i < optimizedPath.length - 1; i++) {
            const p1 = optimizedPath[i];
            const p2 = optimizedPath[i + 1];
            const distance = segmentDistances[i];

            const midLon = (p1.lon + p2.lon) / 2;
            const midLat = (p1.lat + p2.lat) / 2;

            const distanceStr = formatDistance(distance, { decimals: 1 }).withUnit;
            const legNumber = i + 1;
            segmentLabelFeatures.push({
              type: 'Feature' as const,
              properties: {
                distance: `Leg ${legNumber}: ${distanceStr}`,
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [midLon, midLat],
              },
            });
          }

          (map.getSource('task-segment-labels') as mapboxgl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: segmentLabelFeatures,
          });

          // Create turnpoint markers
          const pointFeatures = task.turnpoints.map((tp, idx) => {
            const name = tp.waypoint.name || `TP${idx + 1}`;
            const radiusStr = formatRadius(tp.radius).withUnit;
            const altitude = tp.waypoint.altSmoothed ? `A\u00A0${formatAltitude(tp.waypoint.altSmoothed).withUnit}` : '';
            const role = tp.type || '';

            // Build label: "NAME, R Xkm, A Ym, ROLE" (with non-breaking spaces)
            const labelParts = [name, `R\u00A0${radiusStr}`];
            if (altitude) labelParts.push(altitude);
            if (role) labelParts.push(role);
            const label = labelParts.join(', ');

            return {
              type: 'Feature' as const,
              properties: {
                name: label,
                type: tp.type || '',
                radius: tp.radius,
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [tp.waypoint.lon, tp.waypoint.lat],
              },
            };
          });

          (map.getSource('task-points') as mapboxgl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: pointFeatures,
          });

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

          (map.getSource('task-cylinders') as mapboxgl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: cylinderFeatures,
          });

          // If no track is loaded, fit to task bounds
          if (currentFixes.length === 0) {
            const bounds = new mapboxgl.LngLatBounds();
            for (const tp of task.turnpoints) {
              bounds.extend([tp.waypoint.lon, tp.waypoint.lat]);
            }
            map.fitBounds(bounds, { padding: 50, duration: 1000 });
          }
        },

        setEvents(events: FlightEvent[]) {
          currentEvents = events;

          // Remove old markers
          for (const marker of eventMarkers) {
            marker.remove();
          }
          eventMarkers.length = 0;

          // Add new markers (only for key events to avoid clutter)
          const keyEventTypes = new Set([
            'takeoff',
            'landing',
            'start_crossing',
            'goal_crossing',
            'max_altitude',
            'turnpoint_entry',
          ]);

          for (const event of events) {
            if (!keyEventTypes.has(event.type)) continue;

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
        },

        panToEvent(event: FlightEvent) {
          // Close any existing popup and markers
          if (activePopup) {
            activePopup.remove();
            activePopup = null;
          }
          for (const marker of activeMarkers) {
            marker.remove();
          }
          activeMarkers = [];

          // Show/hide glide legend based on event type
          const isGlideEvent = event.type === 'glide_start' || event.type === 'glide_end';
          showGlideLegend(isGlideEvent);

          // Highlight segment if event has one
          if (event.segment && currentFixes.length > 0) {
            const { startIndex, endIndex } = event.segment;
            const segmentFixes = currentFixes.slice(startIndex, endIndex + 1);

            if (segmentFixes.length > 1) {
              const coordinates = segmentFixes.map(fix => [fix.longitude, fix.latitude, fix.gnssAltitude]);

              (map.getSource('highlight-segment') as mapboxgl.GeoJSONSource)?.setData({
                type: 'FeatureCollection',
                features: [{
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'LineString',
                    coordinates,
                  },
                }],
              });

              // For glide events, add direction chevrons every ~500m with speed labels
              if (event.type === 'glide_start' || event.type === 'glide_end') {
                const glideMarkers = calculateGlideMarkers(segmentFixes);

                for (const marker of glideMarkers) {
                  if (marker.type === 'speed-label') {
                    // Create speed label with glide ratio and altitude
                    const labelEl = document.createElement('div');
                    labelEl.style.cssText = `
                      font-size: 12px;
                      font-weight: 600;
                      color: #3b82f6;
                      white-space: nowrap;
                      text-shadow: -1px -1px 0 white, 1px -1px 0 white, -1px 1px 0 white, 1px 1px 0 white;
                      text-align: center;
                      line-height: 1.3;
                    `;

                    // Format the label content using units module
                    const speed = formatSpeed(marker.speedMps || 0).withUnit;
                    const glideRatio = marker.glideRatio !== undefined
                      ? `${marker.glideRatio.toFixed(0)}:1`
                      : '∞:1'; // Infinite glide ratio if climbing or level
                    const altDiff = marker.altitudeDiff !== undefined
                      ? formatAltitudeChange(marker.altitudeDiff).withUnit
                      : '';

                    labelEl.innerHTML = `${speed}<br>${glideRatio} ${altDiff}`;

                    const labelMarker = new mapboxgl.Marker({ element: labelEl })
                      .setLngLat([marker.lon, marker.lat])
                      .addTo(map);
                    activeMarkers.push(labelMarker);
                  } else {
                    // Create chevron marker
                    const chevronEl = document.createElement('div');
                    chevronEl.style.display = 'flex';
                    chevronEl.style.alignItems = 'center';
                    chevronEl.style.justifyContent = 'center';
                    chevronEl.innerHTML = `<svg width="20" height="12" viewBox="0 0 20 12" style="transform: rotate(${marker.bearing}deg);">
                      <path d="M2 10 L10 2 L18 10" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>`;

                    const chevronMarker = new mapboxgl.Marker({ element: chevronEl })
                      .setLngLat([marker.lon, marker.lat])
                      .addTo(map);
                    activeMarkers.push(chevronMarker);
                  }
                }
              }
            }
          } else {
            (map.getSource('highlight-segment') as mapboxgl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
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

          // Pan to the event location (preserve current zoom level)
          map.flyTo({
            center: [event.longitude, event.latitude],
            zoom: map.getZoom(),
            duration: 1000,
          });
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
      };

    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Create a circle polygon for cylinder rendering using geodesic calculations
 */
function createCirclePolygon(
  centerLon: number,
  centerLat: number,
  radiusMeters: number,
  numPoints = 64
): GeoJSON.Polygon {
  const points = getCirclePoints(centerLat, centerLon, radiusMeters, numPoints);
  // Convert to GeoJSON format [lon, lat]
  const coords: [number, number][] = points.map(p => [p.lon, p.lat]);

  return {
    type: 'Polygon',
    coordinates: [coords],
  };
}
