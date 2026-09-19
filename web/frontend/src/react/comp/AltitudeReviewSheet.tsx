/**
 * The altitude review — "Check altitudes" — as a full-screen sheet.
 *
 * It began as three extra columns in the waypoints grid, which is the right
 * shape on a desktop and a poor one on a phone. The columns sat to the RIGHT
 * of the frozen Code column, so reaching them scrolled the waypoint's own
 * `Alt (m)` out of sight behind Code — and the one number a reader needs to
 * judge which of the two is wrong was the one they could not see. A
 * disagreement was reported as "+6580", with the file's 6660 m hidden and the
 * map's 80 m visible, and it read as the map being broken when the file was.
 * Add a banner, three buttons and a filter box above a 420 px grid and a phone
 * had room for three rows of the twelve.
 *
 * So the review is a sheet at every width, and the grid went back to being
 * only the waypoint file edited in place. Every row states BOTH altitudes and
 * says which unit they are in. Nothing here scrolls sideways.
 *
 * Two views, one sheet, no nesting: a list, and one waypoint. A second
 * `FullScreenSheet` on top of this one would stack modals and traps; swapping
 * the content keeps one focus trap, one Escape, one back gesture. That is the
 * same arrangement TurnpointSheet uses for the same reason, and like it this
 * is a SHEET rather than a route because the page behind it is unsaved React
 * state: a sibling route would unmount the lot, and `use-unsaved-changes-guard`
 * would prompt "Discard changes?" on the way in.
 *
 * Nothing is applied here either. Accepting an altitude is an ordinary unsaved
 * edit to the page's rows, so the page's Save and its discard-on-leave guard
 * stay the commit and the undo.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon } from "lucide-react";
import { Button, ToggleButton } from "@/react/rac/button";
import {
  FullScreenSheet,
  SheetBody,
  SheetFooter,
  SheetHeader,
} from "@/react/rac/full-screen-sheet";
import { GridList, GridListItem, RowContent } from "@/react/rac/grid-list";
import { NumberField, TextField } from "@/react/rac/field";
import { cn } from "@/react/lib/utils";
import { useBackDismiss } from "@/react/lib/use-back-dismiss";
import { parseCoords } from "./route-editor";
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
  reviewSortKey,
  summariseAltitudeCheck,
  type AltitudePair,
} from "./altitude-check";

/** One waypoint as the review sees it: what it says, and what the map said. */
export interface AltitudeReviewEntry {
  id: number;
  code: string;
  name: string;
  coords: string;
  /** Metres. Undefined when the file carries no altitude. */
  fileAlt?: number;
  /** Metres. Undefined when no terrain reading could be taken. */
  mapAlt?: number;
}

const pairOf = (e: AltitudeReviewEntry): AltitudePair => ({
  ...(e.fileAlt === undefined ? {} : { fileAlt: e.fileAlt }),
  ...(e.mapAlt === undefined ? {} : { mapAlt: e.mapAlt }),
});

/** Metres, as the grid writes them: whole numbers, and the unit spelled out. */
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

