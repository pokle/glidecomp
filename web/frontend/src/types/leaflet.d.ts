/**
 * Minimal type declarations for Leaflet 2.0.0-alpha.1
 * Covers the API surface used by leaflet-provider.ts
 */
declare module 'leaflet' {
  export type LatLngExpression = [number, number] | LatLng | { lat: number; lng: number };
  export type PointExpression = [number, number] | Point;
  export type LatLngBoundsExpression = LatLngBounds | [LatLngExpression, LatLngExpression];

  export class LatLng {
    lat: number;
    lng: number;
    constructor(lat: number, lng: number);
  }

  export class Point {
    x: number;
    y: number;
    constructor(x: number, y: number);
  }

  export class LatLngBounds {
    constructor(southWest: LatLngExpression, northEast: LatLngExpression);
    extend(latlng: LatLngExpression): this;
    isValid(): boolean;
    getNorth(): number;
    getSouth(): number;
    getEast(): number;
    getWest(): number;
    getNorthEast(): LatLng;
    getSouthWest(): LatLng;
    getCenter(): LatLng;
    pad(bufferRatio: number): LatLngBounds;
  }

  export interface MapOptions {
    center?: LatLngExpression;
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    preferCanvas?: boolean;
    zoomControl?: boolean;
    attributionControl?: boolean;
  }

  export class Evented {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(type: string, fn: (...args: any[]) => void, context?: unknown): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off(type: string, fn?: (...args: any[]) => void, context?: unknown): this;
    fire(type: string, data?: unknown): this;
  }

  export class Layer extends Evented {
    addTo(map: LeafletMap | LayerGroup): this;
    remove(): this;
    removeFrom(map: LeafletMap | LayerGroup): this;
  }

  export class LeafletMap extends Evented {
    constructor(element: HTMLElement | string, options?: MapOptions);
    setView(center: LatLngExpression, zoom?: number, options?: { animate?: boolean; duration?: number }): this;
    flyTo(latlng: LatLngExpression, zoom?: number, options?: { duration?: number }): this;
    panTo(latlng: LatLngExpression, options?: { animate?: boolean; duration?: number }): this;
    fitBounds(bounds: LatLngBoundsExpression, options?: { padding?: PointExpression; maxZoom?: number; animate?: boolean; duration?: number }): this;
    getBounds(): LatLngBounds;
    getCenter(): LatLng;
    getZoom(): number;
    setZoom(zoom: number): this;
    addLayer(layer: Layer): this;
    removeLayer(layer: Layer): this;
    hasLayer(layer: Layer): boolean;
    addControl(control: Control): this;
    removeControl(control: Control): this;
    remove(): this;
    invalidateSize(options?: { animate?: boolean }): this;
    getContainer(): HTMLElement;
    latLngToContainerPoint(latlng: LatLngExpression): Point;
  }

  export { LeafletMap as Map };

  export interface TileLayerOptions {
    attribution?: string;
    maxZoom?: number;
    minZoom?: number;
    subdomains?: string | string[];
    opacity?: number;
  }

  export class TileLayer extends Layer {
    constructor(urlTemplate: string, options?: TileLayerOptions);
  }

  export interface PathOptions {
    color?: string;
    weight?: number;
    opacity?: number;
    fillColor?: string;
    fillOpacity?: number;
    dashArray?: string;
    dashOffset?: string;
    lineCap?: string;
    lineJoin?: string;
    className?: string;
    interactive?: boolean;
    bubblingPointerEvents?: boolean;
  }

  export class Path extends Layer {
    setStyle(style: PathOptions): this;
    bringToFront(): this;
    bringToBack(): this;
  }

  export class Polyline extends Path {
    constructor(latlngs: LatLngExpression[], options?: PathOptions);
    getLatLngs(): LatLng[];
    setLatLngs(latlngs: LatLngExpression[]): this;
    getBounds(): LatLngBounds;
  }

  export class Polygon extends Polyline {
    constructor(latlngs: LatLngExpression[] | LatLngExpression[][], options?: PathOptions);
  }

