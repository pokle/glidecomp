/**
 * Render task turnpoints on Windy's Leaflet map.
 *
 * Draws cylinders as circles, connects turnpoints with a dashed line,
 * and labels each turnpoint. Returns all layers for cleanup.
 */
import type { XCTask, Turnpoint } from '@taskscore/engine';
import { getCirclePoints } from '@taskscore/engine';

export interface TaskLayers {
    circles: L.Circle[];
    labels: L.Marker[];
    line: L.Polyline | null;
}

const TP_COLORS: Record<string, string> = {
    TAKEOFF: '#22c55e',
    SSS: '#f97316',
    ESS: '#dc2626',
    GOAL: '#eab308',
};

function turnpointColor(tp: Turnpoint, index: number, total: number): string {
    if (index === 0) return TP_COLORS.TAKEOFF;
    if (tp.type === 'SSS' || tp.type === 'SPEED_SECTION_START') return TP_COLORS.SSS;
    if (tp.type === 'ESS' || tp.type === 'SPEED_SECTION_END') return TP_COLORS.ESS;
    if (index === total - 1) return TP_COLORS.GOAL;
    return '#a855f7'; // intermediate
}

/**
 * Render an XCTask on the map: cylinders, dashed connection line, labels.
 */
export function renderTask(map: L.Map, task: XCTask): TaskLayers {
    const tps = task.turnpoints;
    const circles: L.Circle[] = [];
    const labels: L.Marker[] = [];

    // Dashed line connecting turnpoint centers
    const centers = tps.map(tp => ({
        lat: tp.waypoint.lat,
        lng: tp.waypoint.lon,
    }));
    const line = new L.Polyline(centers, {
        color: '#ffffff',
        weight: 2,
        opacity: 0.6,
        dashArray: '8 6',
    }).addTo(map);

    for (let i = 0; i < tps.length; i++) {
        const tp = tps[i];
        const color = turnpointColor(tp, i, tps.length);
        const { lat, lon } = tp.waypoint;

        // Cylinder
        const circle = new L.Circle({ lat, lng: lon }, {
            radius: tp.radius,
            color,
            weight: 2,
            opacity: 0.7,
            fillColor: color,
            fillOpacity: 0.1,
        }).addTo(map);
        circles.push(circle);

        // Label
        const icon = new L.DivIcon({
            className: 'tp-label',
            html: `<span style="
                background:${color};
                color:#fff;
                padding:2px 6px;
                border-radius:3px;
                font-size:11px;
                font-weight:600;
                white-space:nowrap;
            ">${tp.waypoint.name || `TP${i}`}</span>`,
            iconAnchor: [0, -12],
        });
        const label = new L.Marker({ lat, lng: lon }, { icon }).addTo(map);
        labels.push(label);
    }

    return { circles, labels, line };
}

/** Remove all task layers from the map. */
export function removeTask(map: L.Map, layers: TaskLayers): void {
    for (const c of layers.circles) map.removeLayer(c);
    for (const l of layers.labels) map.removeLayer(l);
    if (layers.line) map.removeLayer(layers.line);
}