export function AltitudeReviewSheet({
  entries,
  onAccept,
  onEditAltitude,
  onEditCoords,
  onConvertFromFeet,
  onClose,
}: {
  /** Every waypoint, in file order. The sheet does its own narrowing. */
  entries: AltitudeReviewEntry[];
  /** Take the map's altitude for these rows. */
  onAccept: (ids: number[]) => void;
  /** Set one waypoint's altitude, or clear it when undefined. */
  onEditAltitude: (id: number, altitude: number | undefined) => void;
  onEditCoords: (id: number, coords: string) => void;
  onConvertFromFeet: () => void;
  onClose: () => void;
}) {
  /**
   * The rows the check picked out, taken ONCE when the sheet opens.
   *
   * A live list would drop each row the instant its altitude was accepted,
   * which reads as having deleted it and leaves nothing to check the result
   * against. The list holds still and the counts do the counting.
   */
  const [reviewIds] = useState(
    () => new Set(entries.filter((e) => needsReview(pairOf(e))).map((e) => e.id))
  );
  /**
   * And the ORDER, taken once with them.
   *
   * Biggest disagreement first — which waypoints disagree is the finding, so
   * it leads. Frozen for the same reason the membership is: re-sorting live
   * sends each row to the bottom of the list the moment its altitude is
   * accepted, because its disagreement has just become zero. Holding the
   * membership still while letting the order move would have kept every row
   * on screen and still moved the one under the reader's thumb.
   */
  const [orderedIds] = useState(() =>
    [...entries]
      .sort((a, b) => reviewSortKey(pairOf(b)) - reviewSortKey(pairOf(a)))
      .map((e) => e.id)
  );
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const summary = useMemo(
    () => summariseAltitudeCheck(entries.map(pairOf)),
    [entries]
  );
  const pattern = useMemo(
    () => detectAltitudePattern(entries.map(pairOf)),
    [entries]
  );

  const shown = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const ids =
      showAll || reviewIds.size === 0
        ? orderedIds
        : orderedIds.filter((id) => reviewIds.has(id));
    // A row whose waypoint has gone is dropped rather than rendered empty.
    return ids
      .map((id) => byId.get(id))
      .filter((e): e is AltitudeReviewEntry => e !== undefined);
  }, [entries, orderedIds, reviewIds, showAll]);

  /** Of those on screen, the ones there is a map altitude to take. */
  const acceptable = shown.filter((e) => e.mapAlt !== undefined && needsReview(pairOf(e)));

  const open = openId === null ? null : entries.find((e) => e.id === openId) ?? null;

  return (
    <FullScreenSheet
      label={open ? `${open.code || "Waypoint"} altitude` : "Check altitudes"}
      onClose={onClose}
      className="flex flex-col"
    >
      {open ? (
        <AltitudeReviewDetail
          // Keyed, so moving to another waypoint remounts the view rather
          // than re-labelling it — which is also what commits its coordinates
          // draft (see below).
          key={open.id}
          entry={open}
          onBack={() => setOpenId(null)}
          listedCount={reviewIds.size}
          onAccept={onAccept}
          onEditAltitude={onEditAltitude}
          onEditCoords={onEditCoords}
        />
      ) : (
        <>
          {/* What the check found, and the way out. The line under the title
              is a live region: accepting rows changes those numbers without
              moving focus. */}
          <SheetHeader
            title="Check altitudes"
            description={
              <p role="status" className="text-sm text-muted-foreground">
                {summary.reviewable > 0
                  ? `${summary.reviewable} of ${entries.length} waypoint${
                      entries.length === 1 ? "" : "s"
                    } to look at`
                  : summary.compared === 0
                    ? "No altitudes could be compared with the map"
                    : `Every altitude that could be checked agrees with the map to within ${SUSPECT_DELTA_M} m`}
              </p>
            }
            action={
              <Button autoFocus variant="outline" size="sm" onPress={onClose}>
                Done
              </Button>
            }
          />

          <SheetBody>
            {/* The breakdown, including the rows deliberately NOT listed. */}
            <p className="text-xs text-muted-foreground">
              {[
                summary.suspect > 0
                  ? `${summary.suspect} differ by more than ${SUSPECT_DELTA_M} m`
                  : null,
                summary.coords > 0
                  ? `${summary.coords} by more than ${COORD_SUSPECT_DELTA_M} m`
                  : null,
                summary.missing > 0 ? `${summary.missing} carry no altitude` : null,
                summary.ok > 0 ? `${summary.ok} agree` : null,
                summary.unreachable > 0
                  ? `${summary.unreachable} could not be read from the map`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>

            {/* A whole-file fault, named before the per-row work starts. */}
            {summary.corruptTerrainRead > 0 ? (
              <p className="mt-3 rounded border border-border bg-muted/40 p-3 text-sm">
                {summary.corruptTerrainRead === 1
                  ? "1 altitude is out by"
                  : `${summary.corruptTerrainRead} altitudes are out by`}{" "}
                almost exactly 6553.6 m, or a multiple of it. That is not
                anything in your waypoint file: it is the signature of a terrain
                reading taken before a decoding fault was fixed, and taking the
                map’s altitude now corrects it.
              </p>
            ) : null}

            {pattern ? (
              <div className="mt-3 rounded border border-border bg-muted/40 p-3 text-sm">
                <p>{describeAltitudePattern(pattern)}</p>
                {pattern.kind === "feet" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onPress={onConvertFromFeet}
                  >
                    Convert all from feet
                  </Button>
                ) : null}
              </div>
            ) : null}

            {/* The list. Each row: both altitudes, the difference, and one
                button that says what it will do. */}
            <GridList
              aria-label="Waypoints to look at"
              variant="rows"
              items={shown}
              className="mt-3"
              renderEmptyState={() => (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Nothing to look at.
                </p>
              )}
              onAction={(key) => setOpenId(Number(key))}
            >
              {(entry) => {
                const pair = pairOf(entry);
                const delta = altitudeDelta(pair);
                const line = verdictLine(pair);
                return (
                  <GridListItem
                    variant="rows"
                    id={entry.id}
                    textValue={entry.code || "waypoint"}
                  >
                    <RowContent
                      title={entry.code || "—"}
                      detailClassName="font-mono"
                      detail={
                        <>
                          {/* Both numbers, both labelled. The failure this
                              replaces was a reader who could only see one. */}
                          {entry.fileAlt === undefined
                            ? "no altitude in the file"
                            : `file ${metres(entry.fileAlt)}`}
                          {" → "}
                          {entry.mapAlt === undefined
                            ? "no map reading"
                            : `map ${metres(entry.mapAlt)}`}
                          {/* A difference of exactly zero is not a finding, it
                              is the absence of one — printing "0 m" beside a
                              row the reader has just fixed is noise where the
                              interesting thing is that there is nothing left
                              to say. */}
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
                          <Button
                            size="sm"
                            variant="outline"
                            onPress={() => onAccept([entry.id])}
                          >
                            Use {metres(entry.mapAlt)}
                          </Button>
                        )
                      }
                      chevron
                    >
                      {/* Why the row is in the list, in words — never a repeat
                          of the numbers above it, and never truncated. */}
                      {line ? <p className="mt-0.5 text-xs">{line}</p> : null}
                    </RowContent>
                  </GridListItem>
                );
              }}
            </GridList>
          </SheetBody>

          {/* The bulk action and the widen toggle. Down here rather than in
              the header because nothing on this view is typed into, so the
              keyboard is never over them. */}
          <SheetFooter>
            <Button
              isDisabled={acceptable.length === 0}
              onPress={() => onAccept(acceptable.map((e) => e.id))}
            >
              Use the map’s altitude for all {acceptable.length}
            </Button>
            {reviewIds.size > 0 ? (
              <ToggleButton size="sm" isSelected={showAll} onChange={setShowAll}>
                {showAll
                  ? `Show only the ${reviewIds.size} to look at`
                  : `Show all ${entries.length} waypoints`}
              </ToggleButton>
            ) : null}
            <p className="w-full text-xs text-muted-foreground">
              Nothing is saved until you press Save. Tasks already built keep
              their own copy of a waypoint, so corrections here do not change
              them.
            </p>
          </SheetFooter>
        </>
      )}
    </FullScreenSheet>
  );
}

