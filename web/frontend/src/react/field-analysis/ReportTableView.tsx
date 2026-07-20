/**
 * Renders an engine `ReportTable` — the rich extra tables some metrics emit
 * (the start horserace, the leg-time waterfall, the wind-by-hour breakdown).
 *
 * Cells are mostly pre-formatted strings, so this is presentation only: the
 * title becomes a real <caption>, column alignment is honoured, and footnotes
 * are associated via aria-describedby. The exception is a `{ t }` cell — a
 * machine-readable instant the engine leaves unzoned; here it is rendered as a
 * time of day in the COMPETITION's zone (`compTimezone`), so the report never
 * shows UTC unless the comp itself is UTC.
 */
import { useId } from "react";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { formatTimeOfDay } from "../lib/time";
import type { ReportTable, ReportCell } from "./types";

/** A report cell as a React node: text passes through; a `{ t }` instant
 * renders as a comp-zone time of day inside a semantic <time>. */
function renderCell(cell: ReportCell, compTimezone: string | null) {
  if (typeof cell === "string") return cell;
  return (
    <time dateTime={cell.t}>{formatTimeOfDay(cell.t, compTimezone ?? undefined)}</time>
  );
}

export function ReportTableView({
  table,
  compTimezone = null,
}: {
  table: ReportTable;
  /** Competition IANA zone; `{ t }` time cells render in it (viewer-local when null). */
  compTimezone?: string | null;
}) {
  const footnotesId = useId();
  const hasFootnotes = (table.footnotes?.length ?? 0) > 0;

  return (
    <div className="mt-3">
      <Table
        aria-label={table.title}
        aria-describedby={hasFootnotes ? footnotesId : undefined}
        scrollLabel={table.title}
      >
        <TableHeader>
          {table.columns.map((col, i) => (
            <Column
              key={col.header || `col-${i}`}
              // The first column identifies the row (a pilot, an hour, a leg),
              // so it is the row header — without this every cell is announced
              // without saying which row it belongs to.
              isRowHeader={i === 0}
              className={col.align === "right" ? "text-right" : undefined}
            >
              {col.header}
            </Column>
          ))}
        </TableHeader>
        <TableBody>
          {table.rows.map((row, rowIndex) => (
            <Row key={`${table.title}-${rowIndex}`}>
              {row.map((value, i) => (
                <Cell
                  key={i}
                  className={
                    table.columns[i]?.align === "right"
                      ? "text-right tabular-nums"
                      : undefined
                  }
                >
                  {renderCell(value, compTimezone)}
                </Cell>
              ))}
            </Row>
          ))}
        </TableBody>
      </Table>
      {hasFootnotes ? (
        <div id={footnotesId} className="mt-1 space-y-0.5">
          {table.footnotes!.map((note, i) => (
            <p key={i} className="text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The caption line above a table's block — the engine's own title. */
export function ReportTableTitle({ table }: { table: ReportTable }) {
  return <h4 className="text-sm font-medium">{table.title}</h4>;
}
