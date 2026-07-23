/**
 * The turnpoint listing — XCTrack's compact "FLY tab" shape: a role column
 * (TAKEOFF / SSS / ESS / GOAL plus the Exit badge), the turnpoint with its
 * radius and altitude underneath, and the optimized leg into it on the right,
 * closed by the optimized total.
 *
 * Shared by the task detail page (read-only, server-rendered) and the route
 * editor, which renders it over the route being edited so the editor shows
 * exactly what the task page will. Read-only by design: it's a listing, not a
 * grid — editing happens in the editor's Enter task field and dialogs.
 *
 * SSR-safe: no browser-only imports, no window/document, and every number is
 * formatted deterministically from the unit preferences.
 */
import { useMemo } from "react";
import {
  computeTurnpointDirections,
  getOptimizedSegmentDistances,
  type XCTask,
} from "@glidecomp/engine";
import { Badge } from "@/react/rac/badge";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { formatAltitude, formatDistance, formatRadius, useUnits } from "../lib/units";

export function TurnpointsTable({ xctsk }: { xctsk: XCTask }) {
  const units = useUnits();
  const { directions, legs, totalM } = useMemo(() => {
    const directions = computeTurnpointDirections(xctsk);
    // legs[i] is the optimized segment INTO turnpoint i+1; turnpoint 0
    // (take-off) has no incoming leg. Guard the geometry so a half-defined
    // route (missing coordinates) still renders the identities.
    let legs: number[] = [];
    try {
      if (xctsk.turnpoints.length >= 2) legs = getOptimizedSegmentDistances(xctsk);
    } catch {
      legs = [];
    }
    const totalM = legs.length > 0 ? legs.reduce((sum, d) => sum + d, 0) : null;
    return { directions, legs, totalM };
  }, [xctsk]);

  const lastIndex = xctsk.turnpoints.length - 1;

  return (
    <div className="mt-2">
      <Table aria-label="Turnpoints">
        <TableHeader>
          {/* Empty visible header for the role column; labelled for AT. */}
          <Column isRowHeader={false} aria-label="Type" className="w-16" />
          <Column isRowHeader>Turnpoint</Column>
          <Column className="text-right">Leg</Column>
        </TableHeader>
        <TableBody>
          {xctsk.turnpoints.map((tp, i) => {
            // The last turnpoint is the goal in GAP scoring even when the
            // xctsk leaves its type unset, so label it rather than blank.
            const role = tp.type ?? (i === lastIndex ? "GOAL" : null);
            const isExit = tp.type !== "TAKEOFF" && directions[i] === "exit";
            const legM = i >= 1 ? legs[i - 1] : undefined;
            const radius = formatRadius(tp.radius, { prefs: units }).withUnit;
            const alt = tp.waypoint.altSmoothed
              ? formatAltitude(tp.waypoint.altSmoothed, { prefs: units }).withUnit
              : null;
            return (
              <Row key={i}>
                <Cell className="align-top">
                  <div className="flex flex-col gap-1">
                    {role ? (
                      <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
                        {role}
                      </span>
                    ) : null}
                    {isExit ? (
                      <span title="Crossed flying outward — the route reaches this cylinder from inside, so pilots fly out across it">
                        <Badge variant="outline">Exit</Badge>
                      </span>
                    ) : null}
                  </div>
                </Cell>
                <Cell className="align-top">
                  <div className="flex flex-col leading-tight">
                    <span className="font-medium">{tp.waypoint.name}</span>
                    {/* Radius (always) · altitude (when the xctsk carries one —
                        files without an altitude come through as 0, shown as
                        nothing rather than a misleading sea-level reading). */}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {radius}
                      {alt ? ` · ${alt}` : ""}
                    </span>
                  </div>
                </Cell>
                <Cell className="text-right align-top tabular-nums">
                  {legM !== undefined ? (
                    formatDistance(legM, { decimals: 1, prefs: units }).withUnit
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </Cell>
              </Row>
            );
          })}
        </TableBody>
      </Table>
      {totalM !== null ? (
        <div className="flex items-center justify-between border-t px-2 py-2 text-sm">
          <span className="text-muted-foreground">Optimized total</span>
          <span className="font-medium tabular-nums">
            {formatDistance(totalM, { decimals: 1, prefs: units }).withUnit}
          </span>
        </div>
      ) : null}
    </div>
  );
}