/**
 * One waypoint's altitude, in the same sheet.
 *
 * No map, by decision: the page's single Mapbox instance is handed between the
 * inline pane and the full-screen map via one camera ref, and a third place
 * wanting it would be a second instance. The coordinates are editable as text
 * instead, which is what a pasted correction needs anyway.
 *
 * Back and Done both return to the LIST — "done with this waypoint", never
 * "done with the check" — and going back IS "leave it as it is", so no third
 * button says so. Only the list's own Done closes the review.
 *
 * ## The coordinates are a DRAFT; the altitude is live
 *
 * Moving a waypoint makes its terrain reading an answer to a question nobody
 * asked, so the page forgets the reading whenever the coordinates change. Held
 * per keystroke that destroyed the very comparison this view exists to show:
 * the first character typed took `mapAlt` away, so "From the map" fell to
 * "—", the difference line vanished and the accept button unmounted — mid-edit,
 * before the reader had finished pasting a correction. So the field edits a
 * draft, committed once on the way out (which is every way out: Back, Done,
 * the accept button, a browser Back, Escape, or the sheet closing — they all
 * unmount this view, and the commit hangs off that rather than off any one
 * button).
 *
 * The altitude field is deliberately NOT drafted. It is one of the two numbers
 * being compared, so editing it live is the feedback: the difference recounts
 * as you type and blanks the moment the two agree.
 */
