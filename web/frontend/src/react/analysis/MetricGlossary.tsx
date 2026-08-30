/**
 * The metric glossary — every metric's method description laid out as one
 * skimmable reference section at the end of the page, grouped by family in
 * FAMILY_ORDER.
 *
 * This is the same prose the ⓘ popovers show (MetricExplanation), rendered
 * statically for two audiences at once: print — where a popover simply does
 * not exist, so the explanations MUST live in the page flow — and screen,
 * where a reader can scroll through all 26 methods in one place instead of
 * opening popovers one by one. Each ⓘ popover links here, and each entry
 * carries a stable DOM id so those links (and shared URLs) land on the exact
 * definition.
 */
import { FAMILY_ORDER, FAMILY_LABELS, type MetricDirection, type MetricFamily } from "./types";
import { directionWords, unitWords } from "./units";
import { FootnoteHeading, type FootnoteLevel } from "./Footnotes";
import { Card } from "@/react/rac/card";

/** What one glossary entry needs — a subset of MetricReport/MetricComputer,
 * so both the task page (report metrics) and the comp page (the registry)
 * can feed it. */
export interface GlossaryEntry {
  id: string;
  label: string;
  shortLabel?: string;
  unit: string;
  family: MetricFamily;
  direction: MetricDirection;
  explanation: string;
}

/** DOM id of one metric's glossary entry — the ⓘ popover's link target. */
export function glossaryEntryId(metricId: string): string {
  return `glossary-${metricId.replace(/\./g, "-")}`;
}

export function MetricGlossary({
  entries,
  intro = "How GlideComp measures every metric on this page. On screen, the ⓘ beside a metric opens the same description in place. On paper, this section is the reference for all of them.",
  nested = false,
  headingLevel,
}: {
  entries: GlossaryEntry[];
  /** The line under the heading — override on pages without ⓘ popovers. */
  intro?: string;
  /**
   * Rendered inside someone else's panel — the "How this was measured" page
   * gathers it with the other reference notes in one card — so it stays a
   * plain section and stops starting its own print page. The comp page
   * renders it standalone and leaves this false.
   */
  nested?: boolean;
  /**
   * Where it sits in the page's heading tree. Independent of `nested`: on the
   * method page it shares a card with the other notes AND is one of the
   * page's own sections, so it is nested and an h2 at the same time.
   */
  headingLevel?: FootnoteLevel;
}) {
  const level: FootnoteLevel = headingLevel ?? (nested ? 3 : 2);
  if (entries.length === 0) return null;

  const byFamily = new Map<MetricFamily, GlossaryEntry[]>();
  for (const e of entries) {
    const list = byFamily.get(e.family) ?? [];
    list.push(e);
    byFamily.set(e.family, list);
  }

  // `nested` means it is already inside someone else's panel (the task
  // report's footnotes), so it stays a plain section — a panel inside a panel
  // says the wrong thing. Standalone it is a chapter of the page, so it gets
  // its own card like every other chapter.
  const Box = nested ? "section" : Card;
  return (
    // A reference chapter, so print starts it on a fresh page.
    <Box
      aria-labelledby="glossary-heading"
      className={nested ? "space-y-4" : "gap-4 print:break-before-page"}
    >
      <div>
        <FootnoteHeading id="glossary-heading" level={level}>
          Metric glossary
        </FootnoteHeading>
        <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
      </div>

      {FAMILY_ORDER.filter((family) => (byFamily.get(family) ?? []).length > 0).map(
        (family) => (
          <div key={family} className="space-y-3">
            {/* One level below the glossary's own heading, whichever that is. */}
            {level === 2 ? (
              <h3 className="text-sm font-semibold text-muted-foreground">
                {FAMILY_LABELS[family]}
              </h3>
            ) : (
              <h4 className="text-sm font-semibold text-muted-foreground">
                {FAMILY_LABELS[family]}
              </h4>
            )}
            <dl className="space-y-3">
              {byFamily.get(family)!.map((e) => (
                // scroll-mt keeps the sticky header off a linked-to entry;
                // break-inside-avoid keeps a printed entry on one page;
                // target: tints the entry a link or shared URL landed on.
                <div
                  key={e.id}
                  id={glossaryEntryId(e.id)}
                  className="scroll-mt-20 break-inside-avoid rounded-md target:bg-accent/50"
                >
                  <dt className="text-sm font-medium">
                    {e.label}
                    {e.shortLabel && e.shortLabel !== e.label ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        (“{e.shortLabel}” in tables)
                      </span>
                    ) : null}
                  </dt>
                  <dd className="text-sm text-muted-foreground">
                    <span className="text-xs">
                      Measured in {unitWords(e.unit)} · {directionWords(e.direction)}
                    </span>
                    <p className="mt-0.5 text-foreground/90">{e.explanation}</p>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )
      )}
    </Box>
  );
}
