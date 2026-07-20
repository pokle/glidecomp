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
  intro = "How every metric on this page is measured. On screen, the ⓘ next to a metric opens the same description in place; in print, this section is the reference for all of them.",
}: {
  entries: GlossaryEntry[];
  /** The line under the heading — override on pages without ⓘ popovers. */
  intro?: string;
}) {
  if (entries.length === 0) return null;

  const byFamily = new Map<MetricFamily, GlossaryEntry[]>();
  for (const e of entries) {
    const list = byFamily.get(e.family) ?? [];
    list.push(e);
    byFamily.set(e.family, list);
  }

  return (
    <section aria-labelledby="glossary-heading" className="space-y-4">
      <div>
        <h2 id="glossary-heading" className="scroll-mt-20 text-lg font-semibold">
          Metric glossary
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{intro}</p>
      </div>

      {FAMILY_ORDER.filter((family) => (byFamily.get(family) ?? []).length > 0).map(
        (family) => (
          <div key={family} className="space-y-3">
            <h3 className="text-sm font-semibold text-muted-foreground">
              {FAMILY_LABELS[family]}
            </h3>
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
    </section>
  );
}
