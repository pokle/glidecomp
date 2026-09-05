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
 *
 * When both groups flew, {@link AirtimeSplitByGoal} draws the same three bars
 * twice — a column per group, a row per phase — so a glance across the row
 * is the comparison. A 0% or 100% goal day falls back to {@link AirtimeSplitBar}.
 */
import { roundPercentagesToHundred, type FieldAirtimeSplit } from "@glidecomp/engine";

type Slice = { label: string; pct: number; fill: string };

function slicesOf(split: FieldAirtimeSplit): Slice[] {
  // Rounded in field order and displayed in reading order: the largest
  // remainder goes to the same phase whichever way the rows are arranged.
  const [climb, glide, search] = roundPercentagesToHundred([
    split.climbPct,
    split.glidePct,
    split.searchPct,
  ]);
  return [
    { label: "searching", pct: search, fill: "bg-chart-3" },
    { label: "climbing", pct: climb, fill: "bg-chart-1" },
    { label: "gliding", pct: glide, fill: "bg-chart-2" },
  ];
}

function PhaseBar({ slice }: { slice: Slice }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5">
      {/* Width is a share of the track, so the three are on one scale.
          `shrink` only ever bites near 100%, where the value would
          otherwise be pushed off the end of the row. */}
      <span
        aria-hidden="true"
        className={`h-3 shrink rounded-[3px] ${slice.fill}`}
        style={{ width: `${slice.pct}%` }}
      />
      <span className="shrink-0 text-xs tabular-nums">{slice.pct}%</span>
    </span>
  );
}

export function AirtimeSplitBar({ split }: { split: FieldAirtimeSplit }) {
  const slices = slicesOf(split);
  return (
    // A subgrid row per phase, so the label column is exactly as wide as the
    // longest word and every bar starts on the same edge — the baseline that
    // makes the three lengths comparable at a glance.
    <ul className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
      {slices.map((s) => (
        <li key={s.label} className="col-span-2 grid grid-cols-subgrid items-center">
          <span className="text-right text-xs text-muted-foreground">{s.label}</span>
          <PhaseBar slice={s} />
        </li>
      ))}
    </ul>
  );
}

function GroupHead({ label, caption }: { label: string; caption: string }) {
  return (
    <div>
      <div className="text-xs">{label}</div>
      <div className="text-xs tabular-nums text-muted-foreground">{caption}</div>
    </div>
  );
}

/**
 * The existing three bars, twice: one column for those who made goal, one
 * for those who did not. On a narrow screen the groups stack, each with its
 * own labels; from `sm` they share a row per phase so the comparison is a
 * glance across.
 */
export function AirtimeSplitByGoal({
  madeGoal,
  didNotMakeGoal,
  madeGoalLabel = "Made goal",
  didNotMakeGoalLabel = "Didn't make goal",
  madeGoalCaption,
  didNotMakeGoalCaption,
}: {
  madeGoal: FieldAirtimeSplit;
  didNotMakeGoal: FieldAirtimeSplit;
  madeGoalLabel?: string;
  didNotMakeGoalLabel?: string;
  madeGoalCaption: string;
  didNotMakeGoalCaption: string;
}) {
  const made = slicesOf(madeGoal);
  const out = slicesOf(didNotMakeGoal);
  return (
    <>
      <div className="flex flex-col gap-4 sm:hidden">
        <div>
          <GroupHead label={madeGoalLabel} caption={madeGoalCaption} />
          <div className="mt-1.5">
            <AirtimeSplitBar split={madeGoal} />
          </div>
        </div>
        <div>
          <GroupHead label={didNotMakeGoalLabel} caption={didNotMakeGoalCaption} />
          <div className="mt-1.5">
            <AirtimeSplitBar split={didNotMakeGoal} />
          </div>
        </div>
      </div>
      <table className="hidden w-full table-fixed border-separate border-spacing-x-3 border-spacing-y-1.5 sm:table">
        <caption className="sr-only">
          Airtime split by whether the pilot made goal
        </caption>
        <thead>
          <tr>
            <th className="w-[5.5rem] p-0" />
            <th scope="col" className="p-0 text-left font-normal">
              <GroupHead label={madeGoalLabel} caption={madeGoalCaption} />
            </th>
            <th scope="col" className="p-0 text-left font-normal">
              <GroupHead label={didNotMakeGoalLabel} caption={didNotMakeGoalCaption} />
            </th>
          </tr>
        </thead>
        <tbody>
          {made.map((s, i) => (
            <tr key={s.label}>
              <th
                scope="row"
                className="p-0 text-right text-xs font-normal text-muted-foreground"
              >
                {s.label}
              </th>
              <td className="min-w-0 p-0">
                <PhaseBar slice={s} />
              </td>
              <td className="min-w-0 p-0">
                <PhaseBar slice={out[i] ?? s} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

