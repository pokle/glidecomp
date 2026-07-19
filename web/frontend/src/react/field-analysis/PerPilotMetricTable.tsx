/**
 * One family's per-pilot metric table: pilots down the side, that family's
 * metrics across the top.
 *
 * Deliberately ONE TABLE PER FAMILY rather than a single 26-column grid.
 * That is both the CLI's presentation and the single biggest accessibility
 * win here — a 3-to-6 column table is navigable; a 26-column one is not,
 * with a screen reader or without.
 *
 * Sortable, because the whole reason to look at a family is "who was best at
 * this" — scanning forty rows by eye for the biggest number is not an answer.
 * Default order is the published rank.
 */
import { useMemo, useState } from "react";
import type { SortDescriptor } from "react-aria-components";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { MetricExplanation, directionWords } from "./MetricExplanation";
import { formatMetricValue, type MetricReport, type FieldAnalysisReport } from "./types";

/** Unit names as words, for the column's accessible name. */
function unitWords(unit: string): string {
  switch (unit) {
    case "pct":
      return "percent";
    case "m":
      return "metres";
    case "m/s":
      return "metres per second";
    case "km/h":
      return "kilometres per hour";
    case "s":
      return "seconds";
    case "min":
      return "minutes";
    case "count":
      return "count";
    case "ratio":
      return "ratio";
    default:
      return unit;
  }
}

/**
 * The column's accessible name. WCAG 2.5.3 (Label in Name) requires the
 * visible text to be contained in the accessible name, so this EXTENDS the
 * short label rather than replacing it.
 */
function columnLabel(metric: MetricReport): string {
  const visible = metric.shortLabel ?? metric.label;
  const expansion =
    metric.shortLabel && metric.shortLabel !== metric.label ? `, ${metric.label}` : "";
  return `${visible}${expansion}, in ${unitWords(metric.unit)}, ${directionWords(metric.direction)}`;
}

export function PerPilotMetricTable({
  report,
  metrics,
  familyLabel,
}: {
  report: FieldAnalysisReport;
  metrics: MetricReport[];
  familyLabel: string;
}) {
  const [sort, setSort] = useState<SortDescriptor>({
    column: "rank",
    direction: "ascending",
  });

  const valuesByMetric = useMemo(() => {
    // perPilot is aligned to report.pilots by construction (evaluateField
    // re-aligns by trackFile), but key by trackFile anyway — pairing per-pilot
    // data by array index is exactly the bug this project bans.
    const map = new Map<string, Map<string, { value: number | null; note?: string }>>();
    for (const m of metrics) {
      map.set(
        m.id,
        new Map(m.perPilot.map((p) => [p.trackFile, { value: p.value, note: p.note }]))
      );
    }
    return map;
  }, [metrics]);

  const rows = useMemo(() => {
    const base = report.pilots.map((p) => ({
      ...p,
      values: new Map(
        metrics.map((m) => [m.id, valuesByMetric.get(m.id)?.get(p.trackFile)])
      ),
    }));
    const col = String(sort.column);
    const sorted = [...base].sort((a, b) => {
      if (col === "rank") return a.rank - b.rank;
      if (col === "pilot") return a.pilotName.localeCompare(b.pilotName);
      const av = a.values.get(col)?.value ?? null;
      const bv = b.values.get(col)?.value ?? null;
      // Nulls sort last in both directions — "not applicable" is not a score
      // of zero, and burying it under a descending sort would imply it is.
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    });
    if (sort.direction === "descending" && col !== "rank") {
      // Keep the nulls at the bottom rather than reversing them to the top.
      const present = sorted.filter((r) => r.values.get(col)?.value != null || col === "pilot");
      const absent = sorted.filter((r) => !(r.values.get(col)?.value != null || col === "pilot"));
      return [...present.reverse(), ...absent];
    }
    if (sort.direction === "descending") return [...sorted].reverse();
    return sorted;
  }, [report.pilots, metrics, valuesByMetric, sort]);

  return (
    <Table
      aria-label={`${familyLabel} metrics by pilot`}
      scrollLabel={`${familyLabel} metrics by pilot`}
      sortDescriptor={sort}
      onSortChange={setSort}
    >
      <TableHeader>
        <Column id="rank" allowsSorting className="w-14 text-right">
          #
        </Column>
        {/* The pilot IS the row's identity: as a row header every metric cell
            is announced as "Jane Doe, Climb vs field, 62" instead of a bare
            number in an unnamed row. */}
        <Column id="pilot" isRowHeader allowsSorting className="min-w-40">
          Pilot
        </Column>
        {metrics.map((m) => (
          <Column
            key={m.id}
            id={m.id}
            allowsSorting
            aria-label={columnLabel(m)}
            className="text-right"
          >
            <span className="inline-flex items-center gap-1">
              {m.shortLabel ?? m.label}
              <MetricExplanation
                label={m.label}
                unit={m.unit}
                direction={m.direction}
                explanation={m.explanation}
              />
            </span>
          </Column>
        ))}
      </TableHeader>
      <TableBody>
        {rows.map((pilot) => (
          <Row key={pilot.trackFile}>
            <Cell className="text-right tabular-nums text-muted-foreground">
              {pilot.rank}
            </Cell>
            <Cell className="font-medium">{pilot.pilotName}</Cell>
            {metrics.map((m) => {
              const entry = pilot.values.get(m.id);
              const value = entry?.value ?? null;
              return (
                <Cell key={m.id} className="text-right tabular-nums">
                  {value === null ? (
                    // Never an empty cell: a blank reads as a rendering
                    // failure, and to a screen reader it reads as nothing.
                    <span
                      aria-label="not applicable"
                      className="text-muted-foreground"
                    >
                      —
                    </span>
                  ) : (
                    // The engine's formatter, so the page and the CLI report
                    // never disagree about decimal places.
                    formatMetricValue(m.unit, value)
                  )}
                  {entry?.note ? (
                    <span className="sr-only"> ({entry.note})</span>
                  ) : null}
                </Cell>
              );
            })}
          </Row>
        ))}
      </TableBody>
    </Table>
  );
}
