/**
 * One family's metrics, pilot by pilot: ONE behaviour at a time, for every
 * pilot.
 *
 * It was a table of pilots down the side and the family's three to six
 * behaviours across the top, which ran off a phone (issues #804, #860): the
 * pilot's name and one column were on screen, and the rest was a sideways
 * scroll. It is now a LIST at every width. A picker chooses the behaviour,
 * and each pilot is one line: the rank and the name, a bar on that
 * behaviour's own low-to-high scale, and the value.
 *
 * What is lost is two behaviours of one pilot side by side. That question is
 * the pilot-similarity pages' ("Who flew like me?" and the pair it opens),
 * which answer it with every behaviour at once.
 *
 * The rows are one line each, so they are divided by a hairline in the
 * family's own card, not a card each: the kit's reading list is for rows of
 * several lines (rac/reading-list.tsx).
 *
 * The order control replaces the table's sortable headings, because the
 * reason to look at a family is "who was best at this". The default is the
 * published rank.
 */
import { useMemo, useState } from "react";
import { SegmentedControl } from "@/react/rac/segmented-control";
import { SimpleSelect } from "@/react/rac/select";
import { cn } from "@/react/lib/utils";
import { MetricExplanation, directionWords } from "./MetricExplanation";
import { unitWords } from "./units";
import { usePilotHighlight } from "./PilotHighlightContext";
import { formatMetricValue, type MetricReport, type TaskAnalysisReport } from "./types";

type Order = "rank" | "high" | "low";

const ORDERS: Array<{ value: Order; label: string }> = [
  { value: "rank", label: "By rank" },
  // One word each: "Highest first" and "Lowest first" were cut short in a
  // third of a phone's width.
  { value: "high", label: "Highest" },
  { value: "low", label: "Lowest" },
];

/** The name column, the bar, the value: one grid for the scale line and
 * every row, so the scale's ends sit over the bars' ends. On a wide screen
 * the bar takes the room the name does not need. */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_5.25rem_4.5rem] items-center gap-x-2.5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_5rem] sm:gap-x-4";

/** A unit as it is printed over the value column: "%" for a percentage and
 * nothing for a bare ratio, where the engine's names are "pct" and "ratio". */
function unitMark(unit: string): string {
  return unit === "pct" ? "%" : unit === "ratio" ? "" : unit;
}

