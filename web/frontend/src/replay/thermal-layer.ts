// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * ThermalLayer — the reconstructed thermal columns, drawn in the replay.
 *
 * Renders the stored ThermalShapeSummary list (fetched from the task's
 * field-analysis report; no point clouds) as in-scene geometry: one ring per
 * altitude band at the band's measured core and working radius — so the
 * stack of rings IS the column, leaning exactly as the measurement says —
 * plus the core axis as a line, and octahedron markers for bands with
 * multiple sub-cores (separate feeders before they merged).
 *
 * The "point cloud" role is played by the pilots' own trails: scrub to a
 * thermal's window and the trails spiral up through the rings.
 *
 * Time behaviour: a column shows at full strength while the replay clock is
 * inside its active window (±2 min) and fades to a ghost outside it, so the
 * day's thermals appear and die as the field found and left them. A
 * highlighted thermal (the ?thermal= deep link, or the drawer list) stays at
 * full strength regardless and dims every other column further.
 *
 * Geometry is built once; per-frame work is opacity writes only. Vertical
 * exaggeration follows the per-object rule (docs/3d-flight-replay-notes.md
 * §5.8): every y is baseY × vScale, re-applied on setVScale — never a group
 * scale.
 */

import * as THREE from 'three';
import type { ThermalShapeSummary } from '@glidecomp/engine';
import type { TrackManifest } from '@glidecomp/engine';

/** Seconds of grace either side of a thermal's window before it ghosts. */
const ACTIVE_PAD_S = 120;

const ACTIVE_OPACITY = 0.8;
const GHOST_OPACITY = 0.14;
/** Ghost opacity when some other thermal is highlighted. */
const DIMMED_OPACITY = 0.05;
const RING_SEGS = 48;

interface ShapeVisual {
  id: number;
  /** Replay-clock window (tRel seconds). */
  t0: number;
  t1: number;
  /** Materials whose opacity tracks the clock (rings + axis + feeders). */
  materials: THREE.Material[];
  /** Objects positioned at baseY × vScale. */
  scaled: { obj: THREE.Object3D; baseY: number }[];
  /** The axis line: base (un-exaggerated) y per point, re-scaled on demand. */
  axis: { line: THREE.Line; baseYs: Float32Array };
  /** Column centre in scene metres, for camera framing. */
  centre: { x: number; z: number; yBase: number; topBase: number; radius: number };
}

export class ThermalLayer {
  readonly group = new THREE.Group();
  private shapes: ShapeVisual[] = [];
  private visible = true;
  private highlight = -1;
  private vScale = 3;
  private lastTime = -1;

  constructor(
    summaries: ThermalShapeSummary[],
    manifest: TrackManifest,
    light: boolean,
  ) {
    const { lat0, lon0 } = manifest.origin;
    const alt0 = manifest.origin.alt0;
    const toX = (lon: number) => (lon - lon0) * manifest.mPerDegLon;
    const toZ = (lat: number) => (lat0 - lat) * manifest.mPerDegLat;

    // Violet family: distinct from the turnpoint amber, the start green and
    // the goal red, in both themes.
    const ringColor = light ? 0x6d28d9 : 0xa78bfa;
    const feederColor = light ? 0x9d174d : 0xf472b6;

    for (const s of summaries) {
      const mats: THREE.Material[] = [];
      const scaled: ShapeVisual['scaled'] = [];
      const sub = new THREE.Group();

      let sumX = 0;
      let sumZ = 0;
      let maxR = 0;
      const axisPts: number[] = [];
      const axisBaseYs: number[] = [];

      for (const b of s.bands) {
        const x = toX(b.core.lon);
        const z = toZ(b.core.lat);
        const baseY = b.altMid - alt0;
        sumX += x;
        sumZ += z;
        maxR = Math.max(maxR, b.coreRadius);
        axisPts.push(x, baseY, z);
        axisBaseYs.push(baseY);

        const ringPts: THREE.Vector3[] = [];
        for (let i = 0; i <= RING_SEGS; i++) {
          const a = (i / RING_SEGS) * Math.PI * 2;
          ringPts.push(new THREE.Vector3(
            x + Math.cos(a) * b.coreRadius,
            0,
            z + Math.sin(a) * b.coreRadius,
          ));
        }
        const mat = new THREE.LineBasicMaterial({
          color: ringColor,
          transparent: true,
          opacity: GHOST_OPACITY,
          depthWrite: false,
        });
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), mat);
        ring.frustumCulled = false;
        ring.renderOrder = 6;
        ring.position.y = baseY * this.vScale;
        mats.push(mat);
        scaled.push({ obj: ring, baseY });
        sub.add(ring);

        // Feeders: only bands with 2+ sub-cores carry the signal.
        if (b.subCores.length >= 2) {
          for (const sc of b.subCores) {
            const east = sc.east - b.core.east;
            const north = sc.north - b.core.north;
            const fm = new THREE.MeshBasicMaterial({
              color: feederColor,
              transparent: true,
              opacity: GHOST_OPACITY,
              depthWrite: false,
            });
            const m = new THREE.Mesh(new THREE.OctahedronGeometry(16), fm);
            m.position.set(x + east, baseY * this.vScale, z - north);
            m.frustumCulled = false;
            m.renderOrder = 6;
            mats.push(fm);
            scaled.push({ obj: m, baseY });
            sub.add(m);
          }
        }
      }

