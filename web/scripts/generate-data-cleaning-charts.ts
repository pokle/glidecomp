// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Generate the static SVG figures on /scoring/data-cleaning:
 *
 *  - REAL examples: segments of archive tracklogs whose altitudes the
 *    engine's cleaning pass repaired → DataCleaningCharts.astro
 *  - SYNTHETIC illustrations: fabricated two-channel tracks fed through the
 *    SAME cleanAltitudes engine, showing the barometer cross-check — which
 *    no archive track can show, because scoring-server exports strip the
 *    barometric channel → DataCleaningChartsSynthetic.astro
 *
 *   GLIDECOMP_COMPS_DIR=<glidecomp-archive>/comps \
 *     bun web/scripts/generate-data-cleaning-charts.ts
 *
 * Output is checked in (byte-stable for the same inputs — commit it). The
 * archive repo holds the real tracks, so this is a run-and-commit generator
 * like generate-big-chip, not a build step.
 *
 * Honesty rules: synthetic figures are labelled as illustrations in their
 * titles and captions; every line drawn is the REAL engine's output over the
 * declared input (never hand-drawn); and each synthetic scenario asserts its
 * expected outcome, so if the algorithm's behaviour ever drifts from the
 * caption, regeneration fails loudly instead of shipping a stale story.
 *
 * Chart conventions (docs/accessibility-standard.md + the site tokens):
 * series identity carried by hue AND line style (cleaned is dashed — never
 * colour alone), direct labels + a legend, exact numbers in the visible
 * caption, no client JS.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIGC, fixAltitude, type IGCFix } from '../engine/src/igc-parser';
import { cleanAltitudes, type AltitudeRepairRange } from '../engine/src/altitude-cleaning';

