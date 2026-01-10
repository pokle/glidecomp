/**
 * Map Renderer using MapLibre GL JS
 *
 * Handles rendering of:
 * - Base map with hillshade terrain
 * - Flight tracklog
 * - Task turnpoints and cylinders
 * - Event markers
 */

import maplibregl from 'maplibre-gl';
import { IGCFix, getBoundingBox } from './igc-parser';
import { XCTask } from './xctsk-parser';
import { FlightEvent, getEventStyle } from './event-detector';

export interface MapRenderer {
  map: maplibregl.Map;
  setTrack(fixes: IGCFix[]): void;
  setTask(task: XCTask): void;
  setEvents(events: FlightEvent[]): void;
  panToEvent(event: FlightEvent): void;
  getBounds(): { north: number; south: number; east: number; west: number };
  onBoundsChange(callback: () => void): void;
  destroy(): void;
}

/**
 * Create a MapLibre map with hillshade terrain
 */
export function createMap(container: HTMLElement): Promise<MapRenderer> {
  return new Promise((resolve, reject) => {
    try {
      const map = new maplibregl.Map({
        container,
        style: {
          version: 8,
          sources: {
            'osm-tiles': {
              type: 'raster',
              tiles: [
                'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
                'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
                'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
              ],
              tileSize: 256,
              attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            },
            'terrain-dem': {
              type: 'raster-dem',
              url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
              tileSize: 256,
            },
            'hillshade-dem': {
              type: 'raster-dem',
              url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
              tileSize: 256,
            },
          },
          layers: [
            {
              id: 'osm-layer',
              type: 'raster',
              source: 'osm-tiles',
              minzoom: 0,
              maxzoom: 19,
            },
            {
              id: 'hillshade',
              type: 'hillshade',
              source: 'hillshade-dem',
              paint: {
                'hillshade-illumination-direction': 315,
                'hillshade-exaggeration': 0.5,
                'hillshade-shadow-color': '#473B24',
                'hillshade-highlight-color': '#FFFFFF',
                'hillshade-accent-color': '#5a5a5a',
              },
            },
          ],
          terrain: {
            source: 'terrain-dem',
            exaggeration: 1,
          },
          sky: {},
        },
        center: [0, 45],
        zoom: 5,
        pitch: 45,
        maxPitch: 85,
      });

      // Add navigation controls
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
      map.addControl(new maplibregl.TerrainControl({ source: 'terrain-dem', exaggeration: 1 }));
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 200 }));
      map.addControl(new maplibregl.FullscreenControl());

      // State
      let boundsChangeCallback: (() => void) | null = null;
      let currentFixes: IGCFix[] = [];
      let currentTask: XCTask | null = null;
      let currentEvents: FlightEvent[] = [];
      const eventMarkers: maplibregl.Marker[] = [];

      map.on('load', () => {
        // Add empty sources for track and task
        map.addSource('track', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addSource('task-line', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addSource('task-points', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        map.addSource('task-cylinders', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });

        // Add track layer with altitude-based coloring
        map.addLayer({
          id: 'track-line',
          type: 'line',
          source: 'track',
          layout: {
            'line-join': 'round',
            'line-cap': 'round',
          },
          paint: {
            'line-color': [
              'interpolate',
              ['linear'],
              ['get', 'altitude'],
              0, '#3b82f6',      // Blue at low altitude
              1000, '#22c55e',   // Green
              2000, '#eab308',   // Yellow
              3000, '#ef4444',   // Red at high altitude
            ],
            'line-width': 3,
            'line-opacity': 0.9,
          },
        });

        // Add track outline for visibility
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
            'line-width': 5,
            'line-opacity': 0.3,
          },
        }, 'track-line');

        // Add task cylinders layer (fill)
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
        }, 'track-line-outline');

        // Add task cylinders layer (stroke)
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
        }, 'track-line-outline');

        // Add task line layer
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
        }, 'task-cylinders-fill');

        // Add task points layer
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

        // Add task point labels
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

        resolve(renderer);
      });

      map.on('error', (e) => {
        console.error('Map error:', e.error);
      });

      // Track bounds changes
      map.on('moveend', () => {
        if (boundsChangeCallback) {
          boundsChangeCallback();
        }
      });

      const renderer: MapRenderer = {
        map,

        setTrack(fixes: IGCFix[]) {
          currentFixes = fixes;

          if (fixes.length === 0) {
            (map.getSource('track') as maplibregl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            return;
          }

          // Create line segments with altitude property for coloring
          const features: GeoJSON.Feature[] = [];

          for (let i = 0; i < fixes.length - 1; i++) {
            features.push({
              type: 'Feature',
              properties: {
                altitude: fixes[i].gnssAltitude,
                time: fixes[i].time.toISOString(),
              },
              geometry: {
                type: 'LineString',
                coordinates: [
                  [fixes[i].longitude, fixes[i].latitude],
                  [fixes[i + 1].longitude, fixes[i + 1].latitude],
                ],
              },
            });
          }

          (map.getSource('track') as maplibregl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features,
          });

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
        },

        setTask(task: XCTask) {
          currentTask = task;

          if (!task || task.turnpoints.length === 0) {
            (map.getSource('task-line') as maplibregl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            (map.getSource('task-points') as maplibregl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            (map.getSource('task-cylinders') as maplibregl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
            return;
          }

          // Create task line
          const lineCoords = task.turnpoints.map(tp => [
            tp.waypoint.lon,
            tp.waypoint.lat,
          ]);

          (map.getSource('task-line') as maplibregl.GeoJSONSource)?.setData({
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

          // Create turnpoint markers
          const pointFeatures = task.turnpoints.map((tp, idx) => ({
            type: 'Feature' as const,
            properties: {
              name: tp.waypoint.name || `TP${idx + 1}`,
              type: tp.type || '',
              radius: tp.radius,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [tp.waypoint.lon, tp.waypoint.lat],
            },
          }));

          (map.getSource('task-points') as maplibregl.GeoJSONSource)?.setData({
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

          (map.getSource('task-cylinders') as maplibregl.GeoJSONSource)?.setData({
            type: 'FeatureCollection',
            features: cylinderFeatures,
          });

          // If no track is loaded, fit to task bounds
          if (currentFixes.length === 0) {
            const bounds = new maplibregl.LngLatBounds();
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

            const marker = new maplibregl.Marker({ element: el })
              .setLngLat([event.longitude, event.latitude])
              .setPopup(
                new maplibregl.Popup({ offset: 25 }).setHTML(`
                  <strong>${event.description}</strong><br>
                  <span style="color: #666">${event.time.toLocaleTimeString()}</span>
                `)
              )
              .addTo(map);

            eventMarkers.push(marker);
          }
        },

        panToEvent(event: FlightEvent) {
          map.flyTo({
            center: [event.longitude, event.latitude],
            zoom: 14,
            duration: 1000,
          });
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
          for (const marker of eventMarkers) {
            marker.remove();
          }
          map.remove();
        },
      };

    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Create a circle polygon (approximation) for cylinder rendering
 */
function createCirclePolygon(
  centerLon: number,
  centerLat: number,
  radiusMeters: number,
  numPoints = 64
): GeoJSON.Polygon {
  const coords: [number, number][] = [];

  for (let i = 0; i <= numPoints; i++) {
    const angle = (i / numPoints) * 2 * Math.PI;

    // Convert radius from meters to degrees (approximate)
    const latOffset = (radiusMeters / 111320) * Math.cos(angle);
    const lonOffset =
      (radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180))) *
      Math.sin(angle);

    coords.push([centerLon + lonOffset, centerLat + latOffset]);
  }

  return {
    type: 'Polygon',
    coordinates: [coords],
  };
}
