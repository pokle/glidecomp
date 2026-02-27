/**
 * Render flight event markers on Windy's Leaflet map.
 *
 * Shows key events (takeoff, landing, thermals, max altitude, etc.)
 * as small colored circle markers with popups.
 */
import type { FlightEvent } from '@taskscore/engine';
import { getEventStyle } from '@taskscore/engine';

/** Event types worth showing on the map (skip noisy segment-boundary events). */
const MAP_EVENT_TYPES = new Set([
    'takeoff',
    'landing',
    'max_altitude',
    'min_altitude',
    'max_climb',
    'max_sink',
    'thermal_entry',
    'start_crossing',
    'goal_crossing',
    'turnpoint_reaching',
    'ess_reaching',
    'goal_reaching',
]);

/**
 * Render key flight events as circle markers with popups.
 * Returns the markers for cleanup.
 */
export function renderEventMarkers(
    map: L.Map,
    events: FlightEvent[],
): L.CircleMarker[] {
    const markers: L.CircleMarker[] = [];

    for (const event of events) {
        if (!MAP_EVENT_TYPES.has(event.type)) continue;

        const style = getEventStyle(event.type);
        const marker = new L.CircleMarker(
            { lat: event.latitude, lng: event.longitude },
            {
                radius: 5,
                color: style.color,
                fillColor: style.color,
                fillOpacity: 0.8,
                weight: 2,
            },
        ).addTo(map);

        const time = event.time.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        marker.bindPopup(
            `<b>${event.description}</b><br/>` +
            `${time} · ${Math.round(event.altitude)}m`,
        );

        markers.push(marker);
    }

    return markers;
}

/** Remove all event markers from the map. */
export function removeEventMarkers(map: L.Map, markers: L.CircleMarker[]): void {
    for (const m of markers) {
        map.removeLayer(m);
    }
}
