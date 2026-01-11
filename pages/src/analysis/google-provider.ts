/**
 * Google Maps Provider
 * 
 * Google Maps JavaScript API implementation of the MapProvider interface.
 * Handles rendering of flight tracks, task turnpoints, and events.
 */

import type { IGCFix } from './igc-parser';
import type { XCTask } from './xctsk-parser';
import type { FlightEvent } from './event-detector';
import { getEventStyle } from './event-detector';
import type { MapProvider, MapBounds } from './map-provider';

// Google Maps types (loaded dynamically)
declare const google: any;

/**
 * Create a Google Maps provider
 */
export async function createGoogleMapsProvider(container: HTMLElement): Promise<MapProvider> {
    // Wait for Google Maps to load
    const { Map } = await google.maps.importLibrary('maps');
    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');

    const map = new Map(container, {
        center: { lat: 45, lng: 0 },
        zoom: 5,
        mapId: '20ffc5ceb7e4c3f6e3f1d6be',
        mapTypeId: 'terrain',
        mapTypeControl: true,
        mapTypeControlOptions: {
            mapTypeIds: ['roadmap', 'terrain', 'satellite', 'hybrid'],
        },
        fullscreenControl: true,
        scaleControl: true,
    });

    // State - using 'any' types since Google Maps types are loaded dynamically
    let currentFixes: IGCFix[] = [];
    let currentTask: XCTask | null = null;
    let currentEvents: FlightEvent[] = [];
    let trackSegments: any[] = [];  // Colored track segments
    let taskLine: any = null;
    let taskCircles: any[] = [];
    let taskMarkers: any[] = [];
    let eventMarkers: any[] = [];
    let highlightPath: any = null;
    let activeInfoWindow: any = null;
    let boundsChangeCallback: (() => void) | null = null;

    // Listen for bounds changes
    map.addListener('idle', () => {
        if (boundsChangeCallback) {
            boundsChangeCallback();
        }
    });

    /**
     * Get altitude-based color
     */
    function getAltitudeColor(altitude: number): string {
        if (altitude < 1000) return '#3b82f6';
        if (altitude < 2000) return '#22c55e';
        if (altitude < 3000) return '#eab308';
        return '#ef4444';
    }

    /**
     * Create a circle polygon for cylinder rendering
     */
    function createCircle(lat: number, lng: number, radius: number, color: string): any {
        return new google.maps.Circle({
            map,
            center: { lat, lng },
            radius,
            strokeColor: color,
            strokeOpacity: 0.8,
            strokeWeight: 2,
            fillColor: color,
            fillOpacity: 0.15,
        });
    }

    /**
     * Render the track with event-based coloring
     */
    function renderTrackWithEvents(): void {
        // Clear existing track segments
        for (const segment of trackSegments) {
            segment.setMap(null);
        }
        trackSegments = [];

        if (currentFixes.length === 0) return;

        // Build a map of fix index -> event type for segments
        const fixEventType: (string | null)[] = new Array(currentFixes.length).fill(null);

        for (const event of currentEvents) {
            if (event.segment) {
                const eventType = event.type.includes('thermal') ? 'thermal' :
                    event.type.includes('glide') ? 'glide' : null;
                if (eventType) {
                    for (let i = event.segment.startIndex; i <= event.segment.endIndex; i++) {
                        fixEventType[i] = eventType;
                    }
                }
            }
        }

        // Create segments with consistent colors
        let segmentStart = 0;
        let currentType = fixEventType[0];

        for (let i = 1; i <= currentFixes.length; i++) {
            const nextType = i < currentFixes.length ? fixEventType[i] : 'END';

            if (nextType !== currentType || i === currentFixes.length) {
                // Create segment from segmentStart to i
                const segmentFixes = currentFixes.slice(segmentStart, i + 1);
                const path = segmentFixes.map(fix => ({ lat: fix.latitude, lng: fix.longitude }));

                // Color based on event type
                const color = currentType === 'thermal' ? '#f97316' :  // orange
                    currentType === 'glide' ? '#3b82f6' :     // blue
                        '#9ca3af';                                 // gray (default)

                const polyline = new google.maps.Polyline({
                    path,
                    geodesic: true,
                    strokeColor: color,
                    strokeOpacity: 0.9,
                    strokeWeight: 3,
                    map,
                });
                trackSegments.push(polyline);

                segmentStart = i;
                currentType = nextType as string | null;
            }
        }

        // Fit bounds
        const bounds = new google.maps.LatLngBounds();
        for (const fix of currentFixes) {
            bounds.extend({ lat: fix.latitude, lng: fix.longitude });
        }
        map.fitBounds(bounds, 50);
    }

    const provider: MapProvider = {
        setTrack(fixes: IGCFix[]) {
            currentFixes = fixes;
            renderTrackWithEvents();
        },

        setTask(task: XCTask) {
            currentTask = task;

            // Clear existing task elements
            if (taskLine) {
                taskLine.setMap(null);
                taskLine = null;
            }
            for (const circle of taskCircles) {
                circle.setMap(null);
            }
            taskCircles = [];
            for (const marker of taskMarkers) {
                marker.map = null;
            }
            taskMarkers = [];

            if (!task || task.turnpoints.length === 0) return;

            // Create task line
            const linePath = task.turnpoints.map(tp => ({
                lat: tp.waypoint.lat,
                lng: tp.waypoint.lon,
            }));

            taskLine = new google.maps.Polyline({
                path: linePath,
                geodesic: true,
                strokeColor: '#6366f1',
                strokeOpacity: 0.8,
                strokeWeight: 2,
                strokePattern: [4, 4],
                map,
            });

            // Create cylinders and markers
            for (const tp of task.turnpoints) {
                const color = tp.type === 'SSS' ? '#22c55e' :
                    tp.type === 'ESS' ? '#eab308' :
                        tp.type === 'TAKEOFF' ? '#3b82f6' : '#a855f7';

                const circle = createCircle(tp.waypoint.lat, tp.waypoint.lon, tp.radius, color);
                taskCircles.push(circle);

                // Create marker
                const markerEl = document.createElement('div');
                markerEl.style.cssText = `
          width: 12px; height: 12px; border-radius: 50%;
          background: ${color}; border: 2px solid white;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        `;

                const marker = new AdvancedMarkerElement({
                    map,
                    position: { lat: tp.waypoint.lat, lng: tp.waypoint.lon },
                    content: markerEl,
                    title: tp.waypoint.name,
                });
                taskMarkers.push(marker);
            }

            // Fit to task if no track
            if (currentFixes.length === 0) {
                const bounds = new google.maps.LatLngBounds();
                for (const tp of task.turnpoints) {
                    bounds.extend({ lat: tp.waypoint.lat, lng: tp.waypoint.lon });
                }
                map.fitBounds(bounds, 50);
            }
        },

        setEvents(events: FlightEvent[]) {
            currentEvents = events;

            // Re-render track with event-based coloring
            if (currentFixes.length > 0) {
                renderTrackWithEvents();
            }

            // Clear existing markers
            for (const marker of eventMarkers) {
                marker.map = null;
            }
            eventMarkers = [];

            // Key event types to show
            const keyEventTypes = new Set([
                'takeoff', 'landing', 'start_crossing', 'goal_crossing',
                'max_altitude', 'turnpoint_entry',
            ]);

            for (const event of events) {
                if (!keyEventTypes.has(event.type)) continue;

                const style = getEventStyle(event.type);

                const markerEl = document.createElement('div');
                markerEl.style.cssText = `
          width: 20px; height: 20px; border-radius: 50%;
          background: ${style.color}; border: 2px solid white;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3); cursor: pointer;
        `;

                const marker = new AdvancedMarkerElement({
                    map,
                    position: { lat: event.latitude, lng: event.longitude },
                    content: markerEl,
                    title: event.description,
                });

                marker.addListener('click', () => {
                    const infoWindow = new google.maps.InfoWindow({
                        content: `<strong>${event.description}</strong><br>
                     <span style="color:#666">${event.time.toLocaleTimeString()}</span>`,
                    });
                    infoWindow.open(map, marker);
                });

                eventMarkers.push(marker);
            }
        },

        panToEvent(event: FlightEvent) {
            // Close existing info window
            if (activeInfoWindow) {
                activeInfoWindow.close();
            }

            // Clear highlight
            if (highlightPath) {
                highlightPath.setMap(null);
                highlightPath = null;
            }

            // Highlight segment if present
            if (event.segment && currentFixes.length > 0) {
                const segmentFixes = currentFixes.slice(event.segment.startIndex, event.segment.endIndex + 1);
                const path = segmentFixes.map(fix => ({ lat: fix.latitude, lng: fix.longitude }));

                highlightPath = new google.maps.Polyline({
                    path,
                    geodesic: true,
                    strokeColor: '#00ffff',
                    strokeOpacity: 0.9,
                    strokeWeight: 6,
                    map,
                });
            }

            // Determine popup location
            let popupLat = event.latitude;
            let popupLng = event.longitude;

            if (event.segment && currentFixes.length > 0) {
                const isStartEvent = event.type === 'thermal_entry' || event.type === 'glide_start';
                const fixIndex = isStartEvent ? event.segment.startIndex : event.segment.endIndex;
                const fix = currentFixes[fixIndex];
                if (fix) {
                    popupLat = fix.latitude;
                    popupLng = fix.longitude;
                }
            }

            // Show info window
            const style = getEventStyle(event.type);
            activeInfoWindow = new google.maps.InfoWindow({
                position: { lat: popupLat, lng: popupLng },
                content: `
          <div style="min-width: 150px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
              <span style="width: 10px; height: 10px; border-radius: 50%; background: ${style.color};"></span>
              <strong>${event.description}</strong>
            </div>
            <div style="color: #94a3b8; font-size: 0.8125rem;">
              ${event.time.toLocaleTimeString()} | ${event.altitude.toFixed(0)}m
            </div>
          </div>
        `,
            });
            activeInfoWindow.open(map);

            // Pan to location
            map.panTo({ lat: event.latitude, lng: event.longitude });
            map.setZoom(14);
        },

        getBounds(): MapBounds {
            const bounds = map.getBounds();
            if (!bounds) {
                return { north: 90, south: -90, east: 180, west: -180 };
            }
            const ne = bounds.getNorthEast();
            const sw = bounds.getSouthWest();
            return {
                north: ne.lat(),
                south: sw.lat(),
                east: ne.lng(),
                west: sw.lng(),
            };
        },

        onBoundsChange(callback: () => void) {
            boundsChangeCallback = callback;
        },

        destroy() {
            for (const segment of trackSegments) segment.setMap(null);
            if (taskLine) taskLine.setMap(null);
            for (const circle of taskCircles) circle.setMap(null);
            for (const marker of taskMarkers) marker.map = null;
            for (const marker of eventMarkers) marker.map = null;
            if (highlightPath) highlightPath.setMap(null);
        },
    };

    return provider;
}
