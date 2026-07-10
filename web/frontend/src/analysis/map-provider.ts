/**
 * Map Provider Interface
 *
 * Abstraction layer for map visualization.
 * Supports MapBox GL JS and Leaflet 2.0 providers.
 */

import type { IGCFix, XCTask, FlightEvent, PilotScore } from '@glidecomp/engine';
import type { MapAnnotationLayer } from './map-annotations';

/** A loaded track with metadata for multi-track display */
export interface LoadedTrack {
    pilotName: string;
    date: Date | null;
    filename: string;
    fixes: IGCFix[];
    events: FlightEvent[];
}

export type MapProviderType = 'mapbox' | 'leaflet';

/** One pilot's scored open-distance line: take-off cylinder exit → furthest fix */
export interface OpenDistanceLine {
    pilotName: string;
    origin: { lat: number; lon: number };
    end: { lat: number; lon: number };
    /** Scored straight-line distance in metres (drawn as the line's label) */
    distance: number;
}

/**
 * A landed-out pilot's routed "distance to goal" line: the best-progress
 * point, through each un-reached turnpoint's optimal tag point, to goal.
 * Drawn so the "measured along the task / X km short of goal" wording is
 * visible on the map rather than implied by a lone pin.
 */
export interface BestProgressRoute {
    /** Ordered polyline vertices: [best-progress point, …tag points, goal]. */
    coords: { lat: number; lon: number }[];
    /** Remaining routed distance to goal in metres (drawn as the line's label). */
    distanceToGoal: number;
}

/**
 * Interaction mode for the map. Controls which click/hover handlers are active.
 * - 'view': default mode — track clicks, turnpoint clicks, hover cursors all active
 * - 'add-waypoint': task editor map-click mode — crosshair cursor, all other clicks suppressed
 */
export type MapInteractionMode = 'view' | 'add-waypoint';

/**
 * A pickable waypoint marker for the task route editor. Loaded from a
 * competition waypoint file and drawn as a small clickable dot the user can
 * pick to add as a turnpoint. `id` is opaque to the provider — it's echoed
 * back through onWaypointClick so the caller can resolve the source record.
 */
export interface MapWaypoint {
    id: string;
    name: string;
    lat: number;
    lon: number;
}

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

    /** Render task turnpoints and cylinders. By default fits the view to the
     *  task when no track is loaded; pass `{ fit: false }` to leave the current
     *  view alone (the route editor uses this so live edits don't re-zoom). */
    setTask(task: XCTask, options?: { fit?: boolean }): Promise<void>;

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

    // ── Editable waypoint markers (task route editor) ──

    /** Draw pickable waypoint markers (loaded from a waypoint file). Replaces
     *  any previously drawn set. Markers stay clickable in every interaction
     *  mode so they can be picked while add-waypoint (map-click) mode is on. */
    setWaypoints?(waypoints: MapWaypoint[]): void;

    /** Clear all pickable waypoint markers */
    clearWaypoints?(): void;

    /** Fit the view to the currently-set waypoint markers (used after loading
     *  a waypoint file so the whole set is visible). No-op if none are set. */
    fitToWaypoints?(): void;

    /** Register callback for when the user clicks a pickable waypoint marker */
    onWaypointClick?(callback: (waypoint: MapWaypoint) => void): void;

    /** Pulse/glow the panel toggle button to draw attention (e.g. after flight load) */
    highlightPanelToggle?(): void;

    /** Throb the menu button to draw attention (e.g. on initial page load) */
    highlightMenuButton?(): void;

    /** Get the annotation layer for direct control (Mapbox only) */
    getAnnotationLayer?(): MapAnnotationLayer | null;

    // ── Multi-track support ──

    /** Render multiple tracks on the map, colored by rank (orange=leader, grey=last) */
    setMultiTrack?(tracks: LoadedTrack[], pilotScores: PilotScore[]): void;

    /** Clear all multi-track rendering */
    clearMultiTrack?(): void;

    /** Register callback for when user clicks on a track in multi-track mode.
     *  Returns the track index and fix index. */
    onMultiTrackClick?(callback: (trackIndex: number, fixIndex: number) => void): void;

    /** Show pilot name in HUD */
    showTrackPointHUDWithName?(fixIndex: number, pilotName: string): void;

    // ── Open distance support ──

    /** Draw scored open-distance lines (take-off exit → furthest fix), each
     *  annotated with its distance. Replaces any previously drawn lines. */
    setOpenDistanceLines?(lines: OpenDistanceLine[]): void;

    /** Clear all open-distance lines */
    clearOpenDistanceLines?(): void;

    // ── Best-progress (landout) route support ──

    /** Draw a landed-out pilot's routed distance-to-goal line (best-progress
     *  point → un-reached turnpoints → goal), labelled with the remaining
     *  distance. Replaces any previously drawn route. */
    setBestProgressRoute?(route: BestProgressRoute): void;

    /** Clear the best-progress route line */
    clearBestProgressRoute?(): void;
}

/** Options shared by both provider factories. */
export interface MapProviderOptions {
    /**
     * Add the analysis-app chrome (menu + panel-toggle buttons). Default
     * true; embedders like the score-details page pass false to get a plain
     * map with only the standard navigation controls.
     */
    appControls?: boolean;
}

/**
 * Factory function to create a map provider.
 * Uses dynamic import so only the selected provider's code is bundled.
 */
export async function createMapProvider(
    container: HTMLElement,
    providerType: MapProviderType = 'mapbox',
    options: MapProviderOptions = {}
): Promise<MapProvider> {
    if (providerType === 'leaflet') {
        const { createLeafletProvider } = await import('./leaflet-provider');
        return createLeafletProvider(container, options);
    }
    const { createMapBoxProvider } = await import('./mapbox-provider');
    return createMapBoxProvider(container, options);
}
