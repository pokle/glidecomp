/**
 * The basis line: what the numbers above were computed FROM.
 *
 * Every metric here is derived from detector output over a sampled grid, so
 * the report is only as trustworthy as its inputs. Stating the pilot count,
 * the grid step, how many thermals were actually shared, the working band and
 * the phase coverage up front is the same explainability rule the scoring
 * pages follow — a number without its basis is not an explanation.
 */
import { formatAltitude, useUnits } from "@/react/lib/units";
import type { FieldAnalysisBasis } from "./types";

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  );
}

export function AnalysisBasis({
  basis,
  excluded,
}: {
  basis: FieldAnalysisBasis;
  excluded: { pilot_name: string; reason: string }[];
}) {
  const units = useUnits();
  return (
    <section aria-label="Analysis basis" className="rounded-lg border p-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
        <Fact term="Pilots analysed">{basis.pilotCount}</Fact>
        <Fact term="Sampling">every {basis.gridStepSeconds}s</Fact>
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
        <Fact term="Phase coverage">{Math.round(basis.phaseCoveragePct)}%</Fact>
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
