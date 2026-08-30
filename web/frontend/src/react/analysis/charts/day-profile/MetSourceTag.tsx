/**
 * The source stamp every weather chart in the panel carries.
 *
 * Not decoration and not optional. The charts above it in the stack are
 * derived from the pilots' own tracklogs — measurements of what happened.
 * The weather charts are a forecast model or a reanalysis sampled at a grid
 * cell that may be 25 km wide and hundreds of metres off in elevation. A
 * reader scanning down the stack must be able to tell, without moving their
 * eyes off the chart, which kind of thing they are looking at. So the model
 * name and the "modelled"/"reanalysis" qualifier are rendered INSIDE the
 * SVG, at the top right of each weather chart, rather than only in a caption
 * that print and screenshots would separate from the plot.
 *
 * The full credit — provider, licence, grid point — lives once in the panel
 * caption, which is also where CC BY attribution is satisfied.
 */
import type { WeatherSource } from "@/react/weather/types";
import { sourceKindLabel } from "@/react/weather/types";
import { PLOT_RIGHT } from "./shared";

export function MetSourceTag({ source, y }: { source: WeatherSource; y: number }) {
  return (
    <text
      aria-hidden
      x={PLOT_RIGHT}
      y={y}
      textAnchor="end"
      className="fill-current text-[9px] text-muted-foreground"
    >
      {source.model} · {sourceKindLabel(source.kind)}
    </text>
  );
}

/** The same stamp as a sentence, for a chart's accessible name — a screen
 * reader gets the provenance in the label rather than from a `<text>` node
 * it would read out of context. */
export function sourceSentence(source: WeatherSource): string {
  return `Source: ${source.attribution} (${source.model}, ${sourceKindLabel(source.kind)}).`;
}
