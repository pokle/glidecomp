/**
 * Leaflet Provider
 * 
 * Leaflet implementation of the MapProvider interface.
 * Handles rendering of flight tracks, task turnpoints, and events.
 */

import type { IGCFix } from './igc-parser';
import type { XCTask } from './xctsk-parser';
import type { FlightEvent } from './event-detector';
import { getEventStyle } from './event-detector';
import type { MapProvider, MapBounds } from './map-provider';

// Leaflet types (loaded dynamically via CDN)
declare const L: any;

/**
 * Load Leaflet from CDN if not already loaded
 */
async function loadLeaflet(): Promise<void> {
    if (typeof L !== 'undefined') {
        return; // Already loaded
    }

    return new Promise((resolve, reject) => {
        // Load CSS
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        cssLink.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
        cssLink.crossOrigin = '';
        document.head.appendChild(cssLink);

        // Load JS
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
        script.crossOrigin = '';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load Leaflet'));
        document.head.appendChild(script);
    });
}

/**
 * Create a circle polygon (approximation) for cylinder rendering
 */
function createCirclePolygon(
    centerLat: number,
    centerLon: number,
    radiusMeters: number,
    numPoints = 64
): [number, number][] {
    const coords: [number, number][] = [];

    for (let i = 0; i <= numPoints; i++) {
        const angle = (i / numPoints) * 2 * Math.PI;

        // Convert radius from meters to degrees (approximate)
        const latOffset = (radiusMeters / 111320) * Math.cos(angle);
        const lonOffset =
            (radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180))) *
            Math.sin(angle);

        coords.push([centerLat + latOffset, centerLon + lonOffset]);
    }

    return coords;
}

/**
 * Create a Leaflet map provider
 */
