/**
 * Map Provider Interface
 *
 * Abstraction layer for map visualization.
 * Supports MapBox GL JS and Leaflet 2.0 providers.
 */

import type { IGCFix, XCTask, FlightEvent } from '@taskscore/engine';

export type MapProviderType = 'mapbox' | 'leaflet';

/**
 * Interaction mode for the map. Controls which click/hover handlers are active.
 * - 'view': default mode — track clicks, turnpoint clicks, hover cursors all active
 * - 'add-waypoint': task editor map-click mode — crosshair cursor, all other clicks suppressed
 */
export type MapInteractionMode = 'view' | 'add-waypoint';

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

    /** Clear the flight track from the map */
    clearTrack(): void;

    /** Render task turnpoints and cylinders */
    setTask(task: XCTask): Promise<void>;

    /** Clear the task from the map */
    clearTask(): void;

    /** Render event markers on the map */
    setEvents(events: FlightEvent[]): void;

    /** Clear event markers from the map */
    clearEvents(): void;

    /** Pan to and highlight an event location. If skipPan is true, only highlights without panning. */
    panToEvent(event: FlightEvent, options?: { skipPan?: boolean }): void;

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

    /** Show/hide task visualization (cylinders, lines, labels) */
    setTaskVisibility?(visible: boolean): void;

    /** Show/hide track visualization */
    setTrackVisibility?(visible: boolean): void;

    /** Whether this provider supports the speed overlay (all-glide chevrons/labels) */
    supportsSpeedOverlay?: boolean;

    /** Enable/disable speed overlay for all glide segments */
    setSpeedOverlay?(enabled: boolean): void;

    /** Register callback for when user clicks on the track */
    onTrackClick?(callback: (fixIndex: number) => void): void;

    /** Register callback for when user clicks on a task turnpoint */
    onTurnpointClick?(callback: (turnpointIndex: number) => void): void;

    /** Pan to a turnpoint center without changing zoom */
    panToTurnpoint?(turnpointIndex: number): void;

    /** Show a HUD overlay with metrics for a non-glide track point */
    showTrackPointHUD?(fixIndex: number): void;

    /** Hide the track point HUD overlay */
    hideTrackPointHUD?(): void;

    /** Register callback for menu button click (native map control) */
    onMenuButtonClick?(callback: () => void): void;

    /** Register callback for panel toggle button click (native map control) */
    onPanelToggleClick?(callback: () => void): void;

    /** Register callback for map click (used by task editor to add waypoints) */
    onMapClick?(callback: (lat: number, lon: number) => void): void;

    /** Set the active interaction mode (controls which click/hover handlers fire) */
    setInteractionMode?(mode: MapInteractionMode): void;
}

/**
 * Factory function to create a map provider.
 * Uses dynamic import so only the selected provider's code is bundled.
 */
export async function createMapProvider(
    container: HTMLElement,
    providerType: MapProviderType = 'mapbox'
): Promise<MapProvider> {
    if (providerType === 'leaflet') {
        const { createLeafletProvider } = await import('./leaflet-provider');
        return createLeafletProvider(container);
    }
    const { createMapBoxProvider } = await import('./mapbox-provider');
    return createMapBoxProvider(container);
}
