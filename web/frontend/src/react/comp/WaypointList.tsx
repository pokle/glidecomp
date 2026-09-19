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
 * a NavList — a row here holds a button (see rac/grid-list.tsx).
 *
 * ## Read-only is the same list, not a table
 *
 * Omit `onOpen` and this is the view an anonymous visitor gets: no chevron,
 * nothing to open, the locate pin kept (they get the map too). That view used
 * to be a six-column RAC `Table` inside an `overflow-x-auto` scroll region —
 * so the sideways-scrolling table this list replaced for admins survived for
 * the PILOT, who is the one actually standing on a hill holding a phone, while
 * the organiser more likely to be at a desk got the list. One shape at every
 * width, for everyone, is the whole point of the rule.
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
   * Open one waypoint's sheet. Leave it out for the read-only view: there is
   * nothing behind a row then, so there is no chevron and no row action
   * either — the absence of this IS the read-only mode.
   */
  onOpen?: (id: number) => void;
  onLocate: (row: WaypointListRow) => void;
}) {
  const units = useUnits();
  const readOnly = onOpen === undefined;
  return (
    <GridList
      // The editor and the published set are different things and are named
      // apart, so a reader (and a test) can tell which one they have.
      aria-label={readOnly ? "Waypoints" : "Edit waypoints"}
      variant="rows"
      items={rows}
      onAction={onOpen ? (key) => onOpen(Number(key)) : undefined}
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
          <GridListItem variant="rows" id={row.id} textValue={row.code || "waypoint"}>
            <RowContent
              leading={
                <Button
                  variant="ghost"
                  size="icon-sm"
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