function AltitudeReviewDetail({
  entry,
  listedCount,
  onBack,
  onAccept,
  onEditAltitude,
  onEditCoords,
}: {
  entry: AltitudeReviewEntry;
  listedCount: number;
  onBack: () => void;
  onAccept: (ids: number[]) => void;
  onEditAltitude: (id: number, altitude: number | undefined) => void;
  onEditCoords: (id: number, coords: string) => void;
}) {
  // Its own history entry, on top of the sheet's: Back walks this view → the
  // list → the page, one layer per press, which is what a back gesture on a
  // phone is for. FullScreenSheet does the same for the sheet itself.
  useBackDismiss(onBack);

  // The coordinates draft, and what it started as. Through refs as well, so
  // the commit can hang off unmount with no dependencies and still see the
  // last thing typed.
  const [coords, setCoords] = useState(entry.coords);
  const latest = useRef(coords);
  latest.current = coords;
  const committed = useRef({ id: entry.id, coords: entry.coords });
  const commit = useRef(onEditCoords);
  commit.current = onEditCoords;

  useEffect(
    () => () => {
      const { id, coords: was } = committed.current;
      if (latest.current !== was) commit.current(id, latest.current);
    },
    []
  );

  const pair = pairOf(entry);
  const delta = altitudeDelta(pair);
  const coordsValid = parseCoords(coords) !== null;

  return (
    <>
      {/* BOTH of these go back to the list, and neither leaves the review.
          Done used to close the whole sheet from here, which dropped the
          reader out to the waypoints page mid-way down a list of twelve —
          nobody expects "done with this waypoint" to mean "done with the
          check". Leaving the review is the list's own Done.

          No `title`: the waypoint's own name is the body's heading, right
          under this bar, and saying it twice in two sizes reads as two
          different things. */}
      <SheetHeader
        leading={
          <Button autoFocus variant="ghost" size="sm" onPress={onBack}>
            <ChevronLeftIcon className="size-4" aria-hidden="true" />
            {listedCount > 0 ? `All ${listedCount}` : "Back"}
          </Button>
        }
        action={
          <Button variant="outline" size="sm" onPress={onBack}>
            Done
          </Button>
        }
      />

      <SheetBody>
        <h2 className="text-base font-semibold">{entry.code || "Waypoint"}</h2>
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
              {entry.mapAlt === undefined ? "—" : metres(entry.mapAlt)}
            </p>
          </div>
        </div>
        {delta === undefined || Math.round(delta) === 0 ? null : (
          <p className="mt-2 text-center font-mono text-sm">
            {formatAltitudeDelta(delta)} m apart
          </p>
        )}

        {/* Which of the two numbers to doubt, and why. */}
        {looksLikeCorruptedTerrainRead(pair) ? (
          <p className="mt-3 text-sm">
            Out by almost exactly one 6553.6 m step — a terrain reading taken
            before a decoding fault was fixed. The map’s value is the correct
            one.
          </p>
        ) : altitudeVerdict(pair) === "coords" ? (
          <p className="mt-3 text-sm">
            Too far apart for terrain to explain. A mistyped coordinate lands
            the waypoint in the next valley, so check the coordinates below
            before taking the map’s altitude.
          </p>
        ) : altitudeVerdict(pair) === "missing" ? (
          <p className="mt-3 text-sm">
            The file carries no altitude for this waypoint, so there is nothing
            to overwrite.
          </p>
        ) : null}

        {entry.mapAlt === undefined ? null : (
          <Button
            className="mt-4 w-full"
            onPress={() => {
              onAccept([entry.id]);
              onBack();
            }}
          >
            Use the map’s altitude ({metres(entry.mapAlt)})
          </Button>
        )}

        {/* Both editable in place. Metric throughout, like the grid: this is
            the waypoint FILE's own number, not a length shown to a reader. */}
        <div className="mt-6 flex flex-col gap-4">
          <NumberField
            label="Altitude (m)"
            value={entry.fileAlt ?? Number.NaN}
            onChange={(v) => onEditAltitude(entry.id, Number.isNaN(v) ? undefined : v)}
            formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
          />
          {/* A draft — see the note above this component. */}
          <TextField
            label="Coordinates"
            value={coords}
            onChange={setCoords}
            className="font-mono"
            isInvalid={!coordsValid}
            errorMessage={coordsValid ? undefined : "Enter coordinates as “lat, lon”"}
          />
        </div>
      </SheetBody>
    </>
  );
}
