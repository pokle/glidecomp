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
import { clusterPilotStyles, MIN_CLUSTER_PILOTS, type StyleClusterReport } from './clustering';
import { timeWithZone, timeRangeWithZone } from './format-time';
import type {
  CompAggregateReport,
  CompMetricAggregate,
  FieldAnalysisReport,
  MetricReport,
  ReportCell,
  ReportTable,
} from './types';

const WIDTH = 100;

/** Options for the text renderers. */
export interface RenderReportOptions {
  /** IANA zone for `{ t }` time cells (the task's local zone). UTC when unset. */
  timeZone?: string;
}

/** A report cell as display text: literal strings pass through; `{ t }`
 * instants render as a time of day and `{ from, to }` as a range, in `timeZone`
 * ("14:00 AEDT", "13:05–14:30 AEDT", "13:00 UTC"). */
function cellText(cell: ReportCell | undefined, timeZone?: string): string {
  if (cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if ('t' in cell) return timeWithZone(new Date(cell.t).getTime(), timeZone);
  return timeRangeWithZone(new Date(cell.from).getTime(), new Date(cell.to).getTime(), timeZone);
}

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

/** Format a metric value for its unit. The display tokens ('mph', 'kts',
 * 'fpm', 'ft') are what the UI's preferred-unit conversion rewrites 'km/h',
 * 'm/s' and 'm' into; the engine itself always emits the metric units. */
export function formatMetricValue(unit: string, value: number | null): string {
  if (value === null || !isFinite(value)) return '—';
  switch (unit) {
    case 'pct':
    case 'm':
    case 'ft':
    case 'fpm':
    case 's':
      return value.toFixed(0);
    case 'm/s':
    case 'km/h':
    case 'mph':
    case 'kts':
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

function renderTable(t: ReportTable, timeZone?: string): string[] {
  // Format cells to display text first ({ t } instants → zoned time) so column
  // widths measure the rendered strings, not the ISO payloads.
  const text = t.rows.map((r) => t.columns.map((_c, i) => cellText(r[i], timeZone)));
  const widths = t.columns.map((c, i) =>
    Math.max(c.header.length, ...text.map((r) => r[i].length)),
  );
  const pad = (s: string, i: number): string =>
    t.columns[i].align === 'left' ? padRight(s, widths[i]) : padLeft(s, widths[i]);
  const lines: string[] = [];
  lines.push(t.title + ':');
  const headerLine = '  ' + t.columns.map((c, i) => pad(c.header, i)).join('  ');
  lines.push(headerLine);
  lines.push('  ' + '-'.repeat(Math.max(0, headerLine.length - 2)));
  for (const row of text) {
    lines.push('  ' + row.map((cell, i) => pad(cell, i)).join('  '));
  }
  for (const f of t.footnotes ?? []) lines.push(`  ${f}`);
  return lines;
}

export function renderFieldReport(
  report: FieldAnalysisReport,
  opts: RenderReportOptions = {},
): string {
  const { timeZone } = opts;
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
        lines.push('', ...renderTable(t, timeZone));
      }
    }
  }

  lines.push('', heading('Pilot style clusters (who flew alike)', '-'));
  lines.push(...renderStyleClusters(clusterPilotStyles(report)));

  lines.push('');
  return lines.join('\n');
}

/** A rank statistic for display: whole ranks stay whole, an even-count
 * median shows its half. */
