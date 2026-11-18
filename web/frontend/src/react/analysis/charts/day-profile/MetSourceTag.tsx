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
 * looking at. So the model name and the "modelled"/"reanalysis" qualifier sit
 * on EVERY weather chart, directly above its plot, rather than only in a
 * caption at the foot of the stack that print and screenshots would separate
 * from it.
 *
 * It is a row of real text and not `<text>` inside the SVG (issue #860). At
 * a readable size the stamp alone is about 300px, and the chart on a phone is
 * 319px: inside the SVG it could only be shrunk until it fitted, which is
 * how it came to be painted at 5px. As text it wraps under the title.
 *
 * The full credit — provider, licence, grid point — lives once in the panel
 * caption, which is also where CC BY attribution is satisfied.
 */
import type { WeatherSource } from "@/react/weather/types";
import { sourceKindLabel } from "@/react/weather/types";

/**
 * `aria-hidden`: the chart's accessible name already says what it is and
 * where it came from ({@link sourceSentence}).
 *
 * `when` is the selected hour, printed beside the title while one is chosen,
 * so the figures in the legend row beneath say which hour they are for. The
 * track-derived charts in the same stack use this row too, with no `source`:
 * their title already says "From tracks".
 */
export function ChartHeader({
  title,
  when,
  source,
}: {
  title: string;
  when?: string | null;
  source?: WeatherSource;
}) {
  return (
    <div
      aria-hidden
      className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground"
    >
      <span>
        <span className="font-medium">{title}</span>
        {when ? (
          <span data-chart-when className="font-medium text-foreground">
            {" "}
            · {when}
          </span>
        ) : null}
      </span>
      {source ? (
        <span data-met-source>
          {source.model} · {sourceKindLabel(source.kind)}
        </span>
      ) : null}
    </div>
  );
}

/** The same stamp as a sentence, for a chart's accessible name — a screen
 * reader gets the provenance in the label rather than from a text node
 * it would read out of context. */
export function sourceSentence(source: WeatherSource): string {
  return `Source: ${source.attribution} (${source.model}, ${sourceKindLabel(source.kind)}).`;
}
