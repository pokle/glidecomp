// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Generate the static SVG figures on /scoring/data-cleaning from REAL
 * tracklogs: segments of archive IGC files whose altitudes the engine's
 * cleaning pass repaired, drawn as raw GPS vs raw barometer vs cleaned.
 *
 *   GLIDECOMP_COMPS_DIR=<glidecomp-archive>/comps \
 *     bun web/scripts/generate-data-cleaning-charts.ts
 *
 * Output is the checked-in web/frontend/static/src/components/
 * DataCleaningCharts.astro (byte-stable for the same inputs — commit it).
 * The archive repo holds the tracks, so this is a run-and-commit generator
 * like generate-big-chip, not a build step.
 *
 * Chart conventions (docs/accessibility-standard.md + the site tokens):
 * zero-based altitude axis, series identity carried by hue AND line style
 * (cleaned is dashed — never colour alone), direct labels + a legend, exact
 * numbers in the visible caption, no client JS.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIGC, fixAltitude, type IGCFile } from '../engine/src/igc-parser';

const COMPS_DIR = process.env.GLIDECOMP_COMPS_DIR;
if (!COMPS_DIR) {
  console.error('GLIDECOMP_COMPS_DIR must point at the glidecomp-archive comps/ checkout');
  process.exit(1);
}

interface Example {
  /** Track path relative to the comps dir. */
  track: string;
  /** Stable DOM id for the figure. */
  id: string;
  title: string;
  /** Which repaired range to frame (index into report.ranges, by max correction rank). */
  rangeRank: number;
  /** Seconds of context either side of the repaired range. */
  contextSeconds: number;
  /** Fixed UTC offset for axis labels (comp-local time), and its name. */
  utcOffsetHours: number;
  zoneLabel: string;
  /** One-sentence figcaption lead-in; exact numbers are appended. */
  caption: string;
}

