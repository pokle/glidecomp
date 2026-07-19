/**
 * Renders an engine `ReportTable` — the rich extra tables some metrics emit
 * (the start horserace, the leg-time waterfall, the wind-by-hour breakdown).
 *
 * These are pre-formatted strings from the engine, so this is presentation
 * only: the title becomes a real <caption>, column alignment is honoured, and
 * footnotes are associated with the table via aria-describedby rather than
 * merely sitting near it.
 */
import { useId } from "react";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import type { ReportTable } from "./types";

export function ReportTableView({ table }: { table: ReportTable }) {
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
                  {value}
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
