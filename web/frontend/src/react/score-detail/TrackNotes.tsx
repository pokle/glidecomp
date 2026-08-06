/**
 * The two notes the report card puts around its explanation: what the quality
 * checks made of the tracklog, and what the altitude cleaning pass repaired.
 *
 * Split out of PilotScoreDetail — see TrackScrubber.tsx.
 */
import { useState } from "react";
import type { IGCFix } from "@glidecomp/engine";
import { Card } from "@/react/rac/card";
import { Badge } from "@/react/rac/badge";
import { TrackCleaningChart } from "@/react/charts/TrackCleaningChart";
import { formatTimeInZone } from "../lib/time";
import type { AltitudeCleaningData, TrackQualityData } from "../comp/types";

/**
 * What the data-quality checks made of this tracklog (engine
 * track-quality.ts, FAI S7A §4.4.2).
 *
 * Renders ABOVE the explanation, unlike TrackDataCleaningNote below it,
 * because it changes the meaning of everything under it. A hard verdict says
 * the file is not this flight; a soft one is information for a scorekeeper
 * about a flight that is still scored — the two must not read the same, and
 * the soft wording is deliberately not accusatory, because soft findings fire
 * routinely on legitimate 0-scoring tracks.
 *
 * Every string comes from the engine already rendered, so there is nothing
 * here to format and no hydration surface. Static content, so it is a plain
 * labelled section rather than an alert live region, and the badge carries
 * text so colour is never the only signal.
 */
export function TrackQualityNote({
  quality,
  /** True when the explanation itself is the excluded-track narrative, which
   * already lists these findings — showing them twice on one page reads as a
   * bug. The note still carries them for an OVERRIDDEN track, where the
   * explanation is the normal one and this is the only place they appear. */
  inExplanation,
}: {
  quality: TrackQualityData | null;
  inExplanation: boolean;
}) {
  if (!quality || quality.findings.length === 0 || inExplanation) return null;
  const hard = quality.hardFailed;
  return (
    <Card
      aria-labelledby="track-quality-heading"
      className={hard ? "border-destructive/50" : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="track-quality-heading" className="font-semibold">
          {hard ? "Tracklog excluded from scoring" : "Check this tracklog"}
        </h2>
        <Badge variant={hard ? "destructive" : "outline"} className="shrink-0">
          {hard ? "Excluded" : "Flagged"}
        </Badge>
      </div>
      <ul className="mt-2 space-y-2">
        {quality.findings.map((f) => (
          <li key={f.id}>
            <p className={`text-sm ${hard ? "font-medium" : ""}`}>{f.title}</p>
            <p className="text-xs text-muted-foreground">{f.detail}</p>
          </li>
        ))}
      </ul>
      <TrackValidityDocLink className="mt-3" />
    </Card>
  );
}

/**
 * The public explainer for the validity checks. Rendered inside the note
 * above for a flagged-but-scored track, and separately under the explanation
 * for a withheld one — where the note suppresses itself, but the pilot has
 * just been shown a zero and needs this link most.
 */
export function TrackValidityDocLink({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-muted-foreground ${className}`}>
      <a href="/scoring/track-validity" className="underline underline-offset-2">
        How track validity checks work
      </a>
    </p>
  );
}

/**
 * Transparency note: what the engine's altitude plausibility pass repaired
 * in this track before analysis (GPS glitches cross-checked against the
 * barometric channel, or caught by vertical-speed limits). Rendered only
 * when something was actually repaired — a clean track needs no disclaimer.
 * Times are formatted in the comp's zone (SSR-deterministic).
 *
 * The list is the exact record and always renders. Once the tracklog the map
 * needs has arrived, the same repairs are also drawn — raw GPS, raw barometer
 * and the cleaned line the analysis used, the figure /scoring/data-cleaning
 * explains — and each list entry becomes the control that zooms the chart to
 * that stretch. Text first, picture second, on purpose: the chart is
 * client-only (there are no fixes server-side), so the page's server-rendered
 * content is unchanged.
 */
export function TrackDataCleaningNote({
  cleaning,
  timezone,
  fixes,
}: {
  cleaning: AltitudeCleaningData | null;
  timezone: string | null;
  /** The parsed tracklog, once downloaded — null until then. */
  fixes: IGCFix[] | null;
}) {
  // Unconditional: `cleaning` arrives with the SSR seed on some paths and a
  // fetch on others, so this component must not choose a hook path by it.
  const [selected, setSelected] = useState<number | null>(null);
  if (!cleaning || cleaning.repairedFixCount === 0) return null;
  const time = (ms: number) => formatTimeInZone(new Date(ms), timezone ?? undefined);
  const pct = (100 * cleaning.repairedFixCount) / cleaning.totalFixCount;
  const charted = fixes != null && fixes.length > 1;
  const entryText = (r: AltitudeCleaningData["ranges"][number]) =>
    `${
      r.startTimeMs === r.endTimeMs
        ? time(r.startTimeMs)
        : `${time(r.startTimeMs)}–${time(r.endTimeMs)}`
    } · ${r.fixCount} fix${r.fixCount === 1 ? "" : "es"} · up to ${Math.round(
      r.maxCorrectionMeters,
    )} m off`;
  return (
    <Card>
      <h2 className="font-semibold">Track data cleaning</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {cleaning.repairedFixCount} of {cleaning.totalFixCount} GPS fixes (
        {pct < 0.1 ? "<0.1" : pct.toFixed(1)}%) carried an implausible altitude
        and were repaired before analysis —{" "}
        {cleaning.crossChecked
          ? "flagged by cross-checking GPS altitude against the barometric channel"
          : "flagged by vertical-speed limits (no barometric channel to cross-check)"}
        . Positions and times are never altered.{" "}
        <a href="/scoring/data-cleaning" className="underline underline-offset-2">
          How data cleaning works
        </a>
      </p>
      {charted ? (
        <TrackCleaningChart
          fixes={fixes}
          ranges={cleaning.ranges}
          selected={selected}
          timezone={timezone}
          onSelectRange={setSelected}
        />
      ) : null}
      {charted ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {selected === null ? (
            "Pick a stretch below to zoom the chart to it."
          ) : (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="cursor-pointer underline underline-offset-2"
            >
              Show the whole flight
            </button>
          )}
        </p>
      ) : null}
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {cleaning.ranges.map((r, i) => (
          <li key={r.startIndex} className="tabular-nums">
            {charted ? (
              // Selecting an entry zooms the chart to it; selecting it again
              // returns to the whole flight. aria-pressed rather than a link
              // or a radio: it toggles what the figure beside it shows.
              <button
                type="button"
                aria-pressed={i === selected}
                onClick={() => setSelected(i === selected ? null : i)}
                className={`cursor-pointer rounded text-left underline-offset-2 hover:underline ${
                  i === selected ? "font-medium text-foreground underline" : ""
                }`}
              >
                {entryText(r)}
              </button>
            ) : (
              entryText(r)
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