      // Core axis through the band centres.
      const axisGeom = new THREE.BufferGeometry();
      const axisArr = new Float32Array(axisPts);
      for (let i = 0; i < axisBaseYs.length; i++) axisArr[i * 3 + 1] = axisBaseYs[i] * this.vScale;
      axisGeom.setAttribute('position', new THREE.BufferAttribute(axisArr, 3));
      const axisMat = new THREE.LineBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthWrite: false,
      });
      const axis = new THREE.Line(axisGeom, axisMat);
      axis.frustumCulled = false;
      axis.renderOrder = 6;
      mats.push(axisMat);
      sub.add(axis);

      this.group.add(sub);
      const n = s.bands.length;
      this.shapes.push({
        id: s.id,
        t0: s.startMs / 1000 - manifest.t0,
        t1: s.endMs / 1000 - manifest.t0,
        materials: mats,
        scaled,
        axis: { line: axis, baseYs: new Float32Array(axisBaseYs) },
        centre: {
          x: sumX / Math.max(n, 1),
          z: sumZ / Math.max(n, 1),
          yBase: s.bands[0].altMid - alt0,
          topBase: s.bands[n - 1].altMid - alt0,
          radius: maxR,
        },
      });
    }
  }

  /** Column centre + extent for camera framing (un-exaggerated y). */
  centreOf(id: number): ShapeVisual['centre'] | null {
    return this.shapes.find((s) => s.id === id)?.centre ?? null;
  }

  /** Per-frame opacity pass; cheap, and skipped entirely when time is unchanged. */
  update(t: number): void {
    if (t === this.lastTime) return;
    this.lastTime = t;
    for (const s of this.shapes) {
      const active = t >= s.t0 - ACTIVE_PAD_S && t <= s.t1 + ACTIVE_PAD_S;
      const opacity = !this.visible
        ? 0
        : this.highlight === s.id
          ? ACTIVE_OPACITY
          : this.highlight >= 0
            ? DIMMED_OPACITY
            : active
              ? ACTIVE_OPACITY
              : GHOST_OPACITY;
      for (const m of s.materials) m.opacity = opacity;
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
    this.lastTime = -1; // force an opacity pass next frame
  }

  /** Emphasise one thermal (others dimmed); -1 clears. */
  setHighlight(id: number): void {
    this.highlight = id;
    this.lastTime = -1;
  }

  /** Re-apply vertical exaggeration (per-object, never a group scale). */
  setVScale(v: number): void {
    this.vScale = v;
    for (const s of this.shapes) {
      for (const { obj, baseY } of s.scaled) obj.position.y = baseY * v;
      const pos = s.axis.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < s.axis.baseYs.length; i++) pos.setY(i, s.axis.baseYs[i] * v);
      pos.needsUpdate = true;
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const any = o as unknown as {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      any.geometry?.dispose();
      const m = any.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m?.dispose();
    });
    this.group.clear();
  }
}