  export interface CircleMarkerOptions extends PathOptions {
    radius?: number;
  }

  export class CircleMarker extends Path {
    constructor(latlng: LatLngExpression, options?: CircleMarkerOptions);
    getLatLng(): LatLng;
    setRadius(radius: number): this;
    bindTooltip(content: string | HTMLElement | Tooltip, options?: TooltipOptions): this;
    bindPopup(content: string | HTMLElement | Popup, options?: PopupOptions): this;
    openPopup(): this;
    closePopup(): this;
  }

  export interface DivIconOptions {
    html?: string | HTMLElement;
    className?: string;
    iconSize?: PointExpression;
    iconAnchor?: PointExpression;
  }

  export class DivIcon {
    constructor(options?: DivIconOptions);
  }

  export interface MarkerOptions {
    icon?: DivIcon;
    interactive?: boolean;
    opacity?: number;
    title?: string;
    zIndexOffset?: number;
  }

  export class Marker extends Layer {
    constructor(latlng: LatLngExpression, options?: MarkerOptions);
    getLatLng(): LatLng;
    setLatLng(latlng: LatLngExpression): this;
    getElement(): HTMLElement | undefined;
    bindPopup(content: string | HTMLElement | Popup, options?: PopupOptions): this;
    bindTooltip(content: string | HTMLElement | Tooltip, options?: TooltipOptions): this;
    openPopup(): this;
    closePopup(): this;
  }

  export interface TooltipOptions {
    permanent?: boolean;
    direction?: 'right' | 'left' | 'top' | 'bottom' | 'center' | 'auto';
    offset?: PointExpression;
    className?: string;
    opacity?: number;
  }

  export class Tooltip extends Layer {
    constructor(options?: TooltipOptions, source?: Layer);
    setContent(content: string | HTMLElement): this;
  }

  export interface PopupOptions {
    offset?: PointExpression;
    className?: string;
    maxWidth?: number;
    autoPan?: boolean;
    closeButton?: boolean;
  }

  export class Popup extends Layer {
    constructor(options?: PopupOptions, source?: Layer);
    setContent(content: string | HTMLElement): this;
    setLatLng(latlng: LatLngExpression): this;
    openOn(map: LeafletMap): this;
  }

  export class LayerGroup extends Layer {
    constructor(layers?: Layer[]);
    addLayer(layer: Layer): this;
    removeLayer(layer: Layer | number): this;
    clearLayers(): this;
    eachLayer(fn: (layer: Layer) => void, context?: unknown): this;
    getLayers(): Layer[];
    hasLayer(layer: Layer): boolean;
  }

  export class FeatureGroup extends LayerGroup {
    getBounds(): LatLngBounds;
  }

  export class Renderer extends Layer {}

  export class Canvas extends Renderer {
    constructor(options?: { padding?: number });
  }

  export class Control extends Evented {
    constructor(options?: { position?: string });
    getPosition(): string;
    setPosition(position: string): this;
    getContainer(): HTMLElement | undefined;
    addTo(map: LeafletMap): this;
    remove(): this;
    onAdd?(map: LeafletMap): HTMLElement;
    onRemove?(map: LeafletMap): void;
  }

  export namespace Control {
    class Scale extends Control {
      constructor(options?: { maxWidth?: number; metric?: boolean; imperial?: boolean; position?: string });
    }

    class Layers extends Control {
      constructor(baseLayers?: Record<string, Layer>, overlays?: Record<string, Layer> | null, options?: { position?: string; collapsed?: boolean });
      addBaseLayer(layer: Layer, name: string): this;
      addOverlay(layer: Layer, name: string): this;
      removeLayer(layer: Layer): this;
    }
  }

  export interface LeafletMouseEvent {
    latlng: LatLng;
    layerPoint: Point;
    containerPoint: Point;
    originalEvent: MouseEvent;
  }

  export interface LeafletEvent {
    type: string;
    target: unknown;
  }
}

declare module 'leaflet/dist/leaflet.css' {
  const content: string;
  export default content;
}
