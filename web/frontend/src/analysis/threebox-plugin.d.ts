/**
 * Type declarations for threebox-plugin
 */

declare module 'threebox-plugin' {
  import type * as mapboxgl from 'mapbox-gl';

  export interface ThreeboxOptions {
    defaultLights?: boolean;
    enableSelectingObjects?: boolean;
    enableDraggingObjects?: boolean;
    enableRotatingObjects?: boolean;
    enableTooltips?: boolean;
  }

  export interface LineOptions {
    geometry: [number, number, number][];
    color?: string;
    width?: number;
    opacity?: number;
  }

  export interface TubeOptions {
    geometry: [number, number, number][];
    radius?: number;
    sides?: number;
    material?: string;
    color?: string;
  }

  export class Threebox {
    constructor(
      map: mapboxgl.Map,
      glContext: WebGLRenderingContext | null,
      options?: ThreeboxOptions
    );

    update(): void;
    add(object: unknown): void;
    remove(object: unknown): void;
    line(options: LineOptions): unknown;
    tube(options: TubeOptions): unknown;
    dispose(): void;
  }
}
