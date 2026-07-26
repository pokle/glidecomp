/**
 * The field's airborne time as one 100% stacked bar: climbing / gliding /
 * searching.
 *
 * This replaced the "Phase coverage" fact, which read 100% on every task
 * because `partitionPhases` tiles takeoff→landing exactly — a number that
 * restated its own invariant. The split actually moves with the day: a strong
 * day runs glide-heavy, a broken one piles up searching (circling that never
 * became a climb, wandering, sink-dodging), and that is the context every
 * metric below was measured in.
 *
 * "Airtime", and gerunds, on purpose. Nothing about "phase split" said the
 * percentages were of TIME, and this page is otherwise full of distance —
 * a reader could fairly take it for a split of kilometres. Gerunds close the
 * same gap one level down: "38% climb" can be heard as a count of climbs,
 * "38% climbing" can only be time spent.
 *
 * The bar is aria-hidden decoration — the percentages beside it are the
 * accessible and exact reading, which also satisfies the direct-labelling
 * required of a categorical palette whose adjacent hues sit in the CVD floor
 * band. Colours are the shared --chart-N tokens in fixed order, so a phase
 * keeps its hue across every chart on the page.
 */
import { roundPercentagesToHundred, type FieldAirtimeSplit } from "@glidecomp/engine";

type Slice = { label: string; pct: number; fill: string; dot: string };

export function AirtimeSplitBar({ split }: { split: FieldAirtimeSplit }) {
  const [climb, glide, search] = roundPercentagesToHundred([
    split.climbPct,
    split.glidePct,
    split.searchPct,
  ]);
  const slices: Slice[] = [
    { label: "climbing", pct: climb, fill: "bg-chart-1", dot: "bg-chart-1" },
    { label: "gliding", pct: glide, fill: "bg-chart-2", dot: "bg-chart-2" },
    { label: "searching", pct: search, fill: "bg-chart-3", dot: "bg-chart-3" },
  ];

  return (
    <div>
      {/* 2px gaps between fills, per the stacked-bar mark spec. */}
      <div className="flex h-2.5 gap-0.5" aria-hidden="true">
        {slices
          .filter((s) => s.pct > 0)
          .map((s) => (
            <div
              key={s.label}
              className={`rounded-[3px] ${s.fill}`}
              style={{ width: `${s.pct}%` }}
            />
          ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-1">
            <span
              className={`size-2 shrink-0 rounded-[2px] ${s.dot}`}
              aria-hidden="true"
            />
            <span className="tabular-nums">{s.pct}%</span>
            <span className="text-muted-foreground">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
