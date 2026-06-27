// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * AbstractBackend — the standalone "data-viz" view: its own WebGL canvas,
 * PerspectiveCamera, OrbitControls (drag-to-rotate with damping) and a ground
 * grid. Hosts the shared FlightScene with no map underneath.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Backend, ScreenPoint } from './backend';
import type { FlightScene, MarkerSample } from './flight-scene';

export class AbstractBackend implements Backend {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private resizeObs!: ResizeObserver;
  private follow = -1;

  constructor(
    private container: HTMLElement,
    private flight: FlightScene,
  ) {}

  async mount(): Promise<void> {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x0a0f1a, 1);
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 5_000_000);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(this.flight.group);
    this.scene.add(this.flight.markers);
    this.buildGround();
    this.resetCamera();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.container);
  }

  private buildGround(): void {
    const size = this.flight.extentXZ * 2.2;
    const grid = new THREE.GridHelper(size, 24, 0x33415c, 0x1e293b);
    grid.position.set(this.flight.center.x, 0, this.flight.center.z);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resetCamera(): void {
    this.follow = -1;
    const d = this.flight.extentXZ * 1.15;
    const midY = (this.flight.altRange / 2) * this.vScale();
    this.controls.target.set(this.flight.center.x, midY, this.flight.center.z);
    this.camera.position.set(
      this.flight.center.x + d * 0.55,
      midY + d * 0.6,
      this.flight.center.z - d * 0.75,
    );
    this.controls.update();
  }

  private currentVScale = 3;
  private vScale(): number {
    return this.currentVScale;
  }
  setVScale(v: number): void {
    this.currentVScale = v;
  }

  followTo(sample: MarkerSample | null): void {
    if (!sample || !sample.active) return;
    const target = new THREE.Vector3(sample.x, sample.y, sample.z);
    const delta = target.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.follow = sample.pilot;
  }

  projectToScreen(x: number, y: number, z: number): ScreenPoint {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 };
  }

  getMetresPerPixel(): number {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const worldH = 2 * dist * Math.tan((this.camera.fov * Math.PI) / 180 / 2);
    return worldH / this.renderer.domElement.clientHeight;
  }

  getBearingDeg(): number {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    return (Math.atan2(fwd.x, fwd.z) * 180) / Math.PI;
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose(): void {
    this.resizeObs?.disconnect();
    // Detach shared scene objects so FlightScene.dispose() (owned by the
    // orchestrator) can free them without double-disposal here.
    this.scene.remove(this.flight.group);
    this.scene.remove(this.flight.markers);
    this.scene.traverse((o) => {
      const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material };
      any.geometry?.dispose();
      any.material?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
