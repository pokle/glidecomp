// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * GaggleLayer — the in-scene gaggle viz (Phase 2).
 *
 * For each gaggle active at the scrub time it draws a translucent **blob** that
 * wraps its current members — a filled rounded convex hull + a bright outline at
 * the members' mean (exaggerated) altitude — plus a floating **count label** and
 * a **stable per-gaggle colour**. The blob is recomputed each frame from live
 * member samples, so as a pilot joins you see the envelope reach out and engulf
 * them; it **fades in/out** near the episode's start/end so formation and
 * dissolution read even at low playback speed.
 *
 * Backend-agnostic: it lives in a Group hosted by `FlightScene`, so both the
 * abstract and the Mapbox-terrain backends render it. Vertical exaggeration is
 * already baked into the sample `y` (× vScale upstream), matching the
 * trail/marker/cylinder convention — never a group scale.
 *
 * A pool of blob objects (sized to the most gaggles that can coexist) is reused
 * across frames; geometry buffers are preallocated and rewritten in place via
 * `setDrawRange`, so the render loop never allocates.
 */

import * as THREE from 'three';
import { roundedHullOutline, type Pt } from './gaggle-hull';
import { gaggleColor, type GaggleResult } from './gaggles';
import type { MarkerSample } from './flight-scene';

const ARC_SEG = 6; // corner smoothness of the rounded hull

interface Blob {
  fill: THREE.Mesh;
  fillPos: Float32Array;
  outline: THREE.LineLoop;
  outlinePos: Float32Array;
  label: THREE.Mesh;
  labelTex: THREE.CanvasTexture;
  labelCtx: CanvasRenderingContext2D;
  labelCount: number; // last value painted, to avoid redrawing every frame
  capacity: number; // max outline points this blob's buffers hold
}

export class GaggleLayer {
  readonly group = new THREE.Group();

  private blobs: Blob[] = [];
  private pad: number;
  private labelWidth: number;
  private scratch: Pt[] = [];
  /** When ≥0, this gaggle is emphasised and the others are dimmed. */
  private highlight = -1;

  constructor(
    private gaggles: GaggleResult,
    nPilots: number,
    extentXZ: number,
  ) {
    // Pad the hull a touch wider than a marker so it wraps with breathing room.
    this.pad = Math.max(extentXZ * 0.018, 60);
    this.labelWidth = extentXZ * 0.04;

    const pool = Math.max(6, Math.ceil(nPilots / Math.max(2, gaggles.params.minPilots)));
    // Worst case a single gaggle holds every pilot; each hull corner contributes
    // up to ARC_SEG+1 rounded points, plus slack for the degenerate cases.
    const capacity = nPilots * (ARC_SEG + 1) + 32;
    for (let i = 0; i < pool; i++) this.blobs.push(this.makeBlob(capacity));
  }

  private makeBlob(capacity: number): Blob {
    const color = new THREE.Color(0.6, 0.85, 1);

    // filled translucent interior — a triangle fan written as a soup of tris
    const fillPos = new Float32Array(capacity * 3 * 3); // up to `capacity` tris
    const fillGeom = new THREE.BufferGeometry();
    fillGeom.setAttribute('position', new THREE.BufferAttribute(fillPos, 3));
    fillGeom.setDrawRange(0, 0);
    const fill = new THREE.Mesh(
      fillGeom,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    fill.frustumCulled = false;
    fill.renderOrder = 4;
    this.group.add(fill);

    // bright outline
    const outlinePos = new Float32Array(capacity * 3);
    const outlineGeom = new THREE.BufferGeometry();
    outlineGeom.setAttribute('position', new THREE.BufferAttribute(outlinePos, 3));
    outlineGeom.setDrawRange(0, 0);
    const outline = new THREE.LineLoop(
      outlineGeom,
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }),
    );
    outline.frustumCulled = false;
    outline.renderOrder = 6;
    this.group.add(outline);

