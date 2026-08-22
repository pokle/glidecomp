/**
 * The route editor's turnpoint list — the editable sibling of
 * comp/TurnpointsTable.tsx.
 *
 * A deliberate FORK rather than a shared component with an `editable` prop.
 * The read-only listing is server-rendered on the public task page, carries the
 * day's leg wind, and is a RAC `Table`; this one is a RAC `GridList` whose rows
 * open a sheet and, in Reorder mode, hold buttons — which an `<a>` row cannot
 * legally contain. They present the same facts in the same order (role and Exit
 * badge, the turnpoint with its radius and elevation under it, the optimised leg
 * into it, closed by the optimised total) and diverge only where editing needs
 * them to.
 *
 * Rows come from the editor's `rows`, NOT from the XCTask derived off them:
 * `buildRoute` drops a row whose coordinates don't parse, so a list built from
 * the derived task would hide the very turnpoint you need to tap to fix. The
 * derived task is passed alongside, purely for the geometry (roles, crossing
 * directions and leg distances), matched back to rows by id.
 *
 * Reordering is a MODE, not per-row chrome: at rest a row is a name, a summary
 * and a chevron, and only while reordering does it carry Move up / Move down.
 * No drag-and-drop — the row drag is native HTML5 drag, which never starts on
 * touch without a long-press (RAC gotcha #4), and this route gets set on a
 * phone, on a hill.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  computeTurnpointDirections,
  getOptimizedSegmentDistances,
  type XCTask,
} from "@glidecomp/engine";
import { ChevronRightIcon, ChevronUpIcon, ChevronDownIcon } from "lucide-react";
import { Badge } from "@/react/rac/badge";
import { Button } from "@/react/rac/button";
import { GridList, GridListItem } from "@/react/rac/grid-list";
import { rowProblem, type RouteRow } from "./route-editor";
import {
  formatAltitude,
  formatCylinderRadius,
  formatDistance,
  useUnits,
} from "../lib/units";

export function TurnpointList({
  rows,
  task,
  rowIds,
  reordering,
  moved,
  onOpen,
  onMove,
}: {
  rows: RouteRow[];
  /** The route as parsed so far — geometry only; null while it has none. */
  task: XCTask | null;
  /** Row ids parallel to `task.turnpoints` (BuildRouteResult.rowIds). */
  rowIds: number[];
  /** Reorder mode: rows carry Move up / Move down instead of opening. */
  reordering: boolean;
  /**
   * The move that just happened, so focus can follow the turnpoint rather than
   * the position it left. `nonce` is what makes a second press of the same
   * button count as a second move.
   */
  moved: { rowId: number; delta: -1 | 1; nonce: number } | null;
  onOpen: (rowId: number) => void;
  /** Move a turnpoint one place towards the start (-1) or the end (+1). */
  onMove: (rowId: number, delta: -1 | 1) => void;
}) {
  const units = useUnits();
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Keep the moved turnpoint under the reader.
   *
   * The rows swap, so without this the focused button belongs to whichever
   * turnpoint slid into that position — and a keyboard user pressing Move up
   * twice would move two different things. When the turnpoint lands at an end
   * its own button goes disabled, so focus falls to the one still live.
   */
  useEffect(() => {
    if (!moved) return;
    const find = (delta: number) =>
      listRef.current?.querySelector<HTMLButtonElement>(
        `[data-move-row="${moved.rowId}"][data-move-dir="${delta}"]`
      ) ?? null;
    const preferred = find(moved.delta);
    const target = preferred && !preferred.disabled ? preferred : find(-moved.delta);
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, [moved]);

  // Geometry, by row id. Everything here is derived from the whole route, so
  // it must be recomputed — and the collection re-rendered (gotcha #3) —
  // whenever any row moves or changes.
  const geometry = useMemo(() => {
    const byRow = new Map<
      number,
      { role: string | null; isExit: boolean; legM: number | undefined }
    >();
    if (!task) return { byRow, totalM: null as number | null };

    const directions = computeTurnpointDirections(task);
    let legs: number[] = [];
    try {
      if (task.turnpoints.length >= 2) legs = getOptimizedSegmentDistances(task);
    } catch {
      legs = [];
    }
    const lastIndex = task.turnpoints.length - 1;

    task.turnpoints.forEach((tp, i) => {
      const id = rowIds[i];
      if (id === undefined) return;
      byRow.set(id, {
        // The last turnpoint is the goal in GAP scoring even when the xctsk
        // leaves its type unset, so label it rather than leave it blank.
        role: tp.type ?? (i === lastIndex ? "GOAL" : null),
        isExit: tp.type !== "TAKEOFF" && directions[i] === "exit",
        legM: i >= 1 ? legs[i - 1] : undefined,
      });
    });

    const totalM = legs.length > 0 ? legs.reduce((sum, d) => sum + d, 0) : null;
    return { byRow, totalM };
  }, [task, rowIds]);

  const lastRow = rows.length - 1;

  return (
    <div ref={listRef}>
      <GridList
        variant="rows"
        aria-label={reordering ? "Turnpoints, reordering" : "Turnpoints"}
        selectionMode="none"
        items={rows}
        // Roles, legs and positions are all computed from OUTSIDE the item, so
        // RAC's per-item render cache has to be told when they move.
        dependencies={[geometry, reordering, lastRow]}
      >
        {(row: RouteRow) => {
          const at = rows.indexOf(row);
          const geo = geometry.byRow.get(row.id);
          const problem = rowProblem(row);
          const name = String(row.name).trim() || "Unnamed turnpoint";
          // Metric whatever the reader's distance unit — the FAI states
          // cylinder radii in metres, and so does the editor that sets them.
          const r = formatCylinderRadius(Number(row.radius) || 0);
          const altM = Number(row.altitude);
          const alt =
            Number.isFinite(altM) && altM !== 0
              ? formatAltitude(altM, { prefs: units }).withUnit
              : null;

          return (
            <GridListItem
              variant="rows"
              id={row.id}
              textValue={name}
              // In Reorder mode the row itself does nothing: its buttons are
              // the whole interaction, and a row that both moves things and
              // opens things would be a coin toss on a phone.
              onAction={reordering ? undefined : () => onOpen(row.id)}
              className={reordering ? "cursor-default" : "cursor-pointer"}
            >
              {/* The role column, or the position while reordering — the same
                  16 units of width either way, so rows don't jump when the
                  mode turns on. */}
              <div className="flex w-14 shrink-0 flex-col gap-1">
                {reordering ? (
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">
                    {at + 1}.
                  </span>
                ) : (
                  <>
                    {geo?.role ? (
                      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                        {geo.role}
                      </span>
                    ) : null}
                    {geo?.isExit ? (
                      <span title="Crossed flying outward — the route reaches this cylinder from inside, so pilots fly out across it">
                        <Badge variant="outline">Exit</Badge>
                      </span>
                    ) : null}
                  </>
                )}
              </div>

              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate font-medium">{name}</span>
                {problem ? (
                  <span className="text-xs text-destructive">{problem}</span>
                ) : (
                  // Cylinder radius (always) · the waypoint's ground elevation
                  // (only when the route carries one — a file without an
                  // altitude reads 0, which is a sea-level claim it never
                  // made). Both labelled, abbreviated for sighted readers and
                  // in full for assistive tech, which would otherwise read
                  // "r." and "amsl" as words.
                  <span className="truncate text-xs text-muted-foreground tabular-nums">
                    <span className="sr-only">radius </span>
                    <span aria-hidden="true">r. </span>
                    {r.formatted} {r.unit}
                    {alt ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span className="sr-only">, elevation </span>
                        {alt}
                        <span className="sr-only"> above sea level</span>
                        <span aria-hidden="true"> amsl</span>
                      </>
                    ) : null}
                  </span>
                )}
              </div>

              {/* The leg stands down while reordering: it is about to change,
                  and its width is what the two buttons need on a phone. */}
              {reordering ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Move ${name} up`}
                    data-move-row={row.id}
                    data-move-dir={-1}
                    isDisabled={at === 0}
                    onPress={() => onMove(row.id, -1)}
                  >
                    <ChevronUpIcon aria-hidden />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={`Move ${name} down`}
                    data-move-row={row.id}
                    data-move-dir={1}
                    isDisabled={at === lastRow}
                    onPress={() => onMove(row.id, 1)}
                  >
                    <ChevronDownIcon aria-hidden />
                  </Button>
                </div>
              ) : (
                <>
                  <span className="shrink-0 text-sm tabular-nums">
                    {geo?.legM !== undefined ? (
                      formatDistance(geo.legM, { decimals: 1, prefs: units }).withUnit
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                  <ChevronRightIcon
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </>
              )}
            </GridListItem>
          );
        }}
      </GridList>

      {geometry.totalM !== null ? (
        <div className="flex items-center justify-between px-4 py-2 text-sm">
          <span className="text-muted-foreground">Optimized total</span>
          <span className="font-medium tabular-nums">
            {formatDistance(geometry.totalM, { decimals: 1, prefs: units }).withUnit}
          </span>
        </div>
      ) : null}
    </div>
  );
}
