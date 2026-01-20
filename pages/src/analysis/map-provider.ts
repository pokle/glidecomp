/**
 * Map Provider Interface
 *
 * Abstraction layer for map visualization using MapBox GL JS.
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
 * Map provider interface
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
 * Factory function to create the MapBox map provider
 */
export async function createMapProvider(container: HTMLElement): Promise<MapProvider> {
    const { createMapBoxProvider } = await import('./mapbox-provider');
    return createMapBoxProvider(container);
}
