/**
 * The altitude review — "Check altitudes" — as two pages: the list of what
 * the check found (/comp/:id/waypoints/altitudes) and one waypoint of it
 * (/altitudes/:n). The routes are pages/CompAltitudeReviewPage.tsx; this is
 * what they show.
 *
 * It began as three extra columns in the waypoints grid, which is the right
 * shape on a desktop and a poor one on a phone. The columns sat to the RIGHT
 * of the frozen Code column, so reaching them scrolled the waypoint's own
 * `Alt (m)` out of sight behind Code — and the one number a reader needs to
 * judge which of the two is wrong was the one they could not see. A
 * disagreement was reported as "+6580", with the file's 6660 m hidden and the
 * map's 80 m visible, and it read as the map being broken when the file was.
 *
 * So every row states BOTH altitudes and says which unit they are in, and
 * nothing here scrolls sideways. It was a full-screen sheet with its two views
 * swapped inside it until #811, when the overlays rule in CLAUDE.md made each
 * view a page: Back walks from one waypoint to the list and from the list to
 * the waypoints, as a browser's Back does.
 *
 * The list is a SNAPSHOT, in membership and in order, taken when the check
 * ran and kept in the waypoints draft (comp/waypoints-draft.ts), so it is the
 * same list after a visit to one waypoint and after a reload.
 *
 * Nothing is applied here either. Accepting an altitude is an ordinary unsaved
 * edit to the draft, so Save on the waypoints page stays the commit.
 */
import { useState } from "react";
import { ChevronLeftIcon } from "lucide-react";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button, ToggleButton } from "@/react/rac/button";
import { GridList, GridListItem, RowContent } from "@/react/rac/grid-list";
import { NumberField } from "@/react/rac/field";
import { SectionHeader } from "../components/SectionHeader";
import { underAltitudeReview, underCompWaypoints } from "../lib/crumbs";
import { cn } from "@/react/lib/utils";
import { parseCoords } from "./route-editor";
import { CoordsField } from "./fields";
import {
  COORD_SUSPECT_DELTA_M,
  SUSPECT_DELTA_M,
  altitudeDelta,
  altitudeVerdict,
  describeAltitudePattern,
  detectAltitudePattern,
  formatAltitudeDelta,
  looksLikeCorruptedTerrainRead,
  needsReview,
  summariseAltitudeCheck,
  type AltitudePair,
} from "./altitude-check";
import { pairOf, type AltitudeReviewEntry } from "./waypoints-draft";

/** Metres, as the file writes them: whole numbers, and the unit spelled out. */
const metres = (v: number) => `${Math.round(v)} m`;

/**
 * Why this waypoint is in the list, in words.
 *
 * Words rather than a colour, and never a repeat of the numbers beside it: the
 * row already prints both altitudes and their difference, so this line's whole
 * job is to say what to DO about them.
 */
function verdictLine(pair: AltitudePair): string | null {
  switch (altitudeVerdict(pair)) {
    case "missing":
      return "The file has no altitude for this waypoint";
    case "coords":
      return looksLikeCorruptedTerrainRead(pair)
        ? "Not your file: an old terrain-read fault"
        : "Too far apart for terrain — check the coordinates";
    case "unreachable":
      return "No terrain reading here";
    default:
      return null;
  }
}

