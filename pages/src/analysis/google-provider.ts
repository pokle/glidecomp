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
    let taskSegmentLabels: any[] = [];  // Labels for task line segments
    let eventMarkers: any[] = [];
    let highlightPath: any = null;
    let glideChevronMarkers: any[] = [];
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

        async setTask(task: XCTask) {
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
            for (const label of taskSegmentLabels) {
                label.map = null;
            }
            taskSegmentLabels = [];

            if (!task || task.turnpoints.length === 0) return;

            // Create optimized task line that tags cylinder edges
            const { calculateOptimizedTaskLine, getOptimizedSegmentDistances } = await import('./xctsk-parser');
            const optimizedPath = calculateOptimizedTaskLine(task);
            const linePath = optimizedPath.map(p => ({
                lat: p.lat,
                lng: p.lon,
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

            // Add distance labels to each segment
            const segmentDistances = getOptimizedSegmentDistances(task);
            for (let i = 0; i < optimizedPath.length - 1; i++) {
                const p1 = optimizedPath[i];
                const p2 = optimizedPath[i + 1];
                const distance = segmentDistances[i];

                // Calculate midpoint
                const midLat = (p1.lat + p2.lat) / 2;
                const midLng = (p1.lon + p2.lon) / 2;

                // Create label element
                const labelEl = document.createElement('div');
                const distanceKm = (distance / 1000).toFixed(1);
                const legNumber = i + 1;
                labelEl.style.cssText = `
                    background: white;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 11px;
                    font-weight: 600;
                    color: #6366f1;
                    border: 1px solid #6366f1;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                    white-space: nowrap;
                `;
                labelEl.textContent = `Leg ${legNumber}: ${distanceKm}km`;

                const labelMarker = new AdvancedMarkerElement({
                    map,
                    position: { lat: midLat, lng: midLng },
                    content: labelEl,
                });
                taskSegmentLabels.push(labelMarker);
            }

            // Create cylinders and markers
            for (let tpIdx = 0; tpIdx < task.turnpoints.length; tpIdx++) {
                const tp = task.turnpoints[tpIdx];
                const color = tp.type === 'SSS' ? '#22c55e' :
                    tp.type === 'ESS' ? '#eab308' :
                        tp.type === 'TAKEOFF' ? '#3b82f6' : '#a855f7';

                const circle = createCircle(tp.waypoint.lat, tp.waypoint.lon, tp.radius, color);
                taskCircles.push(circle);

                // Build turnpoint label: "NAME, R Xkm, A Ym, ROLE" (with non-breaking spaces)
                const name = tp.waypoint.name || `TP${tpIdx + 1}`;
                const radiusKm = (tp.radius / 1000).toFixed(tp.radius >= 1000 ? 0 : 1);
                const altitude = tp.waypoint.altSmoothed ? `A\u00A0${Math.round(tp.waypoint.altSmoothed)}m` : '';
                const role = tp.type || '';
                const labelParts = [name, `R\u00A0${radiusKm}km`];
                if (altitude) labelParts.push(altitude);
                if (role) labelParts.push(role);
                const label = labelParts.join(', ');

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
                    title: label,
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
                     ${event.time.toLocaleTimeString()}`,
                    });
                    infoWindow.open(map, marker);
                });

                eventMarkers.push(marker);
            }
        },

        async panToEvent(event: FlightEvent) {
            // Close existing info window
            if (activeInfoWindow) {
                activeInfoWindow.close();
            }

            // Clear highlight and glide chevrons
            if (highlightPath) {
                highlightPath.setMap(null);
                highlightPath = null;
            }
            for (const marker of glideChevronMarkers) {
                marker.map = null;
            }
            glideChevronMarkers = [];

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

                // For glide events, add direction chevrons every ~500m
                if (event.type === 'glide_start' || event.type === 'glide_end') {
                    const CHEVRON_INTERVAL = 500; // meters
                    const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
                    
                    // Calculate cumulative distances along the glide
                    let cumulativeDistance = 0;
                    let nextChevronDistance = CHEVRON_INTERVAL;
                    
                    for (let i = 1; i < segmentFixes.length; i++) {
                        const prevFix = segmentFixes[i - 1];
                        const currFix = segmentFixes[i];
                        
                        // Haversine distance
                        const R = 6371000; // Earth radius in meters
                        const dLat = (currFix.latitude - prevFix.latitude) * Math.PI / 180;
                        const dLon = (currFix.longitude - prevFix.longitude) * Math.PI / 180;
                        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(prevFix.latitude * Math.PI / 180) * Math.cos(currFix.latitude * Math.PI / 180) *
                            Math.sin(dLon / 2) * Math.sin(dLon / 2);
                        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                        const segmentDistance = R * c;
                        
                        cumulativeDistance += segmentDistance;
                        
                        // Place chevrons at each 500m interval
                        while (cumulativeDistance >= nextChevronDistance) {
                            // Interpolate position along the segment
                            const overshoot = cumulativeDistance - nextChevronDistance;
                            const t = 1 - (overshoot / segmentDistance);
                            const chevronLat = prevFix.latitude + t * (currFix.latitude - prevFix.latitude);
                            const chevronLon = prevFix.longitude + t * (currFix.longitude - prevFix.longitude);
                            
                            // Calculate local bearing at this point
                            const bearingDLon = (currFix.longitude - prevFix.longitude) * Math.PI / 180;
                            const lat1 = prevFix.latitude * Math.PI / 180;
                            const lat2 = currFix.latitude * Math.PI / 180;
                            const y = Math.sin(bearingDLon) * Math.cos(lat2);
                            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(bearingDLon);
                            const bearing = Math.atan2(y, x) * 180 / Math.PI;
                            
                            // Create chevron marker
                            const chevronEl = document.createElement('div');
                            chevronEl.innerHTML = `<svg width="20" height="12" viewBox="0 0 20 12" style="transform: rotate(${bearing}deg);">
                                <path d="M2 10 L10 2 L18 10" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>`;
                            
                            const chevronMarker = new AdvancedMarkerElement({
                                map,
                                position: { lat: chevronLat, lng: chevronLon },
                                content: chevronEl,
                            });
                            glideChevronMarkers.push(chevronMarker);
                            
                            nextChevronDistance += CHEVRON_INTERVAL;
                        }
                    }
                }
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
          <div style="min-width: 150px; color: #1e293b;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
              <span style="width: 10px; height: 10px; border-radius: 50%; background: ${style.color};"></span>
              <strong>${event.description}</strong>
            </div>
            <div style="color: #64748b; font-size: 0.8125rem;">
              ${event.time.toLocaleTimeString()} | ${event.altitude.toFixed(0)}m
            </div>
          </div>
        `,
            });
            activeInfoWindow.open(map);

            // Pan to location (preserve current zoom level)
            map.panTo({ lat: event.latitude, lng: event.longitude });
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

        invalidateSize() {
            google.maps.event.trigger(map, 'resize');
        },
    };

    return provider;
}
