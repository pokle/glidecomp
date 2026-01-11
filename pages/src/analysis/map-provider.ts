/**
 * Map Provider Interface
 * 
 * Abstraction layer allowing multiple map libraries (MapLibre, Google Maps)
 * to be used interchangeably for flight visualization.
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
    setTask(task: XCTask): void;

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
}

/**
 * Available map provider types
 */
export type MapProviderType = 'maplibre' | 'google';

/**
 * Factory function to create a map provider
 */
export async function createMapProvider(
    type: MapProviderType,
    container: HTMLElement
): Promise<MapProvider> {
    switch (type) {
        case 'maplibre': {
            const { createMapLibreProvider } = await import('./maplibre-provider');
            return createMapLibreProvider(container);
        }
        case 'google': {
            const { createGoogleMapsProvider } = await import('./google-provider');
            return createGoogleMapsProvider(container);
        }
        default:
            throw new Error(`Unknown map provider: ${type}`);
    }
}

/**
 * Get provider type from URL query params
 * Defaults to 'maplibre' if not specified
 */
export function getProviderFromUrl(): MapProviderType {
    const params = new URLSearchParams(window.location.search);
    const provider = params.get('provider');

    if (provider === 'google') return 'google';
    return 'maplibre';
}
