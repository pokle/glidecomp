/**
 * Footnotes — the page's reference material, gathered at the foot of it.
 *
 * Everything here is something a reader consults ONCE and then never again:
 * which pilots couldn't be analysed and why, how the field is compared, and
 * how every metric is measured. None of it belongs in the reading flow, and
 * the excluded-pilot list in particular used to sit in the basis box at the
 * very top — on a task where eight pilots flew without tracklogs it was
 * longer than every fact above it combined, so the first thing a reader met
 * was the caveats rather than the findings.
 *
 * Each footnote keeps a stable id and a real heading, so the TOC lists them,
 * a link from the body can land on one, and print (where the ⓘ popovers do
 * not exist) still carries the reference.
 */
import { Card } from "@/react/rac/card";

export const EXCLUDED_PILOTS_ID = "excluded-pilots";
export const METHOD_NOTE_ID = "method-note";

/**
 * A footnote's heading. Exported so the metric glossary — which is a footnote
 * with a body too big to inline here — sits at the same level and looks it.
 */
export function FootnoteHeading({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <h3 id={id} className="scroll-mt-20 text-sm font-semibold">
      {children}
    </h3>
  );
}

export function Footnotes({ children }: { children: React.ReactNode }) {
  return (
    // A reference chapter, so print starts it on a fresh page.
    <Card
      aria-labelledby="footnotes-heading"
      className="gap-6 print:break-before-page"
    >
      <h2 id="footnotes-heading" className="scroll-mt-20 text-lg font-semibold">
        Footnotes
      </h2>
      {children}
    </Card>
  );
}

/** One footnote: a linkable heading and its prose. */
export function Footnote({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="break-inside-avoid">
      <FootnoteHeading id={id}>{title}</FootnoteHeading>
      <div className="mt-1 space-y-2 text-sm">{children}</div>
    </div>
  );
}

/**
 * Which pilots the scores include but the analysis could not measure.
 *
 * The closing note is the point of the whole footnote: their absence does not
 * make the correlations wrong, because the ranks those correlations are
 * measured against still contain these pilots.
 */
export function ExcludedPilots({
  excluded,
}: {
  excluded: { pilot_name: string; reason: string }[];
}) {
  return (
    <Footnote
      id={EXCLUDED_PILOTS_ID}
      title={`${excluded.length} pilot${excluded.length === 1 ? "" : "s"} in the scores but not in this analysis`}
    >
      <ul className="space-y-0.5">
        {excluded.map((e, i) => (
          <li key={`${e.pilot_name}-${i}`} className="text-muted-foreground">
            {e.pilot_name} — {e.reason}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        The correlations are measured against the published ranks, and those
        ranks include these pilots. Their behaviour cannot be measured without a
        tracklog.
      </p>
    </Footnote>
  );
}

/**
 * How pilots are compared to each other.
 *
 * This is the resampling grid, which used to be a "Sampling every 10s" tile
 * in the basis box. It is the same on every task of every comp, so as a tile
 * it was permanent furniture; it is still part of how the numbers were made,
 * so it is stated here — in terms that mean something to a pilot rather than
 * naming the parameter.
 */
export function MethodNote({ gridStepSeconds }: { gridStepSeconds: number }) {
  return (
    <Footnote id={METHOD_NOTE_ID} title="How the field is compared">
      <p>
        Everything that compares pilots to each other uses one shared clock.
        That includes gaggles, shared thermals, and the position of each pilot
        at the same moment. GlideComp resamples every track onto a common{" "}
        {gridStepSeconds}-second grid. Two pilots are therefore always compared
        at the same instant, whatever rate their instruments logged at.
      </p>
    </Footnote>
  );
}
