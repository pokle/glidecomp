/**
 * Generates the SVG diagrams for nested-cylinder-presence-reaching.md.
 *
 * The geometry is the exact task/track geometry used by the
 * "turnpoint nested inside a larger following cylinder" tests in
 * web/engine/tests/turnpoint-sequence.test.ts, drawn to scale
 * (equirectangular projection, north pointing right).
 *
 * Run: bun docs/event-detection/diagrams/generate-nested-cylinder-diagrams.ts
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// --- planar geo (viz only — the engine uses geo.ts, this is just drawing) ---
const M_PER_DEG_LAT = 111_320;
const COS_LAT = Math.cos((47.06 * Math.PI) / 180);
const M_PER_DEG_LON = M_PER_DEG_LAT * COS_LAT;

interface Pt { lat: number; lon: number }

/** Escape text for embedding in SVG/XML content. */
const esc = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const metersNorth = (p: Pt, lat0: number) => (p.lat - lat0) * M_PER_DEG_LAT;
const metersEast = (p: Pt, lon0: number) => (p.lon - lon0) * M_PER_DEG_LON;
const dist = (a: Pt, b: Pt) =>
  Math.hypot((a.lat - b.lat) * M_PER_DEG_LAT, (a.lon - b.lon) * M_PER_DEG_LON);

/** All boundary crossings of a circle along a polyline, with fractional segment position. */
function circleCrossings(track: Pt[], center: Pt, radius: number): Array<Pt & { seg: number; t: number }> {
  const out: Array<Pt & { seg: number; t: number }> = [];
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    const da = dist(a, center) - radius;
    const db = dist(b, center) - radius;
    if (da === 0 || da * db >= 0) continue;
    // bisect for the boundary point
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      const p = { lat: a.lat + mid * (b.lat - a.lat), lon: a.lon + mid * (b.lon - a.lon) };
      if ((dist(p, center) - radius) * da > 0) lo = mid; else hi = mid;
    }
    const t = (lo + hi) / 2;
    out.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), seg: i - 1, t });
  }
  return out;
}

// --- palette (legible on GitHub light and dark; every SVG carries its own bg) ---
const C = {
  bg: '#f8fafc',
  frame: '#d0d7de',
  text: '#1f2328',
  muted: '#57606a',
  track: '#1f2328',
  fix: '#57606a',
  start: '#8b949e',
  tp: '#316dca',
  goal: '#d4761a',
  good: '#1a7f37',
  bad: '#cf222e',
};

interface Circle { center: Pt; r: number; label: string; kind: 'start' | 'tp' | 'goal'; labelDy?: number; labelDx?: number; labelAnchor?: string }
interface Marker { p: Pt; label: string; color: string; dx?: number; dy?: number; anchor?: string }
interface Verdict { color: string; title: string; lines: string[] }

interface Scene {
  file: string;
  title: string;
  /** Use \n for a second subtitle line. */
  subtitle: string;
  /** Widen the canvas beyond the geographic extent (plot stays centred). */
  minWidth?: number;
  latMin: number; latMax: number;   // extent along the flight axis (x, north → right)
  eastMin: number; eastMax: number; // extent across (y), metres relative to lon0
  lon0: number;
  scale: number;                    // metres per px
  circles: Circle[];
  track: Pt[];
  fixLabels?: Array<{ i: number; text: string; dy?: number; dx?: number }>;
  markers: Marker[];
  verdicts: Verdict[];
  landing: Pt;
}

