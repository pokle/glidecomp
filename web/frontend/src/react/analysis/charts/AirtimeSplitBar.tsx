/**
 * The field's airborne time split three ways — searching / climbing / gliding —
 * as three bars from a shared baseline.
 *
 * This replaced the "Phase coverage" fact, which read 100% on every task
 * because `partitionPhases` tiles takeoff→landing exactly — a number that
 * restated its own invariant. The split actually moves with the day: a strong
 * day runs glide-heavy, a broken one piles up searching (circling that never
 * became a climb, wandering, sink-dodging), and that is the context every
 * metric below was measured in.
 *
 * The three used to be laid end to end as one 100% stacked bar, which is the
 * wrong mark for the question a reader actually asks here: comparing segments
 * that each start at a different offset means eyeballing lengths with no shared
 * baseline, and the segments are near-equal often enough that the comparison
 * fails. Stacked from a common left edge, they are read off one axis. The
 * whole they sum to is still stated — it is the percentages themselves.
 *
 * Order is searching, climbing, gliding: the reading order of the day a pilot
 * had, worst to best use of the air, not the order the fields happen to sit in
 * on `FieldAirtimeSplit`.
 *
 * "Airtime", and gerunds, on purpose. Nothing about "phase split" said the
 * percentages were of TIME, and this page is otherwise full of distance —
 * a reader could fairly take it for a split of kilometres. Gerunds close the
 * same gap one level down: "38% climb" can be heard as a count of climbs,
 * "38% climbing" can only be time spent.
 *
 * The bars are aria-hidden decoration — the label at each one's start and the
 * percentage at its end are the accessible and exact reading, which also
 * satisfies the direct-labelling required of a categorical palette whose
 * adjacent hues sit in the CVD floor band. Colours are the shared --chart-N
 * tokens bound to the phase, not to the row, so a phase keeps its hue across
 * every chart on the page.
 */
import { roundPercentagesToHundred, type FieldAirtimeSplit } from "@glidecomp/engine";

type Slice = { label: string; pct: number; fill: string };

export function AirtimeSplitBar({ split }: { split: FieldAirtimeSplit }) {
  // Rounded in field order and displayed in reading order: the largest
  // remainder goes to the same phase whichever way the rows are arranged.
  const [climb, glide, search] = roundPercentagesToHundred([
    split.climbPct,
    split.glidePct,
    split.searchPct,
  ]);
  const slices: Slice[] = [
    { label: "searching", pct: search, fill: "bg-chart-3" },
    { label: "climbing", pct: climb, fill: "bg-chart-1" },
    { label: "gliding", pct: glide, fill: "bg-chart-2" },
  ];

  return (
    // A subgrid row per phase, so the label column is exactly as wide as the
    // longest word and every bar starts on the same edge — the baseline that
    // makes the three lengths comparable at a glance.
    <ul className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
      {slices.map((s) => (
        <li key={s.label} className="col-span-2 grid grid-cols-subgrid items-center">
          <span className="text-right text-xs text-muted-foreground">{s.label}</span>
          <span className="flex items-center gap-1.5">
            {/* Width is a share of the track, so the three are on one scale.
                `shrink` only ever bites near 100%, where the value would
                otherwise be pushed off the end of the row. */}
            <span
              aria-hidden="true"
              className={`h-3 shrink rounded-[3px] ${s.fill}`}
              style={{ width: `${s.pct}%` }}
            />
            <span className="shrink-0 text-xs tabular-nums">{s.pct}%</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