export function PerPilotMetricList({
  report,
  metrics,
  familyLabel,
}: {
  report: TaskAnalysisReport;
  metrics: MetricReport[];
  familyLabel: string;
}) {
  const [metricId, setMetricId] = useState(metrics[0]?.id ?? "");
  const [order, setOrder] = useState<Order>("rank");
  // Page-wide pilot highlight (no-op outside the provider): rows both emit
  // it on hover and tint when some chart is pointing at their pilot.
  const { highlight, setHighlight } = usePilotHighlight();

  // A behaviour that left the family (a class switch) falls back to the first.
  const metric = metrics.find((m) => m.id === metricId) ?? metrics[0];

  const rows = useMemo(() => {
    if (!metric) return [];
    // perPilot is aligned to report.pilots by construction (evaluateField
    // re-aligns by trackFile), but key by trackFile anyway: pairing per-pilot
    // data by array index is exactly the bug this project bans.
    const byTrack = new Map(metric.perPilot.map((p) => [p.trackFile, p]));
    const base = report.pilots.map((p) => ({
      ...p,
      value: byTrack.get(p.trackFile)?.value ?? null,
      note: byTrack.get(p.trackFile)?.note,
    }));
    if (order === "rank") return [...base].sort((a, b) => a.rank - b.rank);
    const dir = order === "high" ? -1 : 1;
    return [...base].sort((a, b) => {
      // Nulls sort last in BOTH orders (checked before `dir` applies): "not
      // applicable" is not a score of zero, and putting it first under
      // "lowest first" would say it is.
      if (a.value === null && b.value === null) return a.rank - b.rank;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return dir * (a.value - b.value) || a.rank - b.rank;
    });
  }, [metric, report.pilots, order]);

  // The behaviour's own min–max, the scale its bars are drawn against. A
  // degenerate range (every pilot identical, or fewer than two measured)
  // carries no information, so those rows are numbers alone.
  const range = useMemo(() => {
    const values = (metric?.perPilot ?? [])
      .map((p) => p.value)
      .filter((v): v is number => v !== null);
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max > min ? { min, max } : null;
  }, [metric]);

  if (!metric) return null;
  const mark = unitMark(metric.unit);
  const listLabel = `${familyLabel} metrics by pilot`;

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-1">
        {metrics.length > 1 ? (
          <SimpleSelect
            label="Behaviour"
            value={metric.id}
            onChange={setMetricId}
            options={metrics.map((m) => ({ value: m.id, label: m.label }))}
            className="min-w-0 flex-1"
          />
        ) : (
          <p className="min-w-0 flex-1 font-medium">{metric.label}</p>
        )}
        <MetricExplanation
          metricId={metric.id}
          label={metric.label}
          unit={metric.unit}
          direction={metric.direction}
          explanation={metric.explanation}
          perPilot={metric.perPilot}
          pilots={report.pilots}
        />
      </div>
      <div>
        <p aria-hidden className="mb-1 text-sm text-muted-foreground">
          Order
        </p>
        <SegmentedControl
          ariaLabel={`Order of ${listLabel}`}
          value={order}
          onChange={(v) => setOrder(v as Order)}
          options={ORDERS}
        />
      </div>

      <div>
        {/* The scale, once: the ends of every bar below, and the unit of
            every value. */}
        <div aria-hidden className={cn(COLUMNS, "pb-1 text-xs tabular-nums text-muted-foreground")}>
          <span />
          {range ? (
            <span className="flex justify-between">
              <span>{formatMetricValue(metric.unit, range.min)}</span>
              <span>{formatMetricValue(metric.unit, range.max)}</span>
            </span>
          ) : (
            <span />
          )}
          <span className="text-right">{mark}</span>
        </div>
        <ul
          aria-label={listLabel}
          aria-description={`${metric.label}, in ${unitWords(metric.unit)}, ${directionWords(metric.direction)}`}
          className="divide-y border-y"
        >
          {rows.map((pilot) => (
            <li
              key={pilot.trackFile}
              className={cn(
                COLUMNS,
                "min-h-12 py-1.5",
                highlight === pilot.trackFile && "bg-accent"
              )}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") setHighlight(pilot.trackFile);
              }}
              onPointerLeave={() => setHighlight(null)}
            >
              <span className="min-w-0 break-words">
                <span className="tabular-nums text-muted-foreground">{pilot.rank}. </span>
                {pilot.pilotName}
              </span>
              {pilot.value === null ? (
                <>
                  <span />
                  {/* Never an empty cell: a blank reads as a rendering
                      failure, and to a screen reader it reads as nothing. */}
                  <span className="text-right text-muted-foreground">
                    <span aria-label="not applicable">—</span>
                    {pilot.note ? <span className="sr-only"> ({pilot.note})</span> : null}
                  </span>
                </>
              ) : (
                <>
                  {/* The bar's length is the value's place in the behaviour's
                      own min–max: magnitude, never "which end is better". */}
                  {range ? (
                    <span
                      aria-hidden
                      className="relative h-1.5 rounded-full bg-muted [print-color-adjust:exact]"
                    >
                      <span
                        className="absolute inset-y-0 left-0 min-w-1 rounded-full bg-foreground"
                        style={{
                          width: `${((pilot.value - range.min) / (range.max - range.min)) * 100}%`,
                        }}
                      />
                    </span>
                  ) : (
                    <span />
                  )}
                  {/* The engine's formatter, so the page and the CLI report
                      never disagree about decimal places. */}
                  <span className="text-right tabular-nums">
                    {formatMetricValue(metric.unit, pilot.value)}
                    <span className="sr-only"> {unitWords(metric.unit)}</span>
                    {pilot.note ? <span className="sr-only"> ({pilot.note})</span> : null}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