export async function createLeafletProvider(container: HTMLElement): Promise<MapProvider> {
    await loadLeaflet();

    // Initialize the map
    const map = L.map(container, {
        center: [45, 0],
        zoom: 5,
        zoomControl: true,
    });

    // === BASE LAYERS ===

    // OpenStreetMap (street view)
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });

    // OpenTopoMap (primary topo)
    const openTopoLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    });

    // 4UMaps (alternative topo - similar to OpenTopoMap's alternative)
    const fourUMapsLayer = L.tileLayer('https://tileserver.4umaps.com/{z}/{x}/{y}.png', {
        maxZoom: 15,
        attribution: '&copy; <a href="https://www.4umaps.com">4UMaps</a> | Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });

    // Thunderforest Outdoors (another topo alternative - requires API key for heavy use)
    const outdoorsLayer = L.tileLayer('https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=', {
        maxZoom: 22,
        attribution: '&copy; <a href="https://www.thunderforest.com/">Thunderforest</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });

    // Satellite layer (ESRI)
    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    });

    // Add default layer
    openTopoLayer.addTo(map);

    // Base layers for control
    const baseLayers: Record<string, any> = {
        'OpenTopoMap': openTopoLayer,
        '4UMaps Topo': fourUMapsLayer,
        'Street (OSM)': osmLayer,
        'Satellite (ESRI)': satelliteLayer,
    };

    // Overlay layers (will be populated with GPX files)
    const overlayLayers: Record<string, any> = {};

    // Create layer control (we'll keep a reference to update it)
    let layerControl = L.control.layers(baseLayers, overlayLayers, {
        collapsed: true,
        position: 'topright',
    }).addTo(map);

    // Add scale control
    L.control.scale({ maxWidth: 200, position: 'bottomleft' }).addTo(map);

    // === LOCATE CONTROL ===
    // Custom locate button control
    const LocateControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function () {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            const button = L.DomUtil.create('a', 'leaflet-control-locate', container);
            button.href = '#';
            button.title = 'Show my location';
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin:7px;">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M12 2v4m0 12v4m-10-10h4m12 0h4"></path>
            </svg>`;
            button.style.cssText = 'display:flex;align-items:center;justify-content:center;width:30px;height:30px;cursor:pointer;background:white;';

            L.DomEvent.disableClickPropagation(button);
            L.DomEvent.on(button, 'click', function (e: Event) {
                e.preventDefault();
                map.locate({ setView: true, maxZoom: 14 });
            });

            return container;
        }
    });
    new LocateControl().addTo(map);

    // Handle location found/error
    let locationMarker: any = null;
    let locationCircle: any = null;

    map.on('locationfound', (e: any) => {
        const radius = e.accuracy / 2;

        // Remove previous location marker
        if (locationMarker) map.removeLayer(locationMarker);
        if (locationCircle) map.removeLayer(locationCircle);

        // Add new marker and accuracy circle
        locationMarker = L.marker(e.latlng, {
            icon: L.divIcon({
                className: 'leaflet-location-marker',
                html: '<div style="width:12px;height:12px;background:#3b82f6;border:3px solid white;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>',
                iconSize: [12, 12],
                iconAnchor: [6, 6],
            })
        }).addTo(map);

        locationCircle = L.circle(e.latlng, {
            radius,
            color: '#3b82f6',
            fillColor: '#3b82f6',
            fillOpacity: 0.15,
            weight: 2,
        }).addTo(map);
    });

    map.on('locationerror', (e: any) => {
        console.warn('Location error:', e.message);
        alert('Could not get your location: ' + e.message);
    });

    // === GPX LOADER CONTROL ===
    // Storage for loaded GPX layers
    const gpxLayers: Map<string, any> = new Map();

    // Custom GPX loader button control
    const GpxLoaderControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function () {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
            const button = L.DomUtil.create('a', 'leaflet-control-gpx', container);
            button.href = '#';
            button.title = 'Load GPX file';
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin:7px;">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="12" y1="18" x2="12" y2="12"></line>
                <line x1="9" y1="15" x2="15" y2="15"></line>
            </svg>`;
            button.style.cssText = 'display:flex;align-items:center;justify-content:center;width:30px;height:30px;cursor:pointer;background:white;';

            // Hidden file input
            const fileInput = L.DomUtil.create('input', '', container);
            fileInput.type = 'file';
            fileInput.accept = '.gpx';
            fileInput.multiple = true;
            fileInput.style.display = 'none';

            L.DomEvent.disableClickPropagation(button);
            L.DomEvent.on(button, 'click', function (e: Event) {
                e.preventDefault();
                fileInput.click();
            });

            fileInput.addEventListener('change', async (e: Event) => {
                const input = e.target as HTMLInputElement;
                const files = input.files;
                if (!files) return;

                for (const file of Array.from(files)) {
                    await loadGpxFile(file);
                }

                // Reset input so same file can be loaded again
                input.value = '';
            });

            return container;
        }
    });
    new GpxLoaderControl().addTo(map);

    // Function to parse and display GPX file
    async function loadGpxFile(file: File): Promise<void> {
        const text = await file.text();
        const parser = new DOMParser();
        const gpx = parser.parseFromString(text, 'text/xml');

        // Parse track points
        const trackPoints: [number, number][] = [];
        const trkpts = gpx.querySelectorAll('trkpt');

        for (const trkpt of Array.from(trkpts)) {
            const lat = parseFloat(trkpt.getAttribute('lat') || '0');
            const lon = parseFloat(trkpt.getAttribute('lon') || '0');
            if (lat !== 0 || lon !== 0) {
                trackPoints.push([lat, lon]);
            }
        }

        // Also check for route points (rte/rtept)
        const rtepts = gpx.querySelectorAll('rtept');
        for (const rtept of Array.from(rtepts)) {
            const lat = parseFloat(rtept.getAttribute('lat') || '0');
            const lon = parseFloat(rtept.getAttribute('lon') || '0');
            if (lat !== 0 || lon !== 0) {
                trackPoints.push([lat, lon]);
            }
        }

        // Parse waypoints
        const waypoints: { lat: number; lon: number; name: string }[] = [];
        const wpts = gpx.querySelectorAll('wpt');
        for (const wpt of Array.from(wpts)) {
            const lat = parseFloat(wpt.getAttribute('lat') || '0');
            const lon = parseFloat(wpt.getAttribute('lon') || '0');
            const nameEl = wpt.querySelector('name');
            const name = nameEl?.textContent || '';
            if (lat !== 0 || lon !== 0) {
                waypoints.push({ lat, lon, name });
            }
        }

        if (trackPoints.length === 0 && waypoints.length === 0) {
            alert('No tracks or waypoints found in GPX file');
            return;
        }

        // Create a layer group for this GPX file
        const gpxLayerGroup = L.layerGroup();

        // Random color for this GPX track
        const hue = Math.floor(Math.random() * 360);
        const color = `hsl(${hue}, 70%, 50%)`;

        // Add track polyline
        if (trackPoints.length > 0) {
            const polyline = L.polyline(trackPoints, {
                color,
                weight: 3,
                opacity: 0.9,
            });
            gpxLayerGroup.addLayer(polyline);
        }

        // Add waypoint markers
        for (const wpt of waypoints) {
            const marker = L.marker([wpt.lat, wpt.lon], {
                icon: L.divIcon({
                    className: 'leaflet-gpx-waypoint',
                    html: `<div style="width:10px;height:10px;background:${color};border:2px solid white;border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.3);"></div>`,
                    iconSize: [10, 10],
                    iconAnchor: [5, 5],
                })
            });
            if (wpt.name) {
                marker.bindTooltip(wpt.name, { permanent: false, direction: 'top' });
            }
            gpxLayerGroup.addLayer(marker);
        }

        // Add to map
        gpxLayerGroup.addTo(map);

        // Store reference
        const fileName = file.name;
        gpxLayers.set(fileName, gpxLayerGroup);

        // Update layer control - need to recreate it
        updateLayerControl();

        // Fit bounds to new GPX
        if (trackPoints.length > 0) {
            const bounds = L.latLngBounds(trackPoints);
            map.fitBounds(bounds, { padding: [50, 50] });
        } else if (waypoints.length > 0) {
            const bounds = L.latLngBounds(waypoints.map(w => [w.lat, w.lon]));
            map.fitBounds(bounds, { padding: [50, 50] });
        }
    }

    // Function to update layer control with current GPX layers
    function updateLayerControl(): void {
        // Remove old control
        map.removeControl(layerControl);

        // Build overlay layers
        const overlays: Record<string, any> = {};

        // Add flight track if present
        if (trackSegmentsGroup.getLayers().length > 0) {
            overlays['Flight Track'] = trackSegmentsGroup;
        }

        // Add task if present
        if (taskLayerGroup.getLayers().length > 0) {
            overlays['Task'] = taskLayerGroup;
        }

        // Add event markers if present
        if (eventMarkersGroup.getLayers().length > 0) {
            overlays['Events'] = eventMarkersGroup;
        }

        // Add GPX files
        for (const [name, layer] of gpxLayers) {
            overlays[`📍 ${name}`] = layer;
        }

        // Create new control
        layerControl = L.control.layers(baseLayers, overlays, {
            collapsed: true,
            position: 'topright',
        }).addTo(map);
    }

    // State
    let currentFixes: IGCFix[] = [];
    let currentTask: XCTask | null = null;
    let currentEvents: FlightEvent[] = [];
    const trackSegmentsGroup: any = L.layerGroup().addTo(map);
    const taskLayerGroup: any = L.layerGroup().addTo(map);
    const eventMarkersGroup: any = L.layerGroup().addTo(map);
    let highlightLayer: any = null;
    let glideChevronMarkers: any[] = [];
    let activePopup: any = null;
    let boundsChangeCallback: (() => void) | null = null;

    // Listen for bounds changes
    map.on('moveend', () => {
        if (boundsChangeCallback) {
            boundsChangeCallback();
        }
    });

    /**
     * Get altitude-based color
     * Earthy colors (brown) at low altitude, sky colors (blue) at high altitude
     */
    function getAltitudeColor(altitude: number): string {
        if (altitude < 1000) return '#8D6E63';  // Brown
        if (altitude < 2000) return '#66BB6A';  // Green
        if (altitude < 3000) return '#29B6F6';  // Light Blue
        return '#81D4FA';                        // Sky Blue
    }

    /**
     * Get turnpoint color based on type
     */
    function getTurnpointColor(type: string): string {
        switch (type) {
            case 'SSS': return '#22c55e';
            case 'ESS': return '#eab308';
            case 'TAKEOFF': return '#3b82f6';
            default: return '#a855f7';
        }
    }

    /**
     * Render the track with event-based coloring
     */
    function renderTrackWithEvents(): void {
        // Clear existing track segments
        trackSegmentsGroup.clearLayers();

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
                const latlngs = segmentFixes.map(fix => [fix.latitude, fix.longitude] as [number, number]);

                // Color based on event type
                const color = currentType === 'thermal' ? '#f97316' :  // orange
                    currentType === 'glide' ? '#3b82f6' :     // blue
                        '#9ca3af';                                 // gray (default)

                const polyline = L.polyline(latlngs, {
                    color,
                    weight: 3,
                    opacity: 0.9,
                });
                trackSegmentsGroup.addLayer(polyline);

                segmentStart = i;
                currentType = nextType as string | null;
            }
        }

        // Fit bounds
        const bounds = L.latLngBounds(
            currentFixes.map(fix => [fix.latitude, fix.longitude])
        );
        map.fitBounds(bounds, { padding: [50, 50] });
    }

    const provider: MapProvider = {
        setTrack(fixes: IGCFix[]) {
            currentFixes = fixes;
            renderTrackWithEvents();
            updateLayerControl();
        },

        async setTask(task: XCTask) {
            currentTask = task;

            // Clear existing task elements
            taskLayerGroup.clearLayers();

            if (!task || task.turnpoints.length === 0) return;

            // Create optimized task line that tags cylinder edges
            const { calculateOptimizedTaskLine, getOptimizedSegmentDistances } = await import('./xctsk-parser');
            const optimizedPath = calculateOptimizedTaskLine(task);
            const linePath = optimizedPath.map(p => [p.lat, p.lon] as [number, number]);
            const taskLine = L.polyline(linePath, {
                color: '#6366f1',
                weight: 2,
                opacity: 0.8,
                dashArray: '8, 8',
            });
            taskLayerGroup.addLayer(taskLine);

            // Add distance labels to each segment
            const segmentDistances = getOptimizedSegmentDistances(task);
            for (let i = 0; i < optimizedPath.length - 1; i++) {
                const p1 = optimizedPath[i];
                const p2 = optimizedPath[i + 1];
                const distance = segmentDistances[i];

                // Calculate midpoint
                const midLat = (p1.lat + p2.lat) / 2;
                const midLng = (p1.lon + p2.lon) / 2;

                // Create distance label
                const distanceKm = (distance / 1000).toFixed(1);
                const legNumber = i + 1;
                const labelIcon = L.divIcon({
                    className: 'leaflet-distance-label',
                    html: `<div style="
                        background: white;
                        padding: 2px 6px;
                        border-radius: 4px;
                        font-size: 11px;
                        font-weight: 600;
                        color: #6366f1;
                        border: 1px solid #6366f1;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                        white-space: nowrap;
                    ">Leg ${legNumber}: ${distanceKm}km</div>`,
                    iconSize: [100, 20],
                    iconAnchor: [50, 10],
                });
                const labelMarker = L.marker([midLat, midLng], { icon: labelIcon, interactive: false });
                taskLayerGroup.addLayer(labelMarker);
            }

            // Create cylinders and markers
            for (let tpIdx = 0; tpIdx < task.turnpoints.length; tpIdx++) {
                const tp = task.turnpoints[tpIdx];
                const color = getTurnpointColor(tp.type || '');

                // Create circle (cylinder)
                const circle = L.circle([tp.waypoint.lat, tp.waypoint.lon], {
                    radius: tp.radius,
                    color,
                    weight: 2,
                    opacity: 0.8,
                    fillColor: color,
                    fillOpacity: 0.15,
                });
                taskLayerGroup.addLayer(circle);

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
                const markerIcon = L.divIcon({
                    className: 'leaflet-task-marker',
                    html: `<div style="
                        width: 12px; 
                        height: 12px; 
                        border-radius: 50%;
                        background: ${color}; 
                        border: 2px solid white;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                    "></div>`,
                    iconSize: [12, 12],
                    iconAnchor: [6, 6],
                });
                const marker = L.marker([tp.waypoint.lat, tp.waypoint.lon], { icon: markerIcon })
                    .bindTooltip(label, {
                        permanent: false,
                        direction: 'top',
                    });
                taskLayerGroup.addLayer(marker);
            }

            // Fit to task if no track
            if (currentFixes.length === 0) {
                const bounds = L.latLngBounds(
                    task.turnpoints.map(tp => [tp.waypoint.lat, tp.waypoint.lon])
                );
                map.fitBounds(bounds, { padding: [50, 50] });
            }
            updateLayerControl();
        },

        setEvents(events: FlightEvent[]) {
            currentEvents = events;

            // Re-render track with event-based coloring
            if (currentFixes.length > 0) {
                renderTrackWithEvents();
            }

            // Clear existing markers
            eventMarkersGroup.clearLayers();

            // Key event types to show
            const keyEventTypes = new Set([
                'takeoff', 'landing', 'start_crossing', 'goal_crossing',
                'max_altitude', 'turnpoint_entry',
            ]);

            for (const event of events) {
                if (!keyEventTypes.has(event.type)) continue;

                const style = getEventStyle(event.type);

                const markerIcon = L.divIcon({
                    className: 'leaflet-event-marker',
                    html: `<div style="
                        width: 20px; 
                        height: 20px; 
                        border-radius: 50%;
                        background: ${style.color}; 
                        border: 2px solid white;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                        cursor: pointer;
                    "></div>`,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10],
                });

                const marker = L.marker([event.latitude, event.longitude], { icon: markerIcon })
                    .bindPopup(`<strong>${event.description}</strong><br>
                        <span style="color:#666">${event.time.toLocaleTimeString()}</span>`);
                eventMarkersGroup.addLayer(marker);
            }
            updateLayerControl();
        },

        panToEvent(event: FlightEvent) {
            // Close existing popup
            if (activePopup) {
                map.closePopup(activePopup);
                activePopup = null;
            }

            // Clear highlight and glide chevrons
            if (highlightLayer) {
                map.removeLayer(highlightLayer);
                highlightLayer = null;
            }
            for (const marker of glideChevronMarkers) {
                map.removeLayer(marker);
            }
            glideChevronMarkers = [];

            // Highlight segment if present
            if (event.segment && currentFixes.length > 0) {
                const segmentFixes = currentFixes.slice(event.segment.startIndex, event.segment.endIndex + 1);
                const latlngs = segmentFixes.map(fix => [fix.latitude, fix.longitude] as [number, number]);

                highlightLayer = L.polyline(latlngs, {
                    color: '#00ffff',
                    weight: 6,
                    opacity: 0.9,
                }).addTo(map);

                // For glide events, add direction chevrons every ~500m
                if (event.type === 'glide_start' || event.type === 'glide_end') {
                    const CHEVRON_INTERVAL = 500; // meters
                    
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
                            const chevronIcon = L.divIcon({
                                className: 'leaflet-glide-chevron',
                                html: `<svg width="20" height="12" viewBox="0 0 20 12" style="transform: rotate(${bearing}deg);">
                                    <path d="M2 10 L10 2 L18 10" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>`,
                                iconSize: [20, 12],
                                iconAnchor: [10, 6],
                            });
                            const chevronMarker = L.marker([chevronLat, chevronLon], { icon: chevronIcon, interactive: false }).addTo(map);
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

            // Show popup
            const style = getEventStyle(event.type);
            activePopup = L.popup({ closeOnClick: false })
                .setLatLng([popupLat, popupLng])
                .setContent(`
                    <div style="min-width: 150px; color: #1e293b;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                            <span style="width: 10px; height: 10px; border-radius: 50%; background: ${style.color};"></span>
                            <strong>${event.description}</strong>
                        </div>
                        <div style="color: #64748b; font-size: 0.8125rem;">
                            ${event.time.toLocaleTimeString()} | ${event.altitude.toFixed(0)}m
                        </div>
                    </div>
                `)
                .openOn(map);

            // Pan to location (preserve current zoom level)
            map.setView([event.latitude, event.longitude], map.getZoom(), {
                animate: true,
                duration: 1,
            });
        },

        getBounds(): MapBounds {
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
            trackSegmentsGroup.clearLayers();
            taskLayerGroup.clearLayers();
            eventMarkersGroup.clearLayers();
            if (highlightLayer) {
                map.removeLayer(highlightLayer);
            }
            map.remove();
        },

        invalidateSize() {
            map.invalidateSize();
        },
    };

    return provider;
}
