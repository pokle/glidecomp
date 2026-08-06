/**
 * One section of the score explanation, and one line within it.
 *
 * Split out of PilotScoreDetail — see TrackScrubber.tsx.
 */
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
} from "@glidecomp/engine";
import { Card } from "@/react/rac/card";
import { ScoreChartView } from "@/react/charts/ScoreChartView";
import { MapPinIcon } from "./icons";

export function ExplanationSection({
  section,
  selectedItem,
  hasAnchor,
  onItemClick,
}: {
  section: ScoreExplanationSection;
  selectedItem: string | null;
  hasAnchor: (item: ScoreExplanationItem) => boolean;
  onItemClick: (item: ScoreExplanationItem) => void;
}) {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{section.title}</h2>
        {section.points !== undefined ? (
          <span className="shrink-0 font-semibold tabular-nums">
            {Math.round(section.points * 10) / 10}
            {/* "of 156.2" — the component's offer beside its points, so a
                not-maxed component is scannable without reading a formula. */}
            {section.pointsAvailable !== undefined ? (
              <span className="font-normal text-muted-foreground">
                {" of "}
                {Math.round(section.pointsAvailable * 10) / 10}
              </span>
            ) : null}{" "}
            pts
          </span>
        ) : null}
      </div>
      {/* Where this pilot placed on the section's own input ("2nd fastest of
          12 through the speed section") — worded by the engine. */}
      {section.rank ? (
        <p className="mt-0.5 text-sm text-muted-foreground">{section.rank}</p>
      ) : null}
      {section.summary ? (
        <p className="mt-1 text-sm text-muted-foreground">{section.summary}</p>
      ) : null}
      {/* The way out of this page for a reader who doesn't know GAP. The
          explainer at /scoring/gap is written for exactly this person and,
          until now, nothing on the report card linked to it — the only doc
          links here fired when something had gone wrong with the track. The
          accessible name carries the section, so a screen-reader user
          scanning links doesn't hear "How this works" six times. */}
      {section.docHref ? (
        <p className="mt-1">
          <a
            href={section.docHref}
            aria-label={`How ${section.title.toLowerCase()} works`}
            className="text-xs text-muted-foreground underline underline-offset-2"
          >
            How this works
          </a>
        </p>
      ) : null}
      <div className="mt-2 space-y-1">
        {section.items.map((item) => (
          <ExplanationItem
            key={item.id}
            item={item}
            anchored={hasAnchor(item)}
            selected={selectedItem === item.id}
            onClick={() => onItemClick(item)}
          />
        ))}
      </div>
      {/* The component's formula with the field on it, UNDER the arithmetic
          it illustrates: the numbers are the answer, the curve is the shape.
          Inline SVG, so it is in the server-rendered first paint. */}
      {section.chart ? <ScoreChartView chart={section.chart} /> : null}
    </Card>
  );
}

export function ExplanationItem({
  item,
  anchored,
  selected,
  onClick,
}: {
  item: ScoreExplanationItem;
  anchored: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const textClass =
    item.emphasis === "warning"
      ? "text-amber-600 dark:text-amber-500"
      : item.emphasis === "muted"
        ? "text-muted-foreground"
        : "";

  // A sparkline belongs beside its row's number, not under its prose — it is
  // an annotation on the figure. Anything larger (the distance distribution)
  // is a figure in its own right and goes below the whole row.
  const inlineChart = item.chart?.kind === "validity";

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-sm ${textClass}`}>
          {anchored ? (
            <MapPinIcon className="mr-1 inline-block size-3.5 shrink-0 -translate-y-px text-muted-foreground" />
          ) : null}
          {item.text}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {inlineChart ? <ScoreChartView chart={item.chart!} /> : null}
          {item.value ? (
            <span className="text-sm tabular-nums text-muted-foreground">
              {item.value}
            </span>
          ) : null}
        </span>
      </div>
      {item.detail ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
      ) : null}
      {item.chart && !inlineChart ? <ScoreChartView chart={item.chart} /> : null}
    </>
  );

  if (!anchored) {
    return <div className="rounded-md px-2 py-1.5">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title="Show on map"
      className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 ${
        selected ? "bg-muted" : ""
      }`}
    >
      {body}
    </button>
  );
}
