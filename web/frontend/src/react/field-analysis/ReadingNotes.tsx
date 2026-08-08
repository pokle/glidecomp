/**
 * How to read the separation tables — written once, rendered twice.
 *
 * These paragraphs used to sit inline, above and below the tables: on the comp
 * page that was 87 words of intro, 128 words explaining three column headers
 * and an 85-word verdict legend, all before the first row. A reader could not
 * tell the finding from the fine print because both wore the same grey.
 *
 * So each note now hangs off the header that raises its question, behind a ⓘ
 * (rac/explain.tsx). The ⓘ is `print:hidden` and a popover cannot exist on
 * paper, so every note ALSO renders through {@link HowToReadFootnote}, which
 * is print-only. Both call the same component here — that is the point of this
 * module. A note edited in one place cannot drift from the other, and nothing
 * that left the reading flow left the page.
 *
 * PRINT-ONLY, and not visible-like the metric glossary, because these popovers
 * hold the WHOLE note. The glossary earns its place on screen: it is 26 entries
 * a reader may want in bulk, and each ⓘ links into it. Rendering this one
 * visibly as well would simply put the paragraphs back under the table they
 * were lifted out of — measured, it made the comp page taller than before the
 * change. So there is no link out of these popovers either: there is nowhere to
 * go that the popover has not already said.
 */
import { cn } from "@/react/lib/utils";
import { Footnote } from "./Footnotes";
import { MIN_CORRELATION_N } from "./types";

export const HOW_TO_READ_ID = "how-to-read";

/** What each verdict chip means, in the thresholds behind it. The chips read
 * as plain English ("could be chance"); this is where the statistics they
 * stand for are spelled out, so the plain words are never the whole story a
 * curious reader can get. */
export function VerdictLegend() {
  return (
    <p>
      <strong>clear pattern</strong> is |ρ| ≥ 0.5, <strong>some pattern</strong> ≥ 0.3
      and <strong>faint pattern</strong> below — each only once the coefficient is
      bigger than chance alone produces at that many pilots (its noise floor).{" "}
      <strong>could be chance</strong> (in the statistics: within noise) means
      shuffling the placings produces a coefficient that size more than 5% of the
      time, so it cannot be told apart from luck however big it looks.{" "}
      <strong>too few pilots</strong> is fewer than {MIN_CORRELATION_N} pilots with a
      value — not enough to tell either way.
    </p>
  );
}

/** Why a coefficient is negative when the behaviour is a good one. Shared by
 * both pages, because rank 1 being the best rank surprises every reader once. */
export function RankDirectionNote() {
  return (
    <p>
      Rank 1 is the best rank, so a behaviour where more is better shows a{" "}
      <strong>negative</strong> ρ, and its bar is left of centre.
    </p>
  );
}

/* ── Comp page columns ─────────────────────────────────────────────────── */

export function AcrossTasksNote() {
  return (
    <>
      <p>
        The average of the coefficients of each task, weighted by n, with the
        signs kept. It is also the order of the table. A behaviour that pulled
        the same way every day comes first, because days that pull opposite ways
        cancel each other there.
      </p>
      <RankDirectionNote />
    </>
  );
}

export function DayToDayNote() {
  return (
    <>
      <p>
        Reads only the tasks whose coefficient cleared its own noise floor,
        which are the solid bars. A <strong>hollow bar</strong> is a day whose
        coefficient can be chance. A behaviour that depends on the day is a
        finding, not a fault.
      </p>
      <p>
        A behaviour that keeps its sign and its size across every task tells you
        about flying. A behaviour that changes between tasks tells you about the
        weather on those days.
      </p>
    </>
  );
}

export function AgainstCompScoresNote() {
  return (
    <p>
      A separate reading. It takes the average of each pilot for that behaviour
      over the whole competition, and correlates it against their overall place.
      The verdict and the pilot count belong to that reading.
    </p>
  );
}

/* ── Task page columns ─────────────────────────────────────────────────── */

export function StrengthNote() {
  return (
    <>
      <p>
        Spearman&rsquo;s rank correlation, ρ, between the behaviour and the
        published placings. A bigger bar means the behaviour tracked the
        placings more closely on this task.
      </p>
      <RankDirectionNote />
    </>
  );
}

export function PilotsMeasuredNote() {
  return (
    <p>
      How much of the analysed field the behaviour applied to — a reading drawn
      from half the field is thinner than one drawn from all of it.
    </p>
  );
}

/** Why a strong-looking coefficient on ONE task is not yet a finding. */
export function OneDayCaveatNote({ behaviourCount }: { behaviourCount: number }) {
  return (
    <p>
      Rank {behaviourCount} behaviours against one day&rsquo;s results and a few
      will look strong on luck alone — the ones worth believing are those that
      repeat across tasks in the competition-level analysis.
    </p>
  );
}

/** Why the outcome-check table exists at all. */
export function OutcomeChecksNote() {
  return (
    <p>
      They are here as a check on the analysis. A weak pattern means that
      something is wrong in the numbers, and not in the flying of any pilot.
    </p>
  );
}

/* ── The printed form ──────────────────────────────────────────────────── */

/**
 * Every note above, rendered statically FOR PRINT ONLY — see the module note.
 * On screen the ⓘ popovers are the way in, and they carry the same components.
 *
 * `page` picks the column set, because the two tables do not share columns:
 * the comp aggregate has Across tasks / Day to day / Against comp scores,
 * the per-task ranking has Strength / Pilots measured.
 */
export function HowToReadFootnote({
  page,
  behaviourCount,
  className,
}: {
  page: "comp" | "task";
  /** Drives the one-day caveat's wording on the task page. */
  behaviourCount?: number;
  className?: string;
}) {
  return (
    <div className={cn("hidden print:block", className)}>
      <Footnote id={HOW_TO_READ_ID} title="How to read the table">
      {page === "comp" ? (
        <>
          <NoteBlock title="Across tasks">
            <AcrossTasksNote />
          </NoteBlock>
          <NoteBlock title="Day to day">
            <DayToDayNote />
          </NoteBlock>
          <NoteBlock title="Against comp scores">
            <AgainstCompScoresNote />
          </NoteBlock>
        </>
      ) : (
        <>
          <NoteBlock title="Strength">
            <StrengthNote />
          </NoteBlock>
          <NoteBlock title="Pilots measured">
            <PilotsMeasuredNote />
          </NoteBlock>
          {behaviourCount !== undefined ? (
            <NoteBlock title="One task is not a finding">
              <OneDayCaveatNote behaviourCount={behaviourCount} />
            </NoteBlock>
          ) : null}
        </>
      )}
      <NoteBlock title="What it means">
        <VerdictLegend />
      </NoteBlock>
      <NoteBlock title="Outcome checks">
        <OutcomeChecksNote />
      </NoteBlock>
      </Footnote>
    </div>
  );
}

function NoteBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="break-inside-avoid">
      <p className="font-medium">{title}</p>
      <div className="space-y-2 text-muted-foreground">{children}</div>
    </div>
  );
}
