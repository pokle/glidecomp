/**
 * MapLibre Provider
 * 
 * MapLibre GL JS implementation of the MapProvider interface.
 * Handles rendering of flight tracks, task turnpoints, and events.
 */

import maplibregl from 'maplibre-gl';
import { IGCFix, getBoundingBox } from './igc-parser';
import { XCTask } from './xctsk-parser';
import { FlightEvent, getEventStyle } from './event-detector';
import { StyleSelectorControl, MAP_STYLES, getStyleById } from './map-styles';
import type { MapProvider } from './map-provider';

// Re-export MapProvider as MapRenderer for backwards compatibility
export type MapRenderer = MapProvider & { map: maplibregl.Map };

/**
 * Create a MapLibre map provider with hillshade terrain
 */
export function createMapLibreProvider(container: HTMLElement): Promise<MapProvider> {
  return new Promise((resolve, reject) => {
    try {
      // Get default style
      const defaultStyle = MAP_STYLES[0].style;

      const map = new maplibregl.Map({
        container,
        style: defaultStyle,
        center: [0, 45],
        zoom: 5,
        pitch: 45,
        maxPitch: 85,
      });

      // State
      let boundsChangeCallback: (() => void) | null = null;
      let currentFixes: IGCFix[] = [];
      let currentTask: XCTask | null = null;
      let currentEvents: FlightEvent[] = [];
      const eventMarkers: maplibregl.Marker[] = [];
      let activePopup: maplibregl.Popup | null = null;
      let activeMarkers: maplibregl.Marker[] = [];

      /**
       * Add custom sources and layers for track/task visualization
       *
       * Layer order (bottom to top):
       * 1. task-line (dashed route line)
       * 2. task-cylinders-fill (cylinder fill)
       * 3. task-cylinders-stroke (cylinder outline)
       * 4. track-line-outline (track shadow)
       * 5. track-line (main track)
       * 6. task-points (turnpoint circles)
       * 7. task-labels (turnpoint names)
       */
      function addCustomLayers(): void {
        // Remove existing custom layers to ensure correct ordering
        const customLayers = [
          'task-labels',
          'task-points',
          'highlight-segment',
          'track-line',
          'track-line-outline',
          'task-cylinders-stroke',
          'task-cylinders-fill',
          'task-line',
        ];
        for (const layerId of customLayers) {
          if (map.getLayer(layerId)) {
            console.log(`[MapRenderer] Removing existing layer: ${layerId}`);
            map.removeLayer(layerId);
          }
        }

        // Add sources (only if they don't exist)
        const sourcesToAdd = ['track', 'task-line', 'task-points', 'task-cylinders', 'highlight-segment'];
        for (const sourceId of sourcesToAdd) {
          const exists = !!map.getSource(sourceId);
          console.log(`[MapRenderer] Source ${sourceId} exists: ${exists}`);
          if (!exists) {
            map.addSource(sourceId, {
              type: 'geojson',
              data: { type: 'FeatureCollection', features: [] },
            });
            console.log(`[MapRenderer] Added source: ${sourceId}`);
          }
        }

        // Add layers in order from bottom to top (no beforeId needed)

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
            'line-width': 5,
            'line-opacity': 0.3,
          },
        });

        // 5. Track line with altitude-based coloring
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
              0, '#3b82f6',
              1000, '#22c55e',
              2000, '#eab308',
              3000, '#ef4444',
            ],
            'line-width': 3,
            'line-opacity': 0.9,
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
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 200 }));
      map.addControl(new maplibregl.FullscreenControl());

      // Add style selector control
      const styleSelector = new StyleSelectorControl((styleId) => {
        const newStyle = getStyleById(styleId);
        if (newStyle) {
          map.setStyle(newStyle);
        }
      });
      map.addControl(styleSelector, 'top-left');

      // Handle style changes - style.load fires on initial load AND on setStyle
      let isInitialLoad = true;
      map.on('style.load', () => {
        console.log('[MapRenderer] style.load fired, isInitialLoad:', isInitialLoad);
        addCustomLayers();
        if (!isInitialLoad) {
          // Only restore data on style changes, not initial load
          restoreData();
        }
      });

      map.on('load', () => {
        console.log('[MapRenderer] load event fired');
        isInitialLoad = false;
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
          // Using 3D coordinates [lng, lat, alt] so track renders at GPS altitude
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
                  [fixes[i].longitude, fixes[i].latitude, fixes[i].gnssAltitude],
                  [fixes[i + 1].longitude, fixes[i + 1].latitude, fixes[i + 1].gnssAltitude],
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
          // Close any existing popup and markers
          if (activePopup) {
            activePopup.remove();
            activePopup = null;
          }
          for (const marker of activeMarkers) {
            marker.remove();
          }
          activeMarkers = [];

          // Highlight segment if event has one
          if (event.segment && currentFixes.length > 0) {
            const { startIndex, endIndex } = event.segment;
            const segmentFixes = currentFixes.slice(startIndex, endIndex + 1);

            if (segmentFixes.length > 1) {
              // Using 3D coordinates to match track altitude
              const coordinates = segmentFixes.map(fix => [fix.longitude, fix.latitude, fix.gnssAltitude]);

              (map.getSource('highlight-segment') as maplibregl.GeoJSONSource)?.setData({
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
            }
          } else {
            // Clear highlight for point events
            (map.getSource('highlight-segment') as maplibregl.GeoJSONSource)?.setData({
              type: 'FeatureCollection',
              features: [],
            });
          }

          // Determine popup location
          // For segment events, position at start or end based on event type
          let popupLng = event.longitude;
          let popupLat = event.latitude;

          if (event.segment && currentFixes.length > 0) {
            const isStartEvent = event.type === 'thermal_entry' || event.type === 'glide_start';
            const fixIndex = isStartEvent ? event.segment.startIndex : event.segment.endIndex;
            const fix = currentFixes[fixIndex];
            if (fix) {
              popupLng = fix.longitude;
              popupLat = fix.latitude;
            }
          }

          // Create and show popup
          const style = getEventStyle(event.type);
          activePopup = new maplibregl.Popup({
            closeButton: true,
            closeOnClick: false,
            offset: 25,
          })
            .setLngLat([popupLng, popupLat])
            .setHTML(`
              <div style="min-width: 150px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                  <span style="width: 10px; height: 10px; border-radius: 50%; background: ${style.color};"></span>
                  <strong>${event.description}</strong>
                </div>
                <div style="color: #94a3b8; font-size: 0.8125rem;">
                  ${event.time.toLocaleTimeString()} | ${event.altitude.toFixed(0)}m
                </div>
              </div>
            `)
            .addTo(map);

          // Create markers at segment endpoints or event point

          if (event.segment && currentFixes.length > 0) {
            // For segment events, show start and end markers
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

            const startMarker = new maplibregl.Marker({ element: startEl })
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

            const endMarker = new maplibregl.Marker({ element: endEl })
              .setLngLat([endFix.longitude, endFix.latitude])
              .addTo(map);
            activeMarkers.push(endMarker);
          } else {
            // For point events, show single marker
            const markerEl = document.createElement('div');
            markerEl.style.width = '16px';
            markerEl.style.height = '16px';
            markerEl.style.borderRadius = '50%';
            markerEl.style.backgroundColor = style.color;
            markerEl.style.border = '3px solid white';
            markerEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';

            const marker = new maplibregl.Marker({ element: markerEl })
              .setLngLat([event.longitude, event.latitude])
              .addTo(map);
            activeMarkers.push(marker);
          }

          // Pan to the event location
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

// Backwards compatibility alias
export const createMap = createMapLibreProvider;
