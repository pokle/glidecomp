// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Plain-text rendering of field-analysis reports (~100 columns, monospace).
 *
 * Generic over the report model: a Stage 1 metric added to its family array
 * shows up here with zero renderer changes — explanation line, a column in
 * the family's per-pilot table, its fieldSummary/extraTables, and a row in
 * the correlation ranking.
 */

import { FAMILY_LABELS, FAMILY_ORDER } from './registry';
import { MIN_CORRELATION_N } from './evaluate';
import type {
  CompAggregateReport,
  FieldAnalysisReport,
  MetricReport,
  ReportTable,
} from './types';

const WIDTH = 100;

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function heading(title: string, char: string): string {
  const head = `${char.repeat(3)} ${title} `;
  return head + char.repeat(Math.max(0, WIDTH - head.length));
}

/** Format a metric value for its unit. */
export function formatMetricValue(unit: string, value: number | null): string {
  if (value === null || !isFinite(value)) return '—';
  switch (unit) {
    case 'pct':
    case 'm':
    case 's':
      return value.toFixed(0);
    case 'm/s':
    case 'km/h':
    case 'min':
    case 'count':
      return value.toFixed(1);
    case 'ratio':
      return value.toFixed(2);
    default:
      return value.toFixed(1);
  }
}

function columnHeader(m: MetricReport): string {
  return m.shortLabel ?? (m.label.length <= 10 ? m.label : m.label.slice(0, 10));
}

function renderTable(t: ReportTable): string[] {
  const widths = t.columns.map((c, i) =>
    Math.max(c.header.length, ...t.rows.map((r) => (r[i] ?? '').length)),
  );
  const pad = (s: string, i: number): string =>
    t.columns[i].align === 'left' ? padRight(s, widths[i]) : padLeft(s, widths[i]);
  const lines: string[] = [];
  lines.push(t.title + ':');
  const headerLine = '  ' + t.columns.map((c, i) => pad(c.header, i)).join('  ');
  lines.push(headerLine);
  lines.push('  ' + '-'.repeat(Math.max(0, headerLine.length - 2)));
  for (const row of t.rows) {
    lines.push('  ' + row.map((cell, i) => pad(cell ?? '', i)).join('  '));
  }
  for (const f of t.footnotes ?? []) lines.push(`  ${f}`);
  return lines;
}

