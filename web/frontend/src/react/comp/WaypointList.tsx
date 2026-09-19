/**
 * The waypoint set as a LIST — the editor for /comp/:id/waypoints, at every
 * width.
 *
 * It replaced a 145-row, eight-column Tabulator grid, and replaced it
 * everywhere rather than below a breakpoint: two editors meant two code paths
 * and a reviewer on a desktop seeing something the author never tested on a
 * phone (see the mobile-first rule in CLAUDE.md). The grid did not work at a
 * phone's width at all — eight columns do not fit, so it scrolled sideways
 * inside a page that scrolled down, under a map pane that stuck, and the
 * frozen Code column hid whichever column sat next to it, which is how a
 * reader came to see a waypoint's map altitude without its file altitude.
 *
 * A row shows everything a waypoint has, on two lines, with no sideways
 * scrolling anywhere. Tapping it opens {@link WaypointSheet}; the pin beside
 * it flies the page's map instead, which is why this is a GridList rather than
 * a NavList — a row here holds a button (see rac/grid-list.tsx). Read-only,
 * where no sheet opens, the row itself is what flies the map.
 *
 * ## Read-only is the same list, not a table
 *
 * Omit `onOpen` and this is the view an anonymous visitor gets. That view used
 * to be a six-column RAC `Table` inside an `overflow-x-auto` scroll region —
 * so the sideways-scrolling table this list replaced for admins survived for
 * the PILOT, who is the one actually standing on a hill holding a phone, while
 * the organiser more likely to be at a desk got the list. One shape at every
 * width, for everyone, is the whole point of the rule.
 *
 * There is nothing to open, so a read-only row has no chevron — and its WHOLE
 * WIDTH flies the map instead. The pin was the only target for that at first,
 * and a 32 px icon is a poor thing to ask a thumb to find on a hill when the
 * row beside it is doing nothing with 300 px. The pin stays, because it is
 * what NAMES the action ("Show BEACH on the map") for a reader who cannot see
 * the map move; pressing it and pressing the row do the same one thing, so
 * this is one action with a big target rather than two ways to do it.
 *
 * It cost the table's column sorting, which can come back as a sort control
 * over this list if anyone misses it. The filter box above it did not move.
 *
 * The one thing the two modes do NOT share is the altitude's unit. The editor
 * is the waypoint FILE edited in place, so it is metric throughout and says
 * so; a read-only row is an altitude PRINTED to a reader, so it honours their
 * unit preference like every other altitude in the app (issue #662).
 */
import { MapPinIcon } from "lucide-react";
import { Button } from "@/react/rac/button";
import { GridList, GridListItem, RowContent } from "@/react/rac/grid-list";
import { formatAltitude, radiusLabel, useUnits } from "@/react/lib/units";
import { parseCoords } from "./route-editor";
import { cn } from "@/react/lib/utils";

/**
 * The locate pin's target: the row's whole left-hand strip.
 *
 * At `size="icon-sm"` the pin was 28x28 px — about a third of the area a thumb
 * wants, sitting next to 300 px of row doing nothing with it. So it stretches
 * to the row's full height and eats the row's own padding to reach the card's
 * edge and the hairlines above and below: `self-stretch` for the height, and
 * `-my-2.5 -ml-4` to cancel the `py-2.5 px-4` of `navRowClass`. Its own
 * `px-4` puts the icon back where it was, so the strip runs from the card's
 * edge to 48 px and the row's text moves right by 4 px and no more.
 *
 * **It must NOT be given `size="icon-sm"`.** That is `size-7`, and
 * tailwind-merge does not treat `size-*` as conflicting with `h-*`/`w-*` — so
 * the `h-auto w-12` below would not replace it, both rules would land in the
 * stylesheet, and which one won would come down to CSS source order. The
 * default size's `h-9` DOES merge away, which is why no `size` is passed.
 * `e2e/comp-waypoints.spec.ts` measures the rendered box rather than trusting
 * any of this.
 *
 * `rounded-none` because it now meets two edges — the list surface's
 * `overflow-hidden` clips it into the card's corner — and an inset focus ring
 * for the same reason: a 3 px ring on the outside would be half clipped.
 */
