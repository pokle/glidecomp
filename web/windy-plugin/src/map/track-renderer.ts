/**
 * Render a flight track on Windy's Leaflet map.
 *
 * Draws the track as a polyline colored by altitude — blue (low) to red (high).
 * Returns the polyline so it can be removed on plugin destroy.
 */
import type { IGCFix } from '@taskscore/engine';

/** Interpolate a color between blue (low) and red (high) based on t ∈ [0, 1]. */
function altitudeColor(t: number): string {
    // blue → cyan → green → yellow → red
    const r = Math.round(t < 0.5 ? 0 : (t - 0.5) * 2 * 255);
    const g = Math.round(t < 0.5 ? t * 2 * 255 : (1 - t) * 2 * 255);
    const b = Math.round(t < 0.5 ? (1 - t * 2) * 255 : 0);
    return `rgb(${r},${g},${b})`;
}

/**
 * Render a flight track as a series of short polyline segments colored by altitude.
 * Returns an array of L.Polyline that should be removed on cleanup.
 */
export function renderTrack(
    map: L.Map,
    fixes: IGCFix[],
): L.Polyline[] {
    if (fixes.length < 2) return [];

    const altitudes = fixes.map(f => f.pressureAltitude ?? f.gpsAltitude);
    const minAlt = Math.min(...altitudes);
    const maxAlt = Math.max(...altitudes);
    const range = maxAlt - minAlt || 1;

    const lines: L.Polyline[] = [];

    // Draw segments in batches of ~20 fixes per polyline to balance
    // color granularity vs Leaflet layer count.
    const batchSize = 20;
    for (let i = 0; i < fixes.length - 1; i += batchSize) {
        const end = Math.min(i + batchSize + 1, fixes.length);
        const slice = fixes.slice(i, end);
        const midIdx = Math.floor(slice.length / 2);
        const midAlt = altitudes[i + midIdx];
        const t = (midAlt - minAlt) / range;

        const latLngs = slice.map(f => ({ lat: f.latitude, lng: f.longitude }));
        const line = new L.Polyline(latLngs, {
            color: altitudeColor(t),
            weight: 3,
            opacity: 0.85,
        }).addTo(map);

        lines.push(line);
    }

    return lines;
}

/** Remove all track polylines from the map. */
export function removeTrack(map: L.Map, lines: L.Polyline[]): void {
    for (const line of lines) {
        map.removeLayer(line);
    }
}