export function AltitudeReviewList({
  compId,
  compName,
  entries,
  shown,
  listedCount,
  showAll,
  onShowAll,
  onOpen,
  onAccept,
  onConvertFromFeet,
  onDone,
}: {
  /** As it goes in URLs. */
  compId: string;
  compName: string;
  /** Every waypoint, in file order: what the counts and the pattern read. */
  entries: AltitudeReviewEntry[];
  /** The rows on the list, in the snapshot's order. */
  shown: AltitudeReviewEntry[];
  /** How many rows the check picked out. */
  listedCount: number;
  showAll: boolean;
  onShowAll: (all: boolean) => void;
  onOpen: (id: number) => void;
  /** Take the map's altitude for these rows. */
  onAccept: (ids: number[]) => void;
  onConvertFromFeet: () => void;
  /** Leave the review. */
  onDone: () => void;
}) {
  const pairs = entries.map(pairOf);
  const summary = summariseAltitudeCheck(pairs);
  const pattern = detectAltitudePattern(pairs);
  /** Of those on screen, the ones there is a map altitude to take. */
  const acceptable = shown.filter((e) => e.mapAlt !== undefined && needsReview(pairOf(e)));

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underCompWaypoints(compId, compName)} current="Check altitudes" />
      {/* What the check found, and the way out. */}
      <SectionHeader
        as="h1"
        className="mt-2"
        title="Check altitudes"
        action={
          <Button variant="outline" size="sm" onPress={onDone}>
            Done
          </Button>
        }
      />
      {/* A live region: accepting rows changes these numbers without moving
          focus. */}
      <p role="status" className="mt-1 text-sm text-muted-foreground">
        {summary.reviewable > 0
          ? `${summary.reviewable} of ${entries.length} waypoint${
              entries.length === 1 ? "" : "s"
            } to look at`
          : summary.compared === 0
            ? "No altitudes could be compared with the map"
            : `Every altitude that could be checked agrees with the map to within ${SUSPECT_DELTA_M} m`}
      </p>

      {/* The breakdown, including the rows deliberately NOT listed. */}
      <p className="mt-3 text-xs text-muted-foreground">
        {[
          summary.suspect > 0 ? `${summary.suspect} differ by more than ${SUSPECT_DELTA_M} m` : null,
          summary.coords > 0 ? `${summary.coords} by more than ${COORD_SUSPECT_DELTA_M} m` : null,
          summary.missing > 0 ? `${summary.missing} carry no altitude` : null,
          summary.ok > 0 ? `${summary.ok} agree` : null,
          summary.unreachable > 0 ? `${summary.unreachable} could not be read from the map` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {/* A whole-file fault, named before the per-row work starts. */}
      {summary.corruptTerrainRead > 0 ? (
        <p className="mt-3 rounded border border-border bg-muted/40 p-3 text-sm">
          {summary.corruptTerrainRead === 1
            ? "1 altitude is"
            : `${summary.corruptTerrainRead} altitudes are`}{" "}
          off by a multiple of 6553.6 m — an old terrain-reading bug, not your
          file. Using the map’s altitude fixes it.
        </p>
      ) : null}

      {pattern ? (
        <div className="mt-3 rounded border border-border bg-muted/40 p-3 text-sm">
          <p>{describeAltitudePattern(pattern)}</p>
          {pattern.kind === "feet" ? (
            <Button variant="outline" size="sm" className="mt-2" onPress={onConvertFromFeet}>
              Convert all from feet
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* The list. Each row: both altitudes, the difference, and one button
          that says what it will do. */}
      <GridList
        aria-label="Waypoints to look at"
        variant="rows"
        items={shown}
        className="mt-3"
        renderEmptyState={() => (
          <p className="p-6 text-center text-sm text-muted-foreground">Nothing to look at.</p>
        )}
        onAction={(key) => onOpen(Number(key))}
      >
        {(entry) => {
          const pair = pairOf(entry);
          const delta = altitudeDelta(pair);
          const line = verdictLine(pair);
          return (
            <GridListItem variant="rows" id={entry.id} textValue={entry.code || "waypoint"}>
              <RowContent
                title={entry.code || "—"}
                detailClassName="font-mono"
                detail={
                  <>
                    {/* Both numbers, both labelled. The failure this replaces
                        was a reader who could only see one. */}
                    {entry.fileAlt === undefined
                      ? "no altitude in the file"
                      : `file ${metres(entry.fileAlt)}`}
                    {" → "}
                    {entry.mapAlt === undefined ? "no map reading" : `map ${metres(entry.mapAlt)}`}
                    {/* A difference of exactly zero is not a finding, it is
                        the absence of one — printing "0 m" beside a row the
                        reader has just fixed is noise. */}
                    {delta === undefined || Math.round(delta) === 0 ? null : (
                      <span
                        className={cn(
                          "ml-2 font-semibold",
                          altitudeVerdict(pair) === "coords" && "text-destructive"
                        )}
                      >
                        {formatAltitudeDelta(delta)} m
                      </span>
                    )}
                  </>
                }
                action={
                  entry.mapAlt === undefined ? undefined : (
                    <Button size="sm" variant="outline" onPress={() => onAccept([entry.id])}>
                      Use {metres(entry.mapAlt)}
                    </Button>
                  )
                }
                chevron
              >
                {/* Why the row is in the list, in words — never a repeat of
                    the numbers above it, and never truncated. */}
                {line ? <p className="mt-0.5 text-xs">{line}</p> : null}
              </RowContent>
            </GridListItem>
          );
        }}
      </GridList>

      {/* The bulk action and the widen toggle, kept in reach at the foot of
          the screen while the list scrolls: nothing on this page is typed
          into, so the keyboard is never over them. Sticky, never fixed (the
          overlays rule in CLAUDE.md). */}
      <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 pt-3 pb-gutter-safe backdrop-blur-sm">
        <Button
          isDisabled={acceptable.length === 0}
          onPress={() => onAccept(acceptable.map((e) => e.id))}
        >
          Use the map’s altitude for all {acceptable.length}
        </Button>
        {listedCount > 0 ? (
          <ToggleButton size="sm" isSelected={showAll} onChange={onShowAll}>
            {showAll ? `Show only the ${listedCount} to look at` : `Show all ${entries.length} waypoints`}
          </ToggleButton>
        ) : null}
        <p className="w-full text-xs text-muted-foreground">
          Nothing is saved until you press Save. Existing tasks keep their own
          copies and won’t change.
        </p>
      </div>
    </div>
  );
}

/**
 * One waypoint's altitude, on a page of its own.
 *
 * No map, by decision: the coordinates are editable as text instead, which is
 * what a pasted correction needs anyway.
 *
 * Back and Done both return to the review's LIST — "done with this
 * waypoint", never "done with the check" — and going back IS "leave it as it
 * is", so no third button says so. Only the list's own Done leaves the review.
 *
 * ## The comparison holds still while the coordinates are edited
 *
 * Moving a waypoint makes its terrain reading an answer to a question nobody
 * asked, so a reading only counts while the waypoint is where it was read
 * (`readingFor`, comp/waypoints-draft.ts). Applied per keystroke, that
 * destroyed the very comparison this view exists to show: the first character
 * typed took the map's altitude away, so "From the map" fell to "—", the
 * difference line vanished and the accept button unmounted — mid-edit, before
 * the reader had finished pasting a correction. So the page shows the reading
 * the waypoint had when the page opened (`mapAlt` here), however the
 * coordinates change while it is open; back on the list, the moved waypoint
 * reads "no map reading".
 *
 * The altitude is one of the two numbers being compared, so editing it is the
 * feedback: the difference recounts and blanks the moment the two agree.
 */
export function AltitudeReviewDetail({
  compId,
  compName,
  entry,
  mapAlt,
  listedCount,
  onBack,
  onUseMapAltitude,
  onEditAltitude,
  onEditCoords,
}: {
  compId: string;
  compName: string;
  entry: AltitudeReviewEntry;
  /** The reading the waypoint had when this page opened. */
  mapAlt: number | undefined;
  listedCount: number;
  /** Back to the review's list. */
  onBack: () => void;
  onUseMapAltitude: (altitude: number) => void;
  /** Set the altitude, or clear it when undefined. */
  onEditAltitude: (altitude: number | undefined) => void;
  onEditCoords: (coords: string) => void;
}) {
  const pair = pairOf({ ...entry, mapAlt });
  const delta = altitudeDelta(pair);

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underAltitudeReview(compId, compName)} current={entry.code || "Waypoint"} />
      {/* BOTH of these go back to the list, and neither leaves the review.
          Done used to close the whole review from here, which dropped the
          reader out to the waypoints page mid-way down a list of twelve —
          nobody expects "done with this waypoint" to mean "done with the
          check". Leaving the review is the list's own Done. */}
      <div className="mt-2 flex items-center gap-2">
        <Button variant="ghost" size="sm" onPress={onBack}>
          <ChevronLeftIcon className="size-4" aria-hidden="true" />
          {listedCount > 0 ? `All ${listedCount}` : "Back"}
        </Button>
        <Button variant="outline" size="sm" className="ms-auto" onPress={onBack}>
          Done
        </Button>
      </div>

      <h1 className="mt-3 text-2xl font-bold">{entry.code || "Waypoint"}</h1>
      {entry.name && entry.name !== entry.code ? (
        <p className="text-sm text-muted-foreground">{entry.name}</p>
      ) : null}

      {/* The comparison, side by side and both labelled — the whole point. */}
      <div className="mt-4 flex items-start gap-4 rounded border border-border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">In the file</p>
          <p className="font-mono text-xl font-semibold">
            {entry.fileAlt === undefined ? "—" : metres(entry.fileAlt)}
          </p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">From the map</p>
          <p className="font-mono text-xl font-semibold">
            {mapAlt === undefined ? "—" : metres(mapAlt)}
          </p>
        </div>
      </div>
      {delta === undefined || Math.round(delta) === 0 ? null : (
        <p className="mt-2 text-center font-mono text-sm">{formatAltitudeDelta(delta)} m apart</p>
      )}

      {/* Which of the two numbers to doubt, and why. */}
      {looksLikeCorruptedTerrainRead(pair) ? (
        <p className="mt-3 text-sm">
          Out by almost exactly one 6553.6 m step — a terrain reading taken
          before a decoding fault was fixed. The map’s value is the correct one.
        </p>
      ) : altitudeVerdict(pair) === "coords" ? (
        <p className="mt-3 text-sm">
          Too far apart to be terrain. Check the coordinates below first — a
          typo can put a waypoint in the next valley.
        </p>
      ) : altitudeVerdict(pair) === "missing" ? (
        <p className="mt-3 text-sm">
          The file carries no altitude for this waypoint, so there is nothing to
          overwrite.
        </p>
      ) : null}

      {mapAlt === undefined ? null : (
        <Button className="mt-4 w-full" onPress={() => onUseMapAltitude(mapAlt)}>
          Use the map’s altitude ({metres(mapAlt)})
        </Button>
      )}

      {/* Both editable in place. Metric throughout, like the waypoint's own
          page: this is the waypoint FILE's own number, not a length shown to
          a reader. */}
      <div className="mt-6 flex flex-col gap-4">
        <NumberField
          label="Altitude (m)"
          value={entry.fileAlt ?? Number.NaN}
          onChange={(v) => onEditAltitude(Number.isNaN(v) ? undefined : v)}
          formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
        />
        <CoordsField
          value={entry.coords}
          onChange={onEditCoords}
          required
          className="font-mono"
        />
      </div>
    </div>
  );
}

/** The reading a waypoint had when its review page opened — held still. */
export function useHeldReading(initial: number | undefined): number | undefined {
  const [held] = useState(initial);
  return held;
}