const LOCATE_STRIP =
  "-my-2.5 -ml-4 h-auto w-12 self-stretch rounded-none px-4 data-focus-visible:ring-inset";

/** What the list needs of a row. Matches the page's WpRow. */
export interface WaypointListRow {
  id: number;
  code: string;
  name: string;
  coords: string;
  altitude: string;
  radius: string;
}

export function WaypointList({
  rows,
  emptyMessage,
  onOpen,
  onLocate,
}: {
  rows: WaypointListRow[];
  /** Why the list is empty — "nothing yet" and "nothing matches" differ. */
  emptyMessage?: string;
  /**
   * Open one waypoint's sheet. Leave it out for the read-only view, where
   * there is nothing behind a row — the absence of this IS the read-only
   * mode, and it also decides what pressing a row does.
   */
  onOpen?: (id: number) => void;
  /** Fly the page's map to this waypoint. */
  onLocate: (row: WaypointListRow) => void;
}) {
  const units = useUnits();
  const readOnly = onOpen === undefined;

  /**
   * Read-only: the whole row flies the map, since nothing else is behind it.
   *
   * RAC does not fire a row's action when a focusable child of it is pressed,
   * so the pin inside the row keeps working as itself rather than firing this
   * a second time.
   */
  const locateByKey = (key: number | string) => {
    const row = rows.find((r) => r.id === Number(key));
    // Guarded for the same reason the pin is disabled: there is nowhere to fly
    // to without coordinates that parse.
    if (row && parseCoords(row.coords) !== null) onLocate(row);
  };

  return (
    <GridList
      // The editor and the published set are different things and are named
      // apart, so a reader (and a test) can tell which one they have.
      aria-label={readOnly ? "Waypoints" : "Edit waypoints"}
      variant="rows"
      items={rows}
      onAction={onOpen ? (key) => onOpen(Number(key)) : locateByKey}
      renderEmptyState={() => (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {emptyMessage ??
            (readOnly
              ? "No waypoints yet."
              : "No waypoints yet. Upload a file or add points from the map to get started.")}
        </p>
      )}
    >
      {(row) => {
        const valid = parseCoords(row.coords) !== null;
        const altitude = row.altitude.trim();
        const altNumber = Number(altitude);
        return (
          <GridListItem
            variant="rows"
            id={row.id}
            textValue={row.code || "waypoint"}
            // Every row does something — opens its sheet, or flies the map —
            // except a read-only one with coordinates that do not parse.
            className={valid || !readOnly ? "cursor-pointer" : "cursor-default"}
          >
            <RowContent
              leading={
                <Button
                  variant="ghost"
                  className={LOCATE_STRIP}
                  aria-label={`Show ${row.code || "waypoint"} on the map`}
                  isDisabled={!valid}
                  onPress={() => onLocate(row)}
                >
                  <MapPinIcon className="size-4" aria-hidden="true" />
                </Button>
              }
              title={
                <>
                  {row.code || "—"}
                  {row.name ? (
                    <span className="ml-2 font-normal text-muted-foreground">
                      {row.name}
                    </span>
                  ) : null}
                </>
              }
              // Everything else on one mono line: the altitude is HERE, not
              // behind a frozen column. A blank altitude reads as unknown and
              // a zero reads as zero — they are different facts.
              detailClassName={cn("font-mono", !valid && "text-destructive")}
              detail={
                <>
                  {valid ? row.coords : `${row.coords || "no coordinates"} — invalid`}
                  {" · "}
                  {altitude === ""
                    ? "no altitude"
                    : readOnly && Number.isFinite(altNumber)
                      ? formatAltitude(altNumber, { prefs: units }).withUnit
                      : `${row.altitude} m`}
                  {" · "}
                  {radiusLabel(row.radius)}
                </>
              }
              // Nothing is behind a read-only row, so it claims nothing.
              chevron={!readOnly}
            />
          </GridListItem>
        );
      }}
    </GridList>
  );
}
