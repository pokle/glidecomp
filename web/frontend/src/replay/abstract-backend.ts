// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * AbstractBackend — the standalone "data-viz" view: its own WebGL canvas,
 * PerspectiveCamera, OrbitControls (drag-to-rotate with damping) and a ground
 * grid. Hosts the shared FlightScene with no map underneath.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Backend, ScreenPoint, ViewState } from './backend';
import type { FlightScene, MarkerSample } from './flight-scene';

export class AbstractBackend implements Backend {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private resizeObs!: ResizeObserver;
  private onPointerDown!: (e: PointerEvent) => void;
  private vScale = 3;
  private v = new THREE.Vector3(); // scratch for projection / bearing
  /** Camera pose to adopt on mount instead of the default framing. */
  private initialView: ViewState | null = null;

  // follow state: track the pilot's frame-to-frame movement rather than snapping
  // the camera onto it, so the user can pan/orbit/zoom while following.
  private followPilot = -1;
  private followPos: THREE.Vector3 | null = null;
  private followDelta = new THREE.Vector3();

  // orientation tween (compass / top / side); advanced in render().
  private viewAnim: {
    fromTheta: number; toTheta: number;
    fromPhi: number; toPhi: number;
    radius: number; t: number; dur: number;
  } | null = null;
  private animLast = 0;
  private sph = new THREE.Spherical(); // scratch for the tween

  constructor(
    private container: HTMLElement,
    private flight: FlightScene,
    /** Light theme: off-white clear colour + darker grid lines. */
    private light = false,
  ) {}

  async mount(): Promise<void> {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    // light mode uses an off-white, not full white — matches --rp-bg in replay.html
    this.renderer.setClearColor(this.light ? 0xf2f0e9 : 0x0a0f1a, 1);
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 5_000_000);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    // Match the Mapbox backdrop's mouse mapping: drag pans, Ctrl+drag orbits.
    // We make PAN the default action for both buttons and rely on OrbitControls'
    // built-in modifier handling, which swaps PAN→ROTATE while Ctrl/⌘/Shift is
    // held. So a plain drag pans and Ctrl+drag orbits, with no custom logic.
    // (Forcing LEFT=ROTATE on Ctrl ourselves does NOT work — OrbitControls then
    // swaps that ROTATE back to PAN because the modifier is down.) RIGHT also
    // defaults to PAN, which matters on macOS where a Ctrl+click is delivered as
    // a right-click (button 2) — it still swaps to ROTATE and orbits.
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    // Mapbox's Shift+drag box-zoom has no equivalent here. Left as-is, Shift+drag
    // would orbit (OrbitControls treats Shift like Ctrl), so swallow it. The
    // listener is on the canvas's parent in the CAPTURE phase, so it runs before
    // the event descends to the canvas where OrbitControls is listening — a
    // capture listener on the canvas itself would not, since at the target all
    // listeners fire in registration order and OrbitControls registered first.
    this.onPointerDown = (e: PointerEvent): void => {
      if (e.shiftKey) e.stopPropagation();
    };
    this.container.addEventListener('pointerdown', this.onPointerDown, true);
    // Match Mapbox touch gestures: one finger pans, two fingers orbit (and
    // pinch-zoom). OrbitControls defaults to the opposite (ONE rotates).
    this.controls.touches.ONE = THREE.TOUCH.PAN;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