function render(s: Scene): string {
  const PAD = 24;
  const subtitleLines = s.subtitle.split('\n');
  const TITLE_H = 64 + (subtitleLines.length - 1) * 17;
  const VERDICT_H = s.verdicts.length > 0 ? 96 : 0;
  const geoW = ((s.latMax - s.latMin) * M_PER_DEG_LAT) / s.scale + PAD * 2;
  const w = Math.max(geoW, s.minWidth ?? 0);
  const xOff = (w - geoW) / 2;
  const plotH = (s.eastMax - s.eastMin) / s.scale;
  const h = TITLE_H + plotH + VERDICT_H + PAD * 2;
  const X = (p: Pt) => xOff + PAD + (metersNorth(p, s.latMin)) / s.scale;
  const Y = (p: Pt) => TITLE_H + PAD + (s.eastMax - metersEast(p, s.lon0)) / s.scale;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" ` +
    `font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="13">`,
  );
  parts.push(`<rect width="${w.toFixed(0)}" height="${h.toFixed(0)}" rx="8" fill="${C.bg}" stroke="${C.frame}"/>`);
  parts.push(`<text x="${PAD}" y="30" font-size="16" font-weight="600" fill="${C.text}">${esc(s.title)}</text>`);
  subtitleLines.forEach((line, i) => {
    parts.push(`<text x="${PAD}" y="${50 + i * 17}" fill="${C.muted}">${esc(line)}</text>`);
  });

  // compass: north points right
  parts.push(
    `<g transform="translate(${w - 58}, 30)" stroke="${C.muted}" fill="${C.muted}">` +
    `<line x1="0" y1="0" x2="26" y2="0" stroke-width="1.5"/>` +
    `<path d="M 26 0 l -7 -4 l 0 8 z" stroke="none"/>` +
    `<text x="32" y="4" stroke="none" font-size="12">N</text></g>`,
  );

  // cylinders
  for (const c of s.circles) {
    const color = c.kind === 'start' ? C.start : c.kind === 'tp' ? C.tp : C.goal;
    const rpx = c.r / s.scale;
    const cx = X(c.center);
    const cy = Y(c.center);
    parts.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rpx.toFixed(1)}" ` +
      `fill="${color}" fill-opacity="0.10" stroke="${color}" stroke-width="2"` +
      (c.kind === 'start' ? ' stroke-dasharray="6 5"' : '') + `/>`,
    );
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.5" fill="${color}"/>`);
    const dy = c.labelDy ?? -(rpx + 8);
    parts.push(
      `<text x="${(cx + (c.labelDx ?? 0)).toFixed(1)}" y="${(cy + dy).toFixed(1)}" ` +
      `text-anchor="${c.labelAnchor ?? 'middle'}" ` +
      `font-weight="600" fill="${color}">${esc(c.label)}</text>`,
    );
  }

  // track
  const pathD = s.track
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${X(p).toFixed(1)} ${Y(p).toFixed(1)}`)
    .join(' ');
  parts.push(`<path d="${pathD}" fill="none" stroke="${C.track}" stroke-width="2.25" stroke-linejoin="round"/>`);

  // direction arrows at segment midpoints
  for (let i = 1; i < s.track.length; i++) {
    const a = s.track[i - 1];
    const b = s.track[i];
    if (dist(a, b) / s.scale < 46) continue; // too short to decorate
    const mx = (X(a) + X(b)) / 2;
    const my = (Y(a) + Y(b)) / 2;
    const ang = (Math.atan2(Y(b) - Y(a), X(b) - X(a)) * 180) / Math.PI;
    parts.push(
      `<path d="M -6 -4.5 L 6 0 L -6 4.5 z" fill="${C.track}" ` +
      `transform="translate(${mx.toFixed(1)}, ${my.toFixed(1)}) rotate(${ang.toFixed(1)})"/>`,
    );
  }

  // fixes
  for (const p of s.track) {
    parts.push(`<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="3" fill="${C.fix}"/>`);
  }
  for (const fl of s.fixLabels ?? []) {
    const p = s.track[fl.i];
    parts.push(
      `<text x="${(X(p) + (fl.dx ?? 0)).toFixed(1)}" y="${(Y(p) + (fl.dy ?? -10)).toFixed(1)}" ` +
      `text-anchor="middle" fill="${C.muted}">${esc(fl.text)}</text>`,
    );
  }

  // landing symbol
  parts.push(
    `<g transform="translate(${X(s.landing).toFixed(1)}, ${Y(s.landing).toFixed(1)})">` +
    `<circle r="6.5" fill="none" stroke="${C.track}" stroke-width="2"/>` +
    `<circle r="2" fill="${C.track}"/></g>`,
  );

  // crossing/event markers
  for (const m of s.markers) {
    const x = X(m.p);
    const y = Y(m.p);
    parts.push(
      `<g transform="translate(${x.toFixed(1)}, ${y.toFixed(1)})">` +
      `<circle r="7" fill="none" stroke="${m.color}" stroke-width="2.5"/>` +
      `<circle r="2" fill="${m.color}"/></g>`,
    );
    const lines = m.label.split('\n');
    lines.forEach((line, li) => {
      parts.push(
        `<text x="${(x + (m.dx ?? 0)).toFixed(1)}" y="${(y + (m.dy ?? -14) + li * 16).toFixed(1)}" ` +
        `text-anchor="${m.anchor ?? 'middle'}" font-weight="600" fill="${m.color}">${esc(line)}</text>`,
      );
    });
  }

  // verdict boxes
  if (s.verdicts.length > 0) {
    const by = TITLE_H + plotH + PAD * 1.5;
    const bw = (w - PAD * (s.verdicts.length + 1)) / s.verdicts.length;
    s.verdicts.forEach((v, i) => {
      const bx = PAD + i * (bw + PAD);
      parts.push(
        `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="78" rx="6" ` +
        `fill="${v.color}" fill-opacity="0.08" stroke="${v.color}"/>`,
      );
      parts.push(
        `<text x="${(bx + 12).toFixed(1)}" y="${(by + 22).toFixed(1)}" font-weight="600" fill="${v.color}">${esc(v.title)}</text>`,
      );
      v.lines.forEach((line, li) => {
        parts.push(
          `<text x="${(bx + 12).toFixed(1)}" y="${(by + 42 + li * 17).toFixed(1)}" fill="${C.text}">${esc(line)}</text>`,
        );
      });
    });
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// --- shared geometry (mirrors the tests) ---
const START = { center: { lat: 47.0, lon: 11.0 }, r: 1000 };
const TP1 = { center: { lat: 47.1, lon: 11.0 }, r: 400 };
const GOAL = { center: { lat: 47.11, lon: 11.0 }, r: 3000 };

const inbound: Pt[] = [
  { lat: 47.0, lon: 11.0 },
  { lat: 47.02, lon: 11.0 },
  { lat: 47.05, lon: 11.0 },
  { lat: 47.075, lon: 11.0 },
  { lat: 47.09, lon: 11.0 },
  { lat: 47.1, lon: 11.0 },
  { lat: 47.107, lon: 11.0 },
  { lat: 47.11, lon: 11.0 },
];

// nudge the straight-line track slightly south-of-axis? No — keep honest, it is a straight line.
const goalEnter = circleCrossings(inbound, GOAL.center, GOAL.r)[0];
const tp1Enter = circleCrossings(inbound, TP1.center, TP1.r)[0];
const sssExit = circleCrossings(inbound, START.center, START.r)[0];

// --- diagram 1: the bug ---
const scene1: Scene = {
  file: 'nested-tp-bug.svg',
  title: 'The bug — turnpoint nested inside a larger following cylinder',
  subtitle:
    'TP1’s 400 m cylinder sits entirely inside the 3 km ESS/goal cylinder. ' +
    'The pilot’s ONLY goal-boundary crossing (t₁) happens before TP1 is tagged (t₂).',
  latMin: 46.985, latMax: 47.152,
  eastMin: -3600, eastMax: 3600,
  lon0: 11.0,
  scale: 21,
  circles: [
    { ...START, label: 'START (exit, 1 km)', kind: 'start' },
    { ...TP1, label: '', kind: 'tp' },
    { ...GOAL, label: 'ESS / GOAL (3 km)', kind: 'goal' },
  ],
  track: inbound,
  markers: [
    { p: sssExit, label: 'start', color: C.muted, dy: 28 },
    { p: goalEnter, label: 't₁ — enters goal cylinder\n(the only crossing)', color: C.goal, dx: -14, dy: -34, anchor: 'end' },
    { p: tp1Enter, label: 't₂ — tags TP1 (400 m),\nalready inside goal', color: C.tp, dy: 40, anchor: 'middle' },
  ],
  verdicts: [
    {
      color: C.bad,
      title: 'Before the fix ✗',
      lines: [
        'ESS/goal needs a crossing at t ≥ t₂, but its only',
        'crossing is t₁ < t₂ → finisher scored LANDED OUT.',
      ],
    },
    {
      color: C.good,
      title: 'After the fix ✓',
      lines: [
        'Pilot is already inside the goal cylinder at t₂,',
        'so ESS/goal is credited at t₂ → made goal.',
      ],
    },
  ],
  landing: inbound[inbound.length - 1],
};

// annotate goal-cylinder label lower so it doesn't collide with t1 label
scene1.circles[2].labelDy = -(GOAL.r / scene1.scale) - 8;

// --- diagram 2: exit + re-entry (intermittent rescue / late ESS time) ---
const track2: Pt[] = [...inbound, { lat: 47.15, lon: 11.0 }, { lat: 47.11, lon: 11.004 }];
const goalCross2 = circleCrossings(track2, GOAL.center, GOAL.r);
const scene2: Scene = {
  file: 'nested-tp-reenter.svg',
  title: 'Why it was intermittent — a later exit/re-entry “rescued” the pilot',
  subtitle:
    'Same task. If the pilot happens to exit the goal cylinder after t₂ and come back, the ' +
    're-entry (t₄) is a crossing ≥ t₂ — credited, but with the WRONG (late) time.',
  latMin: 46.985, latMax: 47.176,
  eastMin: -3600, eastMax: 3600,
  lon0: 11.0,
  scale: 21,
  circles: [
    { ...START, label: 'START (exit, 1 km)', kind: 'start' },
    { ...TP1, label: '', kind: 'tp' },
    { ...GOAL, label: 'ESS / GOAL (3 km)', kind: 'goal' },
  ],
  track: track2,
  markers: [
    { p: goalCross2[0], label: 't₁ enter', color: C.goal, dx: -14, dy: -18, anchor: 'end' },
    { p: tp1Enter, label: 't₂ tags TP1', color: C.tp, dy: 40, anchor: 'middle' },
    { p: goalCross2[1], label: 't₃ exit', color: C.goal, dy: -18, anchor: 'middle' },
    { p: goalCross2[2], label: 't₄ re-enter', color: C.goal, dy: 34, anchor: 'middle' },
  ],
  verdicts: [
    {
      color: C.bad,
      title: 'Before the fix ⚠',
      lines: [
        'ESS credited at the re-entry t₄ — the speed-section',
        'time is inflated by (t₄ − t₂). No exit? Landed out.',
      ],
    },
    {
      color: C.good,
      title: 'After the fix ✓',
      lines: [
        'Presence wins: ESS/goal credited at t₂ regardless',
        'of what the pilot does afterwards.',
      ],
    },
  ],
  landing: track2[track2.length - 1],
};
scene2.circles[2].labelDy = -(GOAL.r / scene2.scale) - 8;

// --- diagram 3: giant cylinder, zero crossings ---
const GOAL3 = { center: { lat: 47.05, lon: 11.0 }, r: 20000 };
const track3: Pt[] = [
  { lat: 47.0, lon: 11.0 },
  { lat: 47.02, lon: 11.0 },
  { lat: 47.05, lon: 11.0 },
  { lat: 47.09, lon: 11.0 },
  { lat: 47.1, lon: 11.0 },
];
const tp1Enter3 = circleCrossings(track3, TP1.center, TP1.r)[0];
const scene3: Scene = {
  file: 'giant-goal-no-crossings.svg',
  title: 'Edge case — a goal cylinder the flight never crosses at all',
  subtitle:
    'A 20 km ESS/goal cylinder contains launch, TP1 and the entire track: zero boundary\n' +
    'crossings. Presence falls back to “where did the track begin?” — inside.',
  latMin: 46.855, latMax: 47.245,
  minWidth: 960,
  eastMin: -21000, eastMax: 21000,
  lon0: 11.0,
  scale: 110,
  circles: [
    { ...GOAL3, label: 'ESS / GOAL (20 km) — never crossed', kind: 'goal' },
    { ...START, label: 'START', kind: 'start', labelDy: 26 },
    { ...TP1, label: 'TP1', kind: 'tp', labelDy: 34 },
  ],
  track: track3,
  fixLabels: [{ i: 0, text: 'launch (already inside goal)', dy: 48, dx: 8 }],
  markers: [
    { p: tp1Enter3, label: 't₂ tags TP1 → goal credited at t₂', color: C.good, dy: -20, dx: 12, anchor: 'start' },
  ],
  verdicts: [
    {
      color: C.bad,
      title: 'Before the fix ✗',
      lines: ['No crossing of the goal cylinder exists anywhere,', 'so the pilot could never make goal.'],
    },
    {
      color: C.good,
      title: 'After the fix ✓',
      lines: ['No crossings ever ⇒ inside/outside state never changed', '⇒ use the state at the first fix: inside → made goal.'],
    },
  ],
  landing: track3[track3.length - 1],
};

// --- diagram 4: negative control (no over-credit) ---
const GOAL4 = { center: { lat: 47.11, lon: 11.0 }, r: 1000 };
const track4: Pt[] = [
  { lat: 47.0, lon: 11.01 },
  { lat: 47.05, lon: 11.01 },
  { lat: 47.09, lon: 11.01 },
  { lat: 47.11, lon: 11.01 },
  { lat: 47.13, lon: 11.01 },
  { lat: 47.13, lon: 10.98 },
  { lat: 47.1, lon: 10.98 },
  { lat: 47.1, lon: 11.0 },
  { lat: 47.09, lon: 11.0 },
];
const goalCross4 = circleCrossings(track4, GOAL4.center, GOAL4.r);
const tp1Enter4 = circleCrossings(track4, TP1.center, TP1.r)[0];
const scene4: Scene = {
  file: 'no-over-credit.svg',
  title: 'No over-credit — a goal cylinder visited BEFORE the turnpoint stays uncounted',
  subtitle:
    'The pilot clips the goal cylinder on the way out (enter t₁, exit t₂), then tags TP1 from outside\n' +
    'it and lands without returning. The last crossing before t₃ is an EXIT → outside → no credit.',
  latMin: 46.985, latMax: 47.152,
  eastMin: -2600, eastMax: 2100,
  lon0: 11.0,
  scale: 21,
  circles: [
    { ...START, label: 'START (exit, 1 km)', kind: 'start' },
    { ...TP1, label: '', kind: 'tp' },
    { ...GOAL4, label: 'ESS / GOAL (1 km)', kind: 'goal', labelDx: 58, labelDy: -62, labelAnchor: 'start' },
  ],
  track: track4,
  markers: [
    { p: goalCross4[0], label: 't₁ enter', color: C.goal, dy: -16, dx: -14, anchor: 'end' },
    { p: goalCross4[1], label: 't₂ exit', color: C.goal, dy: 28, dx: 12, anchor: 'start' },
    { p: tp1Enter4, label: 't₃ tags TP1 — outside goal', color: C.tp, dy: 46, dx: -60, anchor: 'middle' },
  ],
  verdicts: [
    {
      color: C.good,
      title: 'Before AND after the fix ✓',
      lines: [
        'Presence is checked AT the previous reaching (t₃): the last goal crossing before t₃ is the exit at t₂,',
        'so the pilot is outside — and no crossing follows t₃. Correctly scored landed out; earlier visits never count.',
      ],
    },
  ],
  landing: track4[track4.length - 1],
};
scene4.circles[1].labelDy = 34;

for (const scene of [scene1, scene2, scene3, scene4]) {
  const svg = render(scene);
  writeFileSync(join(OUT_DIR, scene.file), svg);
  console.log(`wrote ${scene.file}`);
}
