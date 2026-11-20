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
import { formatTimeOfDay, formatTimeRange } from "../lib/time";
import type { ReportTable, ReportCell } from "./types";

/** A table of more columns than this is drawn as records, not as a table. */
const RECORD_COLUMNS = 3;

/** A report cell as a React node: text passes through; a `{ t }` instant renders
 * as a comp-zone time of day and a `{ from, to }` cell as a comp-zone range,
 * each inside a semantic <time>. */
function renderCell(cell: ReportCell, compTimezone: string | null) {
  if (typeof cell === "string") return cell;
  const tz = compTimezone ?? undefined;
  if ("t" in cell) {
    return <time dateTime={cell.t}>{formatTimeOfDay(cell.t, tz)}</time>;
  }
  return (
    <time dateTime={cell.from}>{formatTimeRange(cell.from, cell.to, tz)}</time>
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

  const footnotes = hasFootnotes ? (
    <div id={footnotesId} className="mt-1 space-y-0.5">
      {table.footnotes!.map((note, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  ) : null;

  // A table of more than three columns is a list of RECORDS, at every width
  // (issues #804, #860): each row is a box, with its first cell as its name
  // and the rest as label and value. "Wind by leg" has eight columns and was
  // 826px wide in a phone's 297px window. Three columns or fewer fit, and
  // stay a table. The boxes are the page's ground colour, because they sit
  // inside the family's card: white on white would show no edge.
  if (table.columns.length > RECORD_COLUMNS) {
    return (
      <div className="mt-3">
        <ul
          aria-label={table.title}
          aria-describedby={hasFootnotes ? footnotesId : undefined}
          className="flex flex-col gap-2.5"
        >
          {table.rows.map((row, rowIndex) => (
            <li
              key={`${table.title}-${rowIndex}`}
              className="rounded-lg border bg-background px-4 py-3"
            >
              <p className="font-semibold">
                <span className="sr-only">{table.columns[0]?.header}: </span>
                {renderCell(row[0], compTimezone)}
              </p>
              <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                {row.slice(1).map((value, i) => (
                  // Index-qualified: concentric tasks repeat a waypoint name
                  // across column headers.
                  <div key={i} className="contents">
                    <dt className="text-muted-foreground">{table.columns[i + 1]?.header}</dt>
                    <dd className="text-right tabular-nums">{renderCell(value, compTimezone)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
        {footnotes}
      </div>
    );
  }

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
              // Index-qualified: concentric tasks (Kosciuszko Loop) repeat a
              // waypoint name across turnpoint column headers.
              key={`col-${i}-${col.header}`}
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
      {footnotes}
    </div>
  );
}

/** The caption line above a table's block — the engine's own title. */
export function ReportTableTitle({ table }: { table: ReportTable }) {
  return <h4 className="text-sm font-medium">{table.title}</h4>;
}