    this.scene.add(this.flight.group);
    this.scene.add(this.flight.markers);
    this.buildGround();
    if (this.initialView) this.applyView(this.initialView);
    else this.resetCamera();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.container);
  }

  private buildGround(): void {
    const size = this.flight.extentXZ * 2.2;
    const grid = this.light
      ? new THREE.GridHelper(size, 24, 0x8a93a5, 0xc6c9be)
      : new THREE.GridHelper(size, 24, 0x33415c, 0x1e293b);
    grid.position.set(this.flight.center.x, 0, this.flight.center.z);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);
  }

  render(): void {
    if (this.viewAnim) this.advanceViewAnim();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Ease the camera around the current target to a new azimuth/polar (radius kept). */
  private advanceViewAnim(): void {
    const a = this.viewAnim!;
    const now = performance.now();
    a.t = Math.min(a.dur, a.t + (now - this.animLast) / 1000);
    this.animLast = now;
    const k = a.t / a.dur;
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
    this.sph.set(a.radius, a.fromPhi + (a.toPhi - a.fromPhi) * e, a.fromTheta + (a.toTheta - a.fromTheta) * e);
    this.camera.position.copy(this.controls.target).add(this.v.setFromSpherical(this.sph));
    if (a.t >= a.dur) this.viewAnim = null;
  }

  /**
   * Start an orientation tween to azimuth `theta` (radians) and polar `phi`
   * (null = keep current), around the current target and at the current radius.
   * The follow state is untouched, so re-orienting mid-follow keeps tracking.
   */
  private orientTo(theta: number, phi: number | null): void {
    const sph = this.sph.setFromVector3(this.v.subVectors(this.camera.position, this.controls.target));
    const minP = this.controls.minPolarAngle + 0.001;
    const maxP = this.controls.maxPolarAngle - 0.001;
    const toPhi = phi == null ? sph.phi : Math.max(minP, Math.min(maxP, phi));
    // walk the shortest way round the azimuth circle
    let d = (theta - sph.theta) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    this.viewAnim = {
      fromTheta: sph.theta, toTheta: sph.theta + d,
      fromPhi: sph.phi, toPhi,
      radius: sph.radius, t: 0, dur: 0.5,
    };
    this.animLast = performance.now();
  }

  // Azimuth θ=0 puts the camera due south of the target looking north, i.e. north up.
  faceNorth(): void { this.orientTo(0, null); }
  topView(): void { this.orientTo(0, 0.02); }
  sideView(): void { this.orientTo(0, this.controls.maxPolarAngle); }

  resetCamera(): void {
    this.followPilot = -1;
    this.followPos = null;
    this.viewAnim = null;
    const d = this.flight.extentXZ * 1.15;
    const midY = (this.flight.altRange / 2) * this.vScale;
    this.controls.target.set(this.flight.center.x, midY, this.flight.center.z);
    // Camera on the south side (+Z, since North = -Z) looking north, so East is
    // on the right by default.
    this.camera.position.set(
      this.flight.center.x + d * 0.55,
      midY + d * 0.6,
      this.flight.center.z + d * 0.75,
    );
    this.controls.update();
  }

  setVScale(v: number): void {
    this.vScale = v;
  }

  setInitialView(view: ViewState): void {
    this.initialView = view;
  }

  getViewState(): ViewState {
    const offset = this.v.subVectors(this.camera.position, this.controls.target);
    const r = offset.length();
    // polar angle from +Y: 0 = camera straight above (top-down) — matches
    // Mapbox's pitch convention directly.
    const pitchDeg = (Math.acos(Math.max(-1, Math.min(1, offset.y / r))) * 180) / Math.PI;
    return {
      x: this.controls.target.x,
      y: this.controls.target.y,
      z: this.controls.target.z,
      bearingDeg: this.getBearingDeg(),
      pitchDeg,
      mpp: this.getMetresPerPixel(),
    };
  }

  /**
   * Adopt a handed-over camera pose: look at (x, y, z) from the bearing/pitch,
   * at a distance that reproduces the same metres-per-pixel at the target
   * (inverse of getMetresPerPixel). Azimuth θ = −bearing: θ = 0 puts the
   * camera due south looking north (bearing 0), and bearing grows clockwise
   * while θ grows counter-clockwise.
   */
  private applyView(v: ViewState): void {
    const h = this.container.clientHeight || 600;
    const dist = (v.mpp * h) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const phi = Math.max(
      0.02,
      Math.min(this.controls.maxPolarAngle, (v.pitchDeg * Math.PI) / 180),
    );
    this.controls.target.set(v.x, v.y, v.z);
    this.sph.set(dist, phi, (-v.bearingDeg * Math.PI) / 180);
    this.camera.position.copy(this.controls.target).add(this.v.setFromSpherical(this.sph));
    this.controls.update();
  }

  followTo(sample: MarkerSample | null): void {
    if (!sample) {
      // explicit stop
      this.followPilot = -1;
      this.followPos = null;
      return;
    }
    if (!sample.active) {
      // pilot not airborne now → drop the anchor so we re-anchor (no jump) when it resumes
      this.followPos = null;
      return;
    }
    if (sample.pilot !== this.followPilot || !this.followPos) {
      // (Re)anchor on the pilot's current spot WITHOUT moving the camera, so it
      // stays exactly where it is on screen when the follow begins.
      this.followPilot = sample.pilot;
      this.followPos = new THREE.Vector3(sample.x, sample.y, sample.z);
      return;
    }
    // Shift target + camera by the pilot's movement since last frame. The
    // camera↔target offset is left untouched, so the user's pan/orbit/zoom stick.
    this.followDelta.set(sample.x, sample.y, sample.z).sub(this.followPos);
    this.controls.target.add(this.followDelta);
    this.camera.position.add(this.followDelta);
    this.followPos.set(sample.x, sample.y, sample.z);
  }

  projectToScreen(x: number, y: number, z: number): ScreenPoint {
    const v = this.v.set(x, y, z).project(this.camera);
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
    this.camera.getWorldDirection(this.v);
    // Heading clockwise from north; North = -Z, so the north component is -fwd.z.
    return (Math.atan2(this.v.x, -this.v.z) * 180) / Math.PI;
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
    this.container.removeEventListener('pointerdown', this.onPointerDown, true);
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