export function renderFieldReport(report: FieldAnalysisReport): string {
  const lines: string[] = [];
  const b = report.basis;

  lines.push(heading('Field Analysis', '='));
  lines.push(
    `Basis: ${b.pilotCount} scored pilots · grid ${b.gridStepSeconds} s · ` +
      `${b.sharedThermalCount} shared thermals (${b.multiPilotThermalCount} multi-pilot) · ` +
      `working band ${b.workingBandFloor.toFixed(0)}–${b.workingBandCeiling.toFixed(0)} m` +
      (b.workingBandFallback ? ' (fix-altitude fallback)' : '') +
      ` · phases cover ${b.phaseCoveragePct.toFixed(1)}% of flight time`,
  );

  // The separation ranking leads: it tells the reader which strategies
  // actually mattered on this task, and so how to read everything below.
  lines.push('', heading('Metric separation ranking (Spearman ρ vs GAP rank)', '-'));
  lines.push(...renderCorrelationTable(report));

  for (const family of FAMILY_ORDER) {
    const metrics = report.metrics.filter((m) => m.family === family);
    if (metrics.length === 0) continue;
    lines.push('');
    lines.push(heading(FAMILY_LABELS[family], '-'));

    // Method lines — the explainability rule: every number's derivation in
    // one sentence, printed with the numbers.
    for (const m of metrics) {
      lines.push(`• ${m.label} [${m.unit}]: ${m.explanation}`);
      if (m.error) lines.push(`  ERROR computing this metric: ${m.error}`);
    }

    // One per-pilot table per family, a column per metric that has values.
    const tabular = metrics.filter((m) => m.perPilot.some((v) => v.value !== null));
    if (tabular.length > 0) {
      const table: ReportTable = {
        title: 'Per pilot (rank order)',
        columns: [
          { header: '#', align: 'right' },
          { header: 'Pilot', align: 'left' },
          ...tabular.map((m) => ({ header: columnHeader(m), align: 'right' as const })),
        ],
        rows: report.pilots.map((p, i) => [
          String(p.rank),
          p.pilotName.slice(0, 22),
          ...tabular.map((m) => formatMetricValue(m.unit, m.perPilot[i].value)),
        ]),
      };
      lines.push('', ...renderTable(table));
    }

    for (const m of metrics) {
      if (m.fieldSummary?.length) {
        lines.push('');
        for (const s of m.fieldSummary) lines.push(s);
      }
      for (const t of m.extraTables ?? []) {
        lines.push('', ...renderTable(t));
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderCorrelationTable(report: FieldAnalysisReport): string[] {
  const withCorr = report.metrics
    .filter((m) => m.correlation !== null)
    .sort((a, b) => b.correlation!.absRho - a.correlation!.absRho);
  const without = report.metrics.filter(
    (m) => m.correlation === null && m.perPilot.some((v) => v.value !== null),
  );

  if (withCorr.length === 0 && without.length === 0) {
    return ['(no per-pilot metrics registered yet)'];
  }

  const table: ReportTable = {
    title: 'Ranked by |ρ| — the metrics that separate the leaderboard hardest',
    columns: [
      { header: 'Metric', align: 'left' },
      { header: 'ρ', align: 'right' },
      { header: '|ρ|', align: 'right' },
      { header: 'n', align: 'right' },
      { header: 'direction', align: 'left' },
      { header: 'verdict', align: 'left' },
    ],
    rows: [
      ...withCorr.map((m) => {
        const c = m.correlation!;
        return [m.id, c.rho.toFixed(2), c.absRho.toFixed(2), String(c.n), m.direction, c.verdict];
      }),
      ...without.map((m) => [m.id, '—', '—', '—', m.direction, 'not enough data']),
    ],
    footnotes: [
      'Rank 1 is best, so a well-behaved "higher" metric shows NEGATIVE ρ and a "lower" metric positive ρ.',
      `For "neutral" metrics the sign itself is the finding. Verdicts need n ≥ ${MIN_CORRELATION_N}.`,
    ],
  };
  return renderTable(table);
}

export function renderCompReport(report: CompAggregateReport): string {
  const lines: string[] = [];
  lines.push(heading('Competition Field Analysis', '='));

  // Separation first here too — task-by-task ρ columns show which strategies
  // mattered on which day; the standings are context, not the headline.
  const ranked = [...report.metrics].sort(
    (a, b) => (b.meanAbsRho ?? -1) - (a.meanAbsRho ?? -1),
  );
  const separation: ReportTable = {
    title: 'Metric separation across the comp (Spearman ρ vs rank, per task and comp-level)',
    columns: [
      { header: 'Metric', align: 'left' },
      ...report.taskLabels.map((l) => ({ header: l, align: 'right' as const })),
      { header: 'mean|ρ|', align: 'right' },
      { header: 'comp ρ', align: 'right' },
      { header: 'n', align: 'right' },
      { header: 'verdict', align: 'left' },
    ],
    rows: ranked.map((m) => [
      m.id,
      ...m.perTaskRho.map((r) => (r === null ? '—' : r.toFixed(2))),
      m.meanAbsRho === null ? '—' : m.meanAbsRho.toFixed(2),
      m.compRho ? m.compRho.rho.toFixed(2) : '—',
      m.compRho ? String(m.compRho.n) : '—',
      m.compRho?.verdict ?? '—',
    ]),
    footnotes: [
      'comp ρ correlates each pilot\'s cross-task metric mean against their comp rank (total score).',
      'Read the per-task columns to see which strategies mattered on which day.',
    ],
  };
  lines.push('', ...renderTable(separation));

  const standings: ReportTable = {
    title: `Comp standings (${report.taskLabels.length} tasks)`,
    columns: [
      { header: '#', align: 'right' },
      { header: 'Pilot', align: 'left' },
      { header: 'Tasks', align: 'right' },
      { header: 'Total', align: 'right' },
    ],
    rows: report.pilots.map((p) => [
      String(p.rank),
      p.name.slice(0, 25),
      String(p.taskCount),
      p.totalScore.toFixed(1),
    ]),
  };
  lines.push('', ...renderTable(standings));
  lines.push('');
  return lines.join('\n');
}
