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
 */
import { ChevronRightIcon, MapPinIcon } from "lucide-react";
import { Button } from "@/react/rac/button";
import { GridList, GridListItem } from "@/react/rac/grid-list";
import { radiusLabel } from "@/react/lib/units";
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
  onOpen: (id: number) => void;
  onLocate: (row: WaypointListRow) => void;
}) {
  return (
    <GridList
      // Not "Waypoints": the read-only table an anonymous visitor gets is
      // already named that, and these two are different things — one is the
      // published set, the other is the editor.
      aria-label="Edit waypoints"
      variant="rows"
      items={rows}
      onAction={(key) => onOpen(Number(key))}
      renderEmptyState={() => (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {emptyMessage ??
            "No waypoints yet. Upload a file or add points from the map to get started."}
        </p>
      )}
    >
      {(row) => {
        const valid = parseCoords(row.coords) !== null;
        return (
          <GridListItem
            variant="rows"
            id={row.id}
            textValue={row.code || "waypoint"}
            className="flex items-center gap-3"
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Show ${row.code || "waypoint"} on the map`}
              isDisabled={!valid}
              onPress={() => onLocate(row)}
            >
              <MapPinIcon className="size-4" aria-hidden="true" />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {row.code || "—"}
                {row.name ? (
                  <span className="ml-2 font-normal text-muted-foreground">
                    {row.name}
                  </span>
                ) : null}
              </p>
              {/* Everything else on one mono line: the altitude is HERE, not
                  behind a frozen column. A blank altitude reads as unknown and
                  a zero reads as zero — they are different facts. */}
              <p
                className={cn(
                  "truncate font-mono text-xs",
                  valid ? "text-muted-foreground" : "text-destructive"
                )}
              >
                {valid ? row.coords : `${row.coords || "no coordinates"} — invalid`}
                {" · "}
                {row.altitude.trim() === "" ? "no altitude" : `${row.altitude} m`}
                {" · "}
                {radiusLabel(row.radius)}
              </p>
            </div>
            {/* There IS more behind this row, and the list should say so —
                the same chevron the altitude review's rows carry. */}
            <ChevronRightIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </GridListItem>
        );
      }}
    </GridList>
  );
}