const COMPS_DIR = process.env.GLIDECOMP_COMPS_DIR;
if (!COMPS_DIR) {
  console.error('GLIDECOMP_COMPS_DIR must point at the glidecomp-archive comps/ checkout');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Example definitions
// ---------------------------------------------------------------------------

interface RealExample {
  kind: 'real';
  /** Track path relative to the comps dir. */
  track: string;
  id: string;
  title: string;
  /** Which repaired range to frame (by max correction rank). */
  rangeRank: number;
  /** Seconds of context either side of the repaired range. */
  contextSeconds: number;
  utcOffsetHours: number;
  zoneLabel: string;
  /** One-sentence figcaption lead-in; exact numbers are appended. */
  caption: string;
}

interface SyntheticExample {
  kind: 'synthetic';
  id: string;
  title: string;
  /** Build the two-channel fix series (1 s cadence, deterministic). */
  build(): IGCFix[];
  /** Repairs this scenario must (or must not) produce — asserted. */
  expectRepairs: boolean;
  utcOffsetHours: number;
  zoneLabel: string;
  /** Full figcaption (numbers appended when repairs exist). */
  caption: string;
}

type Example = RealExample | SyntheticExample;

const REAL: RealExample[] = [
  {
    kind: 'real',
    track: 'bright-open-2026-open-t1/brooks_72322_180126.igc',
    id: 'example-spike',
    title: 'A GPS spike, 9.5 km below the flight',
    rangeRank: 0,
    contextSeconds: 75,
    utcOffsetHours: 11,
    zoneLabel: 'AEDT',
    caption:
      'Bright Open 2026, task 1: mid-glide, the logger wrote a fix nearly 9,600 m BELOW ' +
      'the flight — eight kilometres under the valley floor, a vertical speed no aircraft ' +
      'could fly — and returned to the true altitude one second later.',
  },
  {
    kind: 'real',
    track: 'forbes-flatlands-2025-open-t1/cedro_600490_140125.igc',
    id: 'example-dropout',
    title: 'A dropout to zero',
    rangeRank: 0,
    contextSeconds: 75,
    utcOffsetHours: 11,
    zoneLabel: 'AEDT',
    caption:
      'Forbes Flatlands 2025, task 1: for one fix the GPS altitude collapsed to 0 m — the ' +
      'format’s “no altitude” value — while the pilot was cruising near 2,500 m, then ' +
      'recovered immediately.',
  },
];

/** Fixed base time for synthetic tracks: 03:00 UTC = 14:00 AEDT. */
const SYNTH_BASE_MS = Date.UTC(2026, 0, 10, 3, 0, 0);

function synthFix(t: number, gnss: number, baro: number): IGCFix {
  return {
    time: new Date(SYNTH_BASE_MS + t * 1000),
    latitude: -36.5 + t * 1e-5,
    longitude: 148.2 + t * 1e-5,
    pressureAltitude: Math.round(baro),
    gnssAltitude: Math.round(gnss),
    valid: true,
  };
}

/** Deterministic gentle wobble standing in for sensor noise. */
const wobble = (t: number, amp: number, period: number) => amp * Math.sin((t * 2 * Math.PI) / period);

const SYNTHETIC: SyntheticExample[] = [
  {
    kind: 'synthetic',
    id: 'illustration-cross-check',
    title: 'A GPS spike the barometer refuses to confirm',
    utcOffsetHours: 11,
    zoneLabel: 'AEDT',
    expectRepairs: true,
    build() {
      const fixes: IGCFix[] = [];
      for (let t = 0; t <= 240; t++) {
        // Steady climb with a little thermal texture; barometer tracks ~45 m
        // below (QNH/geoid offset).
        const alt = 1850 + t * 1.2 + wobble(t, 22, 61);
        let gnss = alt + wobble(t, 3, 13);
        if (t >= 118 && t <= 121) gnss += 340; // 4-fix multipath spike, GNSS only
        const baro = alt - 45 + wobble(t, 3, 23);
        fixes.push(synthFix(t, gnss, baro));
      }
      return fixes;
    },
    caption:
      'Illustration (synthetic data, real cleaning engine): mid-climb, the GPS channel ' +
      'jumps ~340 m for four fixes while the barometer keeps reading a smooth climb. The ' +
      'GPS-minus-barometer difference leaps out of its rolling baseline, so the fixes are ' +
      'repaired to the barometric altitude plus the current offset — landing back on the ' +
      'true line.',
  },
  {
    kind: 'synthetic',
    id: 'illustration-real-dive',
    title: 'A genuine spiral dive — repaired: nothing',
    utcOffsetHours: 11,
    zoneLabel: 'AEDT',
    expectRepairs: false,
    build() {
      const fixes: IGCFix[] = [];
      for (let t = 0; t <= 240; t++) {
        // Cruise, then a −18 m/s spiral for 40 s, then level: an extreme but
        // real manoeuvre. BOTH channels descend together.
        const alt = t < 80 ? 2200 : t <= 120 ? 2200 - (t - 80) * 18 : 1480;
        const gnss = alt + wobble(t, 3, 13);
        const baro = alt - 45 + wobble(t, 3, 23);
        fixes.push(synthFix(t, gnss + wobble(t, 4, 41), baro));
      }
      return fixes;
    },
    caption:
      'Illustration (synthetic data, real cleaning engine): a spiral dive sheds 720 m in ' +
      '40 seconds — dramatic, but real, and the barometer plunges in step with the GPS. ' +
      'The difference between the channels never moves, so nothing is flagged and nothing ' +
      'is repaired. The cleaned line is simply the raw GPS line.',
  },
  {
    kind: 'synthetic',
    id: 'illustration-sea-level',
    title: 'A beach landing at 0 m — repaired: nothing',
    utcOffsetHours: 11,
    zoneLabel: 'AEDT',
    expectRepairs: false,
    build() {
      const fixes: IGCFix[] = [];
      for (let t = 0; t <= 240; t++) {
        // Coastal glide-out from 300 m to a landing at ~2 m, then stationary
        // on the sand. Both channels agree all the way down.
        const alt = Math.max(2, 300 - t * 1.6);
        const gnss = Math.max(1, alt + wobble(t, 2, 17));
        const baro = alt + 12 + wobble(t, 2, 29);
        fixes.push(synthFix(t, gnss, baro));
      }
      return fixes;
    },
    caption:
      'Illustration (synthetic data, real cleaning engine): a slow coastal glide-out to a ' +
      'beach landing at essentially 0 m. Every step is gentle and the barometer agrees ' +
      'throughout, so the sea-level altitudes are kept exactly as logged — an altitude is ' +
      'never treated as wrong because of its value, only because the physics says it ' +
      'cannot be real.',
  },
];

// --- tiny chart helpers (mirrors the SPA's chart-utils conventions) --------

const W = 560;
const H = 250;
const M = { top: 14, right: 118, bottom: 30, left: 52 };

function scale(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Round-number axis ticks covering [min, max] (min may be negative). */
function yTicks(min: number, max: number): number[] {
  const span = max - min;
  const step = span > 8000 ? 4000 : span > 4000 ? 2000 : span > 1600 ? 1000 : span > 800 ? 500 : 200;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return ticks;
}

function fmtTime(ms: number, offsetH: number): string {
  const d = new Date(ms + offsetH * 3_600_000);
  return d.toISOString().slice(11, 19);
}

function path(points: Array<[number, number]>): string {
  return points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join('');
}

// ---------------------------------------------------------------------------
// Figure renderer (shared by real and synthetic examples)
// ---------------------------------------------------------------------------

interface FigureData {
  id: string;
  title: string;
  fixes: IGCFix[];
  /** Repaired ranges intersecting the window. */
  ranges: AltitudeRepairRange[];
  caption: string;
  /** False for scoring-server exports whose baro channel reads 0. */
  baroAlive: boolean;
  utcOffsetHours: number;
  zoneLabel: string;
}

function renderFigure(d: FigureData): string {
  const { fixes } = d;
  const t0 = fixes[0].time.getTime();
  const t1 = fixes[fixes.length - 1].time.getTime();

  // Domain covers every raw value — a glitch can plunge kilometres BELOW
  // zero, and clipping it off-frame would hide exactly what the figure is
  // here to show. Zero stays in frame when the baro baseline sits there.
  const rawAlts = fixes.map((f) => f.gnssAltitude);
  const baroAlts = fixes.map((f) => f.pressureAltitude);
  const all = d.baroAlive ? [...rawAlts, ...baroAlts] : [0, ...rawAlts];
  const step = 500;
  const yMax = Math.ceil(Math.max(...all) / step) * step;
  const yMin = Math.floor(Math.min(0, ...all) / step) * step;
  const x = scale([t0, t1], [M.left, W - M.right]);
  const y = scale([yMin, yMax], [H - M.bottom, M.top]);

  const gpsPts = fixes.map((f): [number, number] => [x(f.time.getTime()), y(f.gnssAltitude)]);
  const baroPts = fixes.map((f): [number, number] => [x(f.time.getTime()), y(f.pressureAltitude)]);
  const cleanPts = fixes.map((f): [number, number] => [x(f.time.getTime()), y(fixAltitude(f))]);

  const ticks = yTicks(yMin, yMax);
  const xTickMs = [t0, (t0 + t1) / 2, t1];
  const ariaLabel = `${d.title}. Line chart of altitude against time. ${d.caption}`;

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push(`<figure id="${d.id}" class="mb-8">`);
  push(`  <h3 class="text-base font-semibold mb-2">${d.title}</h3>`);
  push(`  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ariaLabel.replace(/"/g, '&quot;')}" class="w-full h-auto">`);
  // gridlines
  for (const t of ticks) {
    push(`    <line x1="${M.left}" x2="${W - M.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="stroke-border" stroke-width="1" />`);
  }
  // repaired band(s), padded half a fix either side so single-fix repairs
  // stay visible
  for (const r of d.ranges) {
    const bandX0 = x(r.startTimeMs - 1500);
    const bandX1 = x(r.endTimeMs + 1500);
    push(`    <rect x="${bandX0.toFixed(1)}" y="${M.top}" width="${(bandX1 - bandX0).toFixed(1)}" height="${H - M.top - M.bottom}" class="fill-chart-2/10" />`);
  }
  // axis labels
  push(`    <g aria-hidden="true" class="text-[10px] text-muted-foreground">`);
  for (const t of ticks) {
    // The topmost tick would collide with the "m" unit label — skip its text
    // (the gridline stays).
    if (y(t) < M.top + 10) continue;
    push(`      <text x="${M.left - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" class="fill-current">${t.toLocaleString('en-AU')}</text>`);
  }
  push(`      <text x="${M.left - 6}" y="${M.top - 3}" text-anchor="end" class="fill-current">m</text>`);
  for (const tm of xTickMs) {
    push(`      <text x="${x(tm).toFixed(1)}" y="${H - M.bottom + 14}" text-anchor="middle" class="fill-current">${fmtTime(tm, d.utcOffsetHours)}</text>`);
  }
  push(`      <text x="${W - M.right}" y="${H - 4}" text-anchor="end" class="fill-current">${d.zoneLabel} (UTC+${d.utcOffsetHours})</text>`);
  push(`    </g>`);
  // series: barometer first (underneath), then raw GPS, cleaned on top
  push(`    <path d="${path(baroPts)}" fill="none" class="stroke-chart-3" stroke-width="1.5" />`);
  push(`    <path d="${path(gpsPts)}" fill="none" class="stroke-chart-1" stroke-width="1.5" />`);
  push(`    <path d="${path(cleanPts)}" fill="none" class="stroke-chart-2" stroke-width="2.5" stroke-dasharray="6 3" />`);
  // direct labels at the right edge (identity never colour-alone: the dash
  // pattern and these labels carry it too)
  const labelX = W - M.right + 6;
  const gpsEndY = gpsPts[gpsPts.length - 1][1];
  const cleanEndY = cleanPts[cleanPts.length - 1][1];
  const baroEndY = baroPts[baroPts.length - 1][1];
  // Cleaned and raw GPS coincide outside repairs — nudge labels apart; same
  // for a barometer hugging the GPS line.
  const cleanLabelY = Math.abs(cleanEndY - gpsEndY) < 12 ? gpsEndY - 12 : cleanEndY;
  let baroLabelY = d.baroAlive ? baroEndY + 12 : baroEndY - 4;
  if (Math.abs(baroLabelY - gpsEndY) < 12) baroLabelY = gpsEndY + 14;
  // Keep the label inside the plot (a line ending at the bottom edge would
  // push it into the x-axis ticks); if the clamp lands it on the other
  // labels, stack it above them instead.
  const labelMaxY = H - M.bottom - 4;
  if (baroLabelY > labelMaxY) baroLabelY = labelMaxY;
  if (Math.abs(baroLabelY - gpsEndY) < 12 || Math.abs(baroLabelY - cleanLabelY) < 12) {
    baroLabelY = Math.min(gpsEndY, cleanLabelY) - 12;
  }
  const baroLabel = d.baroAlive ? 'barometer' : 'barometer (logged 0)';
  push(`    <g aria-hidden="true" class="text-[10px]">`);
  push(`      <text x="${labelX}" y="${(gpsEndY + 3).toFixed(1)}" class="fill-current text-chart-1">raw GPS</text>`);
  push(`      <text x="${labelX}" y="${(cleanLabelY + 3).toFixed(1)}" class="fill-current text-chart-2">cleaned</text>`);
  push(`      <text x="${labelX}" y="${(baroLabelY + 3).toFixed(1)}" class="fill-current text-chart-3">${baroLabel}</text>`);
  push(`    </g>`);
  push(`  </svg>`);
  // legend (HTML, text in muted ink, swatches carry identity)
  push(`  <div aria-hidden="true" class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">`);
  push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4 bg-chart-1"></span>raw GPS altitude</span>`);
  push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4 bg-chart-3"></span>raw barometric altitude</span>`);
  push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4 border-t-2 border-dashed border-chart-2"></span>cleaned</span>`);
  if (d.ranges.length > 0) {
    push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block h-3 w-3 bg-chart-2/10 border border-border"></span>repaired fixes</span>`);
  }
  push(`  </div>`);
  push(`  <figcaption class="mt-2 text-sm text-muted-foreground leading-relaxed">${d.caption}</figcaption>`);
  push(`</figure>`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Data acquisition per example kind
// ---------------------------------------------------------------------------

function buildReal(ex: RealExample): string {
  const file = join(COMPS_DIR!, ex.track);
  const igc = parseIGC(readFileSync(file, 'utf8'));
  const report = igc.altitudeCleaning;
  if (report.repairedFixCount === 0) throw new Error(`${ex.track}: nothing repaired`);
  const ranges = [...report.ranges].sort(
    (a, b) => b.maxCorrectionMeters - a.maxCorrectionMeters,
  );
  const range = ranges[ex.rangeRank];

  const t0 = range.startTimeMs - ex.contextSeconds * 1000;
  const t1 = range.endTimeMs + ex.contextSeconds * 1000;
  const fixes = igc.fixes.filter((f) => {
    const t = f.time.getTime();
    return t >= t0 && t <= t1;
  });

  const cleanedNow = fixes.find((f) => f.cleanedAltitude !== undefined);
  const trueAlt = Math.round(cleanedNow ? fixAltitude(cleanedNow) : fixes[0].gnssAltitude);
  const timeLabel = `${fmtTime(range.startTimeMs, ex.utcOffsetHours)} ${ex.zoneLabel}`;
  const caption =
    `${ex.caption} ${range.fixCount} fix${range.fixCount === 1 ? '' : 'es'} around ` +
    `${timeLabel} repaired; the largest was ${Math.round(range.maxCorrectionMeters).toLocaleString('en-AU')} m ` +
    `from the true ~${trueAlt.toLocaleString('en-AU')} m. The barometric channel reads 0 for the whole ` +
    `flight — this scoring-server export carries no barometer, so the vertical-speed rule made the call.`;

  return renderFigure({
    id: ex.id,
    title: ex.title,
    fixes,
    ranges: [range],
    caption,
    baroAlive: false,
    utcOffsetHours: ex.utcOffsetHours,
    zoneLabel: ex.zoneLabel,
  });
}

function buildSynthetic(ex: SyntheticExample): string {
  const fixes = ex.build();
  // The REAL engine judges the fabricated track — the figure shows its
  // actual output, and the expectation is asserted so a behaviour change
  // can't ship a stale story.
  const report = cleanAltitudes(fixes);
  if (ex.expectRepairs && report.repairedFixCount === 0) {
    throw new Error(`${ex.id}: expected repairs, engine made none`);
  }
  if (!ex.expectRepairs && report.repairedFixCount > 0) {
    throw new Error(`${ex.id}: expected no repairs, engine repaired ${report.repairedFixCount}`);
  }
  if (ex.expectRepairs && !report.crossChecked) {
    throw new Error(`${ex.id}: expected the cross-channel path`);
  }

  let caption = ex.caption;
  if (report.ranges.length > 0) {
    const r = report.ranges[0];
    caption +=
      ` ${report.repairedFixCount} fix${report.repairedFixCount === 1 ? '' : 'es'} repaired, ` +
      `largest correction ${Math.round(r.maxCorrectionMeters).toLocaleString('en-AU')} m.`;
  }

  return renderFigure({
    id: ex.id,
    title: ex.title,
    fixes,
    ranges: report.ranges,
    caption,
    baroAlive: true,
    utcOffsetHours: ex.utcOffsetHours,
    zoneLabel: ex.zoneLabel,
  });
}

function buildExample(ex: Example): string {
  return ex.kind === 'real' ? buildReal(ex) : buildSynthetic(ex);
}

// ---------------------------------------------------------------------------
// Emit both components
// ---------------------------------------------------------------------------

const header = (what: string) => `---
/**
 * GENERATED by web/scripts/generate-data-cleaning-charts.ts — do not edit.
 * ${what}
 * Re-run the generator (against the glidecomp-archive checkout) and commit
 * to update.
 */
---

`;

const outDir = join(import.meta.dir, '..', 'frontend', 'static', 'src', 'components');

writeFileSync(
  join(outDir, 'DataCleaningCharts.astro'),
  header(
    'Real segments of archive tracklogs (glidecomp-archive) drawn as raw GPS /\n * raw barometer / cleaned altitude, for /scoring/data-cleaning.',
  ) + REAL.map(buildExample).join('\n\n') + '\n',
);
writeFileSync(
  join(outDir, 'DataCleaningChartsSynthetic.astro'),
  header(
    'SYNTHETIC two-channel scenarios fed through the real cleanAltitudes\n * engine (labelled as illustrations on the page) — the barometer\n * cross-check, which archive exports cannot show.',
  ) + SYNTHETIC.map(buildExample).join('\n\n') + '\n',
);
console.log(`wrote DataCleaningCharts.astro + DataCleaningChartsSynthetic.astro in ${outDir}`);