    // count label (flat on the blob plane, north-up — same convention as turnpoints)
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const labelCtx = canvas.getContext('2d')!;
    const labelTex = new THREE.CanvasTexture(canvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    labelTex.anisotropy = 8;
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(this.labelWidth, this.labelWidth),
      new THREE.MeshBasicMaterial({
        map: labelTex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    label.rotation.x = -Math.PI / 2; // lay flat, textured face up
    label.frustumCulled = false;
    label.renderOrder = 7;
    this.group.add(label);

    const blob: Blob = {
      fill,
      fillPos,
      outline,
      outlinePos,
      label,
      labelTex,
      labelCtx,
      labelCount: -1,
      capacity,
    };
    this.hide(blob);
    return blob;
  }

  /**
   * Update every blob for time `t`. `samples` are the per-pilot marker samples
   * (y already × vScale); must be called after the markers have been refreshed.
   */
  update(t: number, samples: MarkerSample[]): void {
    const tol = this.gaggles.params.stepSeconds;
    // Fade over two grid steps at each end — long enough to read, short enough
    // not to wash out brief episodes.
    const fade = this.gaggles.params.stepSeconds * 2;

    let bi = 0;
    for (const ep of this.gaggles.episodes) {
      if (t < ep.tStart - tol || t > ep.tEnd + tol) continue;
      if (bi >= this.blobs.length) break;

      const members = membersAt(ep.timeline, t, tol);
      if (!members) continue;

      // live member positions (only those airborne right now)
      this.scratch.length = 0;
      let cy = 0;
      for (const m of members) {
        const s = samples[m];
        if (!s || !s.active || s.landed) continue;
        this.scratch.push({ x: s.x, z: s.z });
        cy += s.y;
      }
      if (this.scratch.length < 2) continue; // need ≥2 to draw an envelope
      cy /= this.scratch.length;

      let alpha = clamp(Math.min(t - ep.tStart, ep.tEnd - t) / fade, 0, 1);
      // Emphasise the highlighted gaggle, dim the rest.
      if (this.highlight >= 0 && ep.id !== this.highlight) alpha *= 0.22;
      if (this.drawBlob(this.blobs[bi], this.scratch, cy, ep.id, members.length, alpha)) bi++;
    }
    for (; bi < this.blobs.length; bi++) this.hide(this.blobs[bi]);
  }

  /** Fill one blob's buffers; returns false (and hides it) if degenerate. */
  private drawBlob(
    blob: Blob,
    points: Pt[],
    cy: number,
    id: number,
    count: number,
    alpha: number,
  ): boolean {
    const ring = roundedHullOutline(points, this.pad, ARC_SEG);
    const n = ring.length;
    if (n < 3 || n > blob.capacity) {
      this.hide(blob);
      return false;
    }

    // centroid of the outline (fan apex + label anchor)
    let cx = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p.x;
      cz += p.z;
    }
    cx /= n;
    cz /= n;

    // outline ring
    for (let i = 0; i < n; i++) {
      blob.outlinePos[i * 3] = ring[i].x;
      blob.outlinePos[i * 3 + 1] = cy;
      blob.outlinePos[i * 3 + 2] = ring[i].z;
    }
    blob.outline.geometry.setDrawRange(0, n);
    blob.outline.geometry.attributes.position.needsUpdate = true;

    // filled fan: tri(centroid, ring[i], ring[i+1])
    let f = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      blob.fillPos[f++] = cx;
      blob.fillPos[f++] = cy;
      blob.fillPos[f++] = cz;
      blob.fillPos[f++] = a.x;
      blob.fillPos[f++] = cy;
      blob.fillPos[f++] = a.z;
      blob.fillPos[f++] = b.x;
      blob.fillPos[f++] = cy;
      blob.fillPos[f++] = b.z;
    }
    blob.fill.geometry.setDrawRange(0, n * 3);
    blob.fill.geometry.attributes.position.needsUpdate = true;

    // colour + fade
    const [r, g, b] = gaggleColor(id);
    (blob.outline.material as THREE.LineBasicMaterial).color.setRGB(r, g, b);
    (blob.outline.material as THREE.LineBasicMaterial).opacity = 0.95 * alpha;
    (blob.fill.material as THREE.MeshBasicMaterial).color.setRGB(r, g, b);
    (blob.fill.material as THREE.MeshBasicMaterial).opacity = 0.16 * alpha;

    // count label at the centroid
    if (blob.labelCount !== count) this.paintLabel(blob, count);
    blob.label.position.set(cx, cy + 1, cz);
    (blob.label.material as THREE.MeshBasicMaterial).opacity = alpha;

    blob.fill.visible = true;
    blob.outline.visible = true;
    blob.label.visible = true;
    return true;
  }

  private paintLabel(blob: Blob, count: number): void {
    const ctx = blob.labelCtx;
    const s = ctx.canvas.width;
    ctx.clearRect(0, 0, s, s);
    ctx.font = `bold 76px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(8,12,22,0.92)';
    ctx.strokeText(String(count), s / 2, s / 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(String(count), s / 2, s / 2);
    blob.labelTex.needsUpdate = true;
    blob.labelCount = count;
  }

  /** Emphasise gaggle `id` (others dimmed); -1 clears. */
  setHighlight(id: number): void {
    this.highlight = id;
  }

  /** Show/hide the whole gaggle overlay. */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  private hide(blob: Blob): void {
    blob.fill.visible = false;
    blob.outline.visible = false;
    blob.label.visible = false;
  }

  dispose(): void {
    for (const b of this.blobs) {
      b.fill.geometry.dispose();
      (b.fill.material as THREE.Material).dispose();
      b.outline.geometry.dispose();
      (b.outline.material as THREE.Material).dispose();
      b.label.geometry.dispose();
      (b.label.material as THREE.Material).dispose();
      b.labelTex.dispose();
    }
    this.blobs = [];
  }
}

/** Membership at the timeline snapshot nearest `t` (within `tol`), or null. */
function membersAt(
  timeline: { t: number; members: number[] }[],
  t: number,
  tol: number,
): number[] | null {
  let best: number[] | null = null;
  let bd = Infinity;
  for (const s of timeline) {
    const d = Math.abs(s.t - t);
    if (d < bd) {
      bd = d;
      best = s.members;
    }
  }
  return best && bd <= tol ? best : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
