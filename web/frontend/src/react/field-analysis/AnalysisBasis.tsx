/**
 * The basis line: what the numbers above were computed FROM.
 *
 * Every metric here is derived from detector output over a sampled grid, so
 * the report is only as trustworthy as its inputs. Stating the pilot count,
 * how much airtime it rests on and when that was flown, how many thermals were
 * actually shared, the working band and how the airtime divided between flight
 * phases up front is the same explainability rule the scoring pages follow — a
 * number without its basis is not an explanation.
 *
 * The one basis fact NOT here is the 10 s resampling grid: it is the same for
 * every task and every comp, so it was permanent furniture in a box where
 * space is the scarce thing. It still has to be stated, so it moved to the
 * metric glossary at the foot of the page (see TaskFieldAnalysis).
 */
import { formatTimeRange } from "@/react/lib/time";
import { formatAltitude, useUnits } from "@/react/lib/units";
import { AirtimeSplitBar } from "./charts/AirtimeSplitBar";
import type { FieldAnalysisBasis } from "./types";

function Fact({
  term,
  className,
  children,
}: {
  term: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * "82h (13:05–18:40 AEDT)" — how much flying the report rests on, and when it
 * happened.
 *
 * The two belong in one fact because neither answers the reader's question
 * alone: 80 hours is a long day or a crowded one, and only the window says
 * which. Sub-10-hour totals keep a decimal — a thin day (7 pilots, 5.6 h) is
 * exactly when a reader needs to distrust the correlations below, and "6h"
 * hides that where "5.6h" doesn't.
 */
function airtimeText(
  seconds: number,
  window: { from: string; to: string } | undefined,
  timeZone: string | undefined
): string {
  const hours = seconds / 3600;
  const total = `${hours < 10 ? hours.toFixed(1) : hours.toFixed(0)}h`;
  return window
    ? `${total} (${formatTimeRange(window.from, window.to, timeZone)})`
    : total;
}

export function AnalysisBasis({
  basis,
  excluded,
  timeZone,
}: {
  basis: FieldAnalysisBasis;
  excluded: { pilot_name: string; reason: string }[];
  /** Competition zone for the analysis window. Viewer-local when undefined. */
  timeZone?: string;
}) {
  const units = useUnits();
  return (
    <section aria-label="Analysis basis" className="rounded-lg border p-4">
      {/* Four scalar facts, then the airtime split on a full row of its own at
          every breakpoint — the bar is a proportion of one whole, so it reads
          best spanning the width rather than boxed into a column beside the
          scalars. Column counts are 2 and 4 (both divide the four facts) so no
          breakpoint leaves a fact orphaned beside empty slots. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-4">
        <Fact term="Pilots">{basis.pilotCount}</Fact>
        {/* Both halves are optional (v11 / v12 rows) — fall back to whichever
            half a stale report carries rather than dropping the fact. */}
        {basis.airtimeSplit || basis.analysisWindow ? (
          <Fact term="Airtime">
            {basis.airtimeSplit
              ? airtimeText(
                  basis.airtimeSplit.airborneSeconds,
                  basis.analysisWindow,
                  timeZone
                )
              : formatTimeRange(
                  basis.analysisWindow!.from,
                  basis.analysisWindow!.to,
                  timeZone
                )}
          </Fact>
        ) : null}
        <Fact term="Shared thermals">
          {basis.multiPilotThermalCount} of {basis.sharedThermalCount}
          <span className="ml-1 text-xs text-muted-foreground">multi-pilot</span>
        </Fact>
        <Fact term="Working band">
          {formatAltitude(basis.workingBandFloor, { prefs: units }).formatted}–
          {formatAltitude(basis.workingBandCeiling, { prefs: units }).withUnit}
          {basis.workingBandFallback ? (
            <span className="ml-1 text-xs text-muted-foreground">(estimated)</span>
          ) : null}
        </Fact>
        {/* Absent on reports stored before this field existed (v11 and
            earlier), which are served stale until they revalidate. */}
        {basis.airtimeSplit ? (
          <Fact term="Airtime split" className="col-span-2 lg:col-span-4">
            <AirtimeSplitBar split={basis.airtimeSplit} />
          </Fact>
        ) : null}
      </dl>

      {excluded.length > 0 ? (
        <div className="mt-4 border-t pt-3">
          <p className="text-sm">
            <strong>{excluded.length}</strong> pilot
            {excluded.length === 1 ? " is" : "s are"} in the standings but not in
            this analysis:
          </p>
          <ul className="mt-1 space-y-0.5">
            {excluded.map((e, i) => (
              <li key={`${e.pilot_name}-${i}`} className="text-sm text-muted-foreground">
                {e.pilot_name} — {e.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            Correlations are measured against the published ranks, which include
            these pilots; their behaviour simply cannot be measured without a
            tracklog.
          </p>
        </div>
      ) : null}
    </section>
  );
}