function fmtRank(r: number): string {
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function renderStyleClusters(sc: StyleClusterReport | null): string[] {
  if (sc === null) {
    return [
      `(not clustered: fewer than ${MIN_CLUSTER_PILOTS} pilots with enough metric coverage to compare)`,
    ];
  }
  const lines: string[] = [];
  lines.push(
    `Clustered ${sc.pilotCount} pilots on ${sc.metricCount} behavioural metrics into ` +
      `${sc.k} groups (mean silhouette ${sc.meanSilhouette.toFixed(2)}, k searched ${sc.kMin}–${sc.kMax}).`,
  );
  lines.push(
    'Method: within-field percentile per metric, Gower distance over the metrics both pilots have',
    '(nothing imputed), Ward-linkage tree cut at the best-silhouette k. Groups are STYLE, the rank',
    'spread beside each is where that style did and did not pay. Silhouette ≈ 0 means the group',
    'boundaries are soft; nearer 1 means tight, well-separated groups.',
  );
  for (const c of sc.clusters) {
    lines.push(
      '',
      `Group ${c.id} — ${c.members.length} pilots · ranks ${c.rankBest}–${c.rankWorst} ` +
        `(median ${fmtRank(c.rankMedian)}, middle half ${fmtRank(c.rankP25)}–${fmtRank(c.rankP75)})`,
    );
    if (c.signatures.length === 0) {
      lines.push('  • no strong signature — near field-typical on every metric');
    }
    for (const s of c.signatures) {
      lines.push(
        `  • ${s.deviation > 0 ? 'high' : 'low'} ${s.label}: group median P${s.medianPercentile.toFixed(0)} ` +
          `vs field P50 (${formatMetricValue(s.unit, s.medianValue)} ${s.unit})`,
      );
    }
    // Members wrapped to the report width; '*' marks the group's most
    // typical pilot (smallest mean style distance to the rest).
    const parts = c.members.map(
      (m) => `${m.rank}. ${m.pilotName}${m.trackFile === c.exemplarTrackFile ? '*' : ''}`,
    );
    let line = ' ';
    for (const part of parts) {
      if (line.length + part.length + 3 > WIDTH && line.trim() !== '') {
        lines.push(line);
        line = ' ';
      }
      line += ` ${part} ·`;
    }
    if (line.trim() !== '') lines.push(line.replace(/ ·$/, ''));
  }
  lines.push('  * most typical of its group (smallest mean style distance to the rest)');
  if (sc.unclustered.length > 0) {
    lines.push('', 'Not clustered:');
    for (const u of sc.unclustered) {
      lines.push(`  ${u.rank}. ${u.pilotName} — ${u.reason}`);
    }
  }
  return lines;
}

const CORRELATION_COLUMNS: ReportTable['columns'] = [
  { header: 'Metric', align: 'left' },
  { header: 'ρ', align: 'right' },
  { header: '|ρ|', align: 'right' },
  { header: 'n', align: 'right' },
  { header: 'direction', align: 'left' },
  { header: 'verdict', align: 'left' },
];

function correlationRows(metrics: MetricReport[]): ReportCell[][] {
  const withCorr = metrics
    .filter((m) => m.correlation !== null)
    .sort((a, b) => b.correlation!.absRho - a.correlation!.absRho);
  const without = metrics.filter(
    (m) => m.correlation === null && m.perPilot.some((v) => v.value !== null),
  );
  return [
    ...withCorr.map((m) => {
      const c = m.correlation!;
      return [m.id, c.rho.toFixed(2), c.absRho.toFixed(2), String(c.n), m.direction, c.verdict];
    }),
    ...without.map((m) => [m.id, '—', '—', '—', m.direction, 'not enough data']),
  ];
}

function renderCorrelationTable(report: FieldAnalysisReport): string[] {
  // Outcome-derived metrics (time behind the leader, …) correlate with rank
  // by construction, so ranking them among the behaviours would make the
  // headline a non-finding. They get their own table, framed as what they
  // are: eval sanity checks.
  const behavioural = correlationRows(report.metrics.filter((m) => !m.outcome));
  const outcome = correlationRows(report.metrics.filter((m) => m.outcome));

  if (behavioural.length === 0 && outcome.length === 0) {
    return ['(no per-pilot metrics registered yet)'];
  }

  const lines: string[] = [];
  if (behavioural.length > 0) {
    lines.push(
      ...renderTable({
        title: 'Ranked by |ρ| — the behaviours that separate the leaderboard hardest',
        columns: CORRELATION_COLUMNS,
        rows: behavioural,
        footnotes: [
          'Rank 1 is best, so a well-behaved "higher" metric shows NEGATIVE ρ and a "lower" metric positive ρ.',
          'For "neutral" metrics the sign itself is the finding.',
          'Verdicts: strong |ρ| ≥ 0.5, moderate ≥ 0.3, weak below — only after clearing the α = 0.05',
          `noise floor for that n ("within noise" otherwise); verdicts need n ≥ ${MIN_CORRELATION_N}.`,
          'With this many metrics ranked on one task, the top rows are partly luck — trust the',
          'metrics that repeat across tasks (whole-comp report).',
        ],
      }),
    );
  }
  if (outcome.length > 0) {
    lines.push(
      '',
      ...renderTable({
        title: 'Outcome checks — derived from the race outcome, so they correlate by construction',
        columns: CORRELATION_COLUMNS,
        rows: outcome,
        footnotes: ['A LOW |ρ| here questions the eval, not the flying.'],
      }),
    );
  }
  return lines;
}

export function renderCompReport(report: CompAggregateReport): string {
  const lines: string[] = [];
  lines.push(heading('Competition Field Analysis', '='));

  // Separation first here too — task-by-task ρ columns show which strategies
  // mattered on which day; the standings are context, not the headline.
  // Outcome-derived metrics rank apart, same as the per-task report: they
  // correlate by construction, so they must not top the behavioural ranking.
  // |mean signed ρ| ranks CONSISTENT separation: a metric flip-flopping
  // +0.5/−0.5 across tasks cancels here instead of ranking beside one that
  // is consistently −0.5 (its per-day power stays visible in mean|ρ|).
  const signedStrength = (m: CompMetricAggregate): number =>
    m.meanSignedRho === null ? -1 : Math.abs(m.meanSignedRho);
  const rankBySigned = (a: CompMetricAggregate, b: CompMetricAggregate): number =>
    signedStrength(b) - signedStrength(a);
  const ranked = report.metrics.filter((m) => !m.outcome).sort(rankBySigned);
  const outcomeRanked = report.metrics.filter((m) => m.outcome).sort(rankBySigned);
  const compColumns: ReportTable['columns'] = [
    { header: 'Metric', align: 'left' },
    ...report.taskLabels.map((l) => ({ header: l, align: 'right' as const })),
    { header: 'mean ρ', align: 'right' },
    { header: 'mean|ρ|', align: 'right' },
    { header: 'signs', align: 'left' },
    { header: 'comp ρ', align: 'right' },
    { header: 'n', align: 'right' },
    { header: 'verdict', align: 'left' },
  ];
  const signsCell = (m: CompMetricAggregate): string => {
    const s = m.signSummary;
    if (s.negative + s.positive === 0) return 'quiet';
    return `${s.negative}−/${s.positive}+ ${m.consistency}`;
  };
  const compRow = (m: CompMetricAggregate): ReportCell[] => [
    m.id,
    ...m.perTaskRho.map((r) => (r === null ? '—' : r.toFixed(2))),
    m.meanSignedRho === null ? '—' : m.meanSignedRho.toFixed(2),
    m.meanAbsRho === null ? '—' : m.meanAbsRho.toFixed(2),
    signsCell(m),
    m.compRho ? m.compRho.rho.toFixed(2) : '—',
    m.compRho ? String(m.compRho.n) : '—',
    m.compRho?.verdict ?? '—',
  ];
  const separation: ReportTable = {
    title: 'Metric separation across the comp (Spearman ρ vs rank, per task and comp-level)',
    columns: compColumns,
    rows: ranked.map(compRow),
    footnotes: [
      'comp ρ correlates each pilot\'s cross-task metric mean against their comp rank (total score).',
      'Ranked by |mean ρ| (n-weighted signed mean): flip-flopping tasks cancel, so consistent',
      'separation leads. mean|ρ| is per-day power regardless of direction — a large gap between',
      'the two means the payoff depended on the day.',
      'signs counts tasks whose |ρ| cleared their noise floor: − = larger value went with better',
      'ranks. A split is a finding (day-dependent payoff), not a defect.',
      'Verdicts: strong |ρ| ≥ 0.5, moderate ≥ 0.3, weak below — only after clearing the α = 0.05',
      'noise floor for that n ("within noise" otherwise).',
    ],
  };
  lines.push('', ...renderTable(separation));
  if (outcomeRanked.length > 0) {
    lines.push(
      '',
      ...renderTable({
        title: 'Outcome checks — derived from the race outcome, so they correlate by construction',
        columns: compColumns,
        rows: outcomeRanked.map(compRow),
        footnotes: ['A LOW |ρ| here questions the eval, not the flying.'],
      }),
    );
  }

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
