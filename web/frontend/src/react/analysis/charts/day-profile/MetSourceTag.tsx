/**
 * The title row every weather chart carries: what the chart is, and the
 * source stamp.
 *
 * The stamp is not decoration and not optional. The charts beside these in
 * the task-analysis stack are derived from the pilots' own tracklogs —
 * measurements of what happened. The weather charts are a forecast model or a
 * reanalysis sampled at a grid cell that may be 25 km wide and hundreds of
 * metres off in elevation. A reader scanning down the stack must be able to
 * tell, without moving their eyes off the chart, which kind of thing they are
 * looking at. So the provider and the "modelled"/"reanalysis" qualifier sit
 * on EVERY weather chart, directly above its plot, rather than only in a
 * caption at the foot of the stack that print and screenshots would separate
 * from it. The track-derived charts carry "37 tracks · measured" in the
 * same place.
 *
 * It is a row of real text and not `<text>` inside the SVG (issue #860):
 * inside the SVG it could only be shrunk until it fitted, which is how it
 * came to be painted at 5px. It names the provider alone ("Open-Meteo"),
 * not the whole model ("Open-Meteo best-match (ECMWF/regional)"), so that it
 * fits beside the title on a phone.
 *
 * The full credit — provider, model, licence, grid point — lives once in the
 * panel caption, which is also where CC BY attribution is satisfied.
 */
import type { ReactNode } from "react";
import type { WeatherSource } from "@/react/weather/types";
import { sourceKindLabel, sourceShortName } from "@/react/weather/types";
import { MetLegend, type LegendEntry, type LegendLines } from "./MetLegend";

/**
 * A chart's title row and legend.
 *
 * On a phone: the title (and its ⓘ, if any) and the source stamp share the
 * first line, and the legend wraps beneath them. From `sm` up the legend
 * moves onto the title line, between the two, so a 1078px chart does not
 * spend two lines of a wide screen on a title and five words. It is one
 * row that wraps, not two layouts.
 *
 * `when` is the selected hour. It leads the legend row rather than following
 * the title: the title row has to hold still while a finger chooses an hour,
 * and on a 332px phone "Thermal ceiling · 14:00–15:00 AEDT" and the stamp do
 * not fit on one line. The legend row already reserves room for the figures
 * the choice prints (MetLegend's `lines`).
 *
 * The title and the stamp are `aria-hidden`: the chart's accessible name
 * already says what it is and where it came from ({@link sourceSentence}).
 * The ⓘ is not, because it is a control. The track-derived charts pass
 * `stamp` ("37 tracks · measured") in place of a `source`.
 */
export function ChartHeader({
  title,
  when,
  source,
  stamp,
  info,
  legend = [],
  lines = 1,
}: {
  title: string;
  when?: string | null;
  source?: WeatherSource;
  stamp?: string | null;
  /** An ⓘ beside the title (rac/explain.tsx). */
  info?: ReactNode;
  legend?: LegendEntry[];
  lines?: LegendLines;
}) {
  const stampText = source
    ? `${sourceShortName(source)} · ${sourceKindLabel(source.kind)}`
    : (stamp ?? null);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5">
      <span className="inline-flex min-h-6 items-center gap-0.5">
        <span aria-hidden className="text-sm font-semibold">
          {title}
        </span>
        {info}
      </span>
      {stampText ? (
        <span
          aria-hidden
          {...(source ? { "data-met-source": "" } : { "data-chart-source": "" })}
          className="ml-auto text-xs whitespace-nowrap text-muted-foreground sm:order-last"
        >
          {stampText}
        </span>
      ) : null}
      <MetLegend
        entries={legend}
        when={when}
        lines={lines}
        className="basis-full sm:min-w-0 sm:flex-1 sm:basis-0"
      />
    </div>
  );
}

/** The same stamp as a sentence, for a chart's accessible name — a screen
 * reader gets the provenance in the label rather than from a text node
 * it would read out of context. */
export function sourceSentence(source: WeatherSource): string {
  return `Source: ${source.attribution} (${source.model}, ${sourceKindLabel(source.kind)}).`;
}
