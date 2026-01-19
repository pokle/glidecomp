/**
 * Map Provider Interface
 *
 * Abstraction layer allowing multiple map libraries (Leaflet, MapBox)
 * to be used interchangeably for flight visualization.
 *
 * Note: This file is kept for backwards compatibility with the legacy main.ts.
 * The React components (LeafletMap.tsx and MapboxMap.tsx) handle map rendering directly.
 */

import type { IGCFix } from './igc-parser';
import type { XCTask } from './xctsk-parser';
import type { FlightEvent } from './event-detector';

/**
 * Bounds in degrees
 */
export interface MapBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

/**
 * Map provider interface - all map implementations must conform to this
 */
export interface MapProvider {
    /** Render flight track on the map */
    setTrack(fixes: IGCFix[]): void;

    /** Render task turnpoints and cylinders */
    setTask(task: XCTask): Promise<void>;

    /** Render event markers on the map */
    setEvents(events: FlightEvent[]): void;

    /** Pan to and highlight an event location */
    panToEvent(event: FlightEvent): void;

    /** Get current visible bounds */
    getBounds(): MapBounds;

    /** Register callback for when map bounds change */
    onBoundsChange(callback: () => void): void;

    /** Clean up resources */
    destroy(): void;

    /** Tell the map to resize/redraw (call after container size changes) */
    invalidateSize(): void;

    /** Whether this provider supports 3D track rendering */
    supports3D?: boolean;

    /** Enable/disable 3D track rendering (only available if supports3D is true) */
    set3DMode?(enabled: boolean): void;

    /** Whether this provider supports altitude-based color gradient */
    supportsAltitudeColors?: boolean;

    /** Enable/disable altitude-based color gradient (only available if supportsAltitudeColors is true) */
    setAltitudeColors?(enabled: boolean): void;
}

/**
 * Available map provider types
 */
export type MapProviderType = 'leaflet' | 'mapbox';

/**
 * Factory function to create a map provider
 * @deprecated Use React components LeafletMap or MapboxMap instead
 */
export async function createMapProvider(
    type: MapProviderType,
    container: HTMLElement
): Promise<MapProvider> {
    switch (type) {
        case 'leaflet': {
            const { createLeafletProvider } = await import('./leaflet-provider');
            return createLeafletProvider(container);
        }
        case 'mapbox': {
            const { createMapBoxProvider } = await import('./mapbox-provider');
            return createMapBoxProvider(container);
        }
        default:
            throw new Error(`Unknown map provider: ${type}`);
    }
}

/**
 * Get provider type from URL query params
 * ?m=l for leaflet, ?m=b for mapbox
 * Defaults to 'leaflet' if not specified
 */
export function getProviderFromUrl(): MapProviderType {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('m');

    if (provider === 'b') return 'mapbox';
    return 'leaflet';
}

/**
 * Get the short code for a provider type
 */
export function getProviderCode(type: MapProviderType): string {
    if (type === 'mapbox') return 'b';
    return 'l';
}