const EXAMPLES: Example[] = [
  {
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
  const step = span > 8000 ? 4000 : span > 4000 ? 2000 : span > 1600 ? 1000 : 500;
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

// --- figure builder --------------------------------------------------------

function buildFigure(ex: Example): string {
  const file = join(COMPS_DIR!, ex.track);
  const igc: IGCFile = parseIGC(readFileSync(file, 'utf8'));
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

  // Domain covers every raw value — a glitch can plunge kilometres BELOW
  // zero, and clipping it off-frame would hide exactly what the figure is
  // here to show. Zero always stays in frame (the barometer baseline).
  const rawMax = Math.max(0, ...fixes.map((f) => f.gnssAltitude));
  const rawMin = Math.min(0, ...fixes.map((f) => f.gnssAltitude));
  const yMax = Math.ceil(rawMax / 500) * 500;
  const yMin = Math.floor(rawMin / 500) * 500;
  const x = scale([t0, t1], [M.left, W - M.right]);
  const y = scale([yMin, yMax], [H - M.bottom, M.top]);

  const gpsPts = fixes.map((f): [number, number] => [x(f.time.getTime()), y(f.gnssAltitude)]);
  const baroPts = fixes.map((f): [number, number] => [x(f.time.getTime()), y(f.pressureAltitude)]);
  const cleanPts = fixes.map((f): [number, number] => [x(f.time.getTime()), y(fixAltitude(f))]);

  const ticks = yTicks(yMin, yMax);
  const xTickMs = [t0, (t0 + t1) / 2, t1];

  const cleanedNow = fixes.find((f) => f.cleanedAltitude !== undefined);
  const trueAlt = Math.round(cleanedNow ? fixAltitude(cleanedNow) : fixes[0].gnssAltitude);
  const timeLabel = `${fmtTime(range.startTimeMs, ex.utcOffsetHours)} ${ex.zoneLabel}`;
  const caption =
    `${ex.caption} ${range.fixCount} fix${range.fixCount === 1 ? '' : 'es'} around ` +
    `${timeLabel} repaired; the largest was ${Math.round(range.maxCorrectionMeters).toLocaleString('en-AU')} m ` +
    `from the true ~${trueAlt.toLocaleString('en-AU')} m. The barometric channel reads 0 for the whole ` +
    `flight — this scoring-server export carries no barometer, so the vertical-speed rule made the call.`;
  const ariaLabel =
    `${ex.title}. Line chart of altitude against time. ${caption}`;

  // Repaired-time band, padded half a fix either side so single-fix repairs
  // stay visible.
  const bandX0 = x(range.startTimeMs - 1500);
  const bandX1 = x(range.endTimeMs + 1500);

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  push(`<figure id="${ex.id}" class="mb-8">`);
  push(`  <h3 class="text-base font-semibold mb-2">${ex.title}</h3>`);
  push(`  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${ariaLabel.replace(/"/g, '&quot;')}" class="w-full h-auto">`);
  // gridlines
  for (const t of ticks) {
    push(`    <line x1="${M.left}" x2="${W - M.right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="stroke-border" stroke-width="1" />`);
  }
  // repaired band
  push(`    <rect x="${bandX0.toFixed(1)}" y="${M.top}" width="${(bandX1 - bandX0).toFixed(1)}" height="${H - M.top - M.bottom}" class="fill-chart-2/10" />`);
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
    push(`      <text x="${x(tm).toFixed(1)}" y="${H - M.bottom + 14}" text-anchor="middle" class="fill-current">${fmtTime(tm, ex.utcOffsetHours)}</text>`);
  }
  push(`      <text x="${W - M.right}" y="${H - 4}" text-anchor="end" class="fill-current">${ex.zoneLabel} (UTC+${ex.utcOffsetHours})</text>`);
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
  // Cleaned and raw GPS coincide outside the repair — nudge labels apart.
  const cleanLabelY = Math.abs(cleanEndY - gpsEndY) < 12 ? gpsEndY - 12 : cleanEndY;
  push(`    <g aria-hidden="true" class="text-[10px]">`);
  push(`      <text x="${labelX}" y="${(gpsEndY + 3).toFixed(1)}" class="fill-current text-chart-1">raw GPS</text>`);
  push(`      <text x="${labelX}" y="${(cleanLabelY + 3).toFixed(1)}" class="fill-current text-chart-2">cleaned</text>`);
  push(`      <text x="${labelX}" y="${(baroEndY - 4).toFixed(1)}" class="fill-current text-chart-3">barometer (logged 0)</text>`);
  push(`    </g>`);
  push(`  </svg>`);
  // legend (HTML, text in muted ink, swatches carry identity)
  push(`  <div aria-hidden="true" class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">`);
  push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4 bg-chart-1"></span>raw GPS altitude</span>`);
  push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block h-0.5 w-4 bg-chart-3"></span>raw barometric altitude</span>`);
  push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block w-4 border-t-2 border-dashed border-chart-2"></span>cleaned</span>`);
  push(`    <span class="inline-flex items-center gap-1.5"><span class="inline-block h-3 w-3 bg-chart-2/10 border border-border"></span>repaired fixes</span>`);
  push(`  </div>`);
  push(`  <figcaption class="mt-2 text-sm text-muted-foreground leading-relaxed">${caption}</figcaption>`);
  push(`</figure>`);
  return lines.join('\n');
}

const figures = EXAMPLES.map(buildFigure).join('\n\n');

const out = `---
/**
 * GENERATED by web/scripts/generate-data-cleaning-charts.ts — do not edit.
 * Real segments of archive tracklogs (glidecomp-archive) drawn as raw GPS /
 * raw barometer / cleaned altitude, for /scoring/data-cleaning. Re-run the
 * generator against the archive checkout and commit to update.
 */
---

${figures}
`;

const outPath = join(
  import.meta.dir,
  '..',
  'frontend',
  'static',
  'src',
  'components',
  'DataCleaningCharts.astro',
);
writeFileSync(outPath, out);
console.log(`wrote ${outPath}`);
