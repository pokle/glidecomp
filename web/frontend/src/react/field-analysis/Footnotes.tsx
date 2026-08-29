/**
 * The reference material: which pilots couldn't be analysed and why, and how
 * the field is compared.
 *
 * Everything here is something a reader consults ONCE and then never again,
 * so none of it belongs in the reading flow — the excluded-pilot list in
 * particular used to sit in the basis box at the very top, and on a task where
 * eight pilots flew without tracklogs it was longer than every fact above it
 * combined, so the first thing a reader met was the caveats rather than the
 * findings. They were a "Footnotes" section at the foot of the one-page task
 * report; since that page became a summary they are the "How this was
 * measured" page (field-analysis/sections.ts), where they are the content
 * rather than the small print — hence `level`.
 *
 * Each keeps a stable id and a real heading, so a link from the body can land
 * on one.
 */
import { cn } from "../lib/utils";

export const EXCLUDED_PILOTS_ID = "excluded-pilots";
export const METHOD_NOTE_ID = "method-note";

/**
 * How deep in the page's heading tree a footnote sits. 3 is the historical
 * level, under someone else's h2 — the comp report still renders them there.
 * 2 is a footnote that IS the page, as on "How this was measured", where an h3
 * directly under the h1 would skip a level.
 */
export type FootnoteLevel = 2 | 3;

/**
 * A footnote's heading. Exported so the metric glossary — which is a footnote
 * with a body too big to inline here — sits at the same level and looks it.
 */
export function FootnoteHeading({
  id,
  level = 3,
  children,
}: {
  id: string;
  level?: FootnoteLevel;
  children: React.ReactNode;
}) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag
      id={id}
      className={cn("scroll-mt-20 font-semibold", level === 2 ? "text-lg" : "text-sm")}
    >
      {children}
    </Tag>
  );
}

/** One footnote: a linkable heading and its prose. */
export function Footnote({
  id,
  title,
  level,
  children,
}: {
  id: string;
  title: string;
  level?: FootnoteLevel;
  children: React.ReactNode;
}) {
  return (
    <div>
      <FootnoteHeading id={id} level={level}>
        {title}
      </FootnoteHeading>
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
  level,
}: {
  excluded: { pilot_name: string; reason: string }[];
  level?: FootnoteLevel;
}) {
  return (
    <Footnote
      id={EXCLUDED_PILOTS_ID}
      level={level}
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
export function MethodNote({
  gridStepSeconds,
  level,
}: {
  gridStepSeconds: number;
  level?: FootnoteLevel;
}) {
  return (
    <Footnote id={METHOD_NOTE_ID} level={level} title="How the field is compared">
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
