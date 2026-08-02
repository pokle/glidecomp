/**
 * The turnpoint listing — XCTrack's compact "FLY tab" shape: a role column
 * (TAKEOFF / SSS / ESS / GOAL plus the Exit badge), the turnpoint with its
 * radius and altitude underneath, and the optimized leg into it on the right,
 * closed by the optimized total.
 *
 * Given the day's wind it also resolves that wind against each leg — the one
 * thing a pilot wants from the weather before launch is which legs are the
 * slog, and that is a head/cross/tail component per leg, not a single arrow
 * over the whole task. This is the part of the retired task strip worth
 * keeping, moved to where the legs already are.
 *
 * Shared by the task detail page (read-only, server-rendered) and the route
 * editor, which renders it over the route being edited so the editor shows
 * exactly what the task page will. Read-only by design: it's a listing, not a
 * grid — editing happens in the editor's Enter task field and dialogs.
 *
 * SSR-safe: no browser-only imports, no window/document, and every number is
 * formatted deterministically from the unit preferences.
 */
import { useMemo, type FocusEvent } from "react";
import {
  computeTurnpointDirections,
  getOptimizedSegmentDistances,
  type XCTask,
} from "@glidecomp/engine";
import { Badge } from "@/react/rac/badge";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { cn } from "@/react/lib/utils";
import {
  formatAltitude,
  formatDistance,
  formatRadius,
  useUnits,
  type UnitPreferences,
} from "../lib/units";
import { unitDisplay } from "../field-analysis/units";
import { buildTaskStrip } from "./task-strip-layout";
import { legWind, legWindWord, type TaskWind } from "./task-wind";

export function TurnpointsTable({
  xctsk,
  wind = null,
  highlightIndex = null,
  onTurnpointHover,
  onTurnpointSelect,
}: {
  xctsk: XCTask;
  /**
   * The day's wind, when the page has it. Optional and arriving late: the
   * weather is a separate client fetch, so the listing is complete without it
   * and the Leg wind column appears when it lands (rather than sitting there
   * empty, promising a figure the page may never get).
   */
  wind?: TaskWind | null;
  /**
   * Turnpoint to mark as the one under the reader's attention — the task
   * diagram beside the table sets this when a turnpoint is hovered, tapped or
   * tabbed to, so the picture and the numbers point at the same thing.
   */
  highlightIndex?: number | null;
  /**
   * The same tie in the other direction: fires with the row under the pointer
   * or keyboard focus, and with null when the reader leaves, so the host can
   * raise the matching turnpoint in the diagram. Optional — the route editor
   * renders this listing with no diagram to point at.
   */
  onTurnpointHover?: (index: number | null) => void;
  /**
   * Fires on click/tap/Enter on a row. Touch has no hover, so without this a
   * phone reader could never point the diagram at a turnpoint from the table.
   */
  onTurnpointSelect?: (index: number) => void;
}) {
  const units = useUnits();
  const { directions, legs, totalM, bearings } = useMemo(() => {
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
    // Leg bearings, off the same optimised line the distances come from, so a
    // leg's wind can never be resolved against a course the table doesn't
    // show. buildTaskStrip returns null on a half-defined route — the same
    // case the distances above already tolerate — and the wind goes quiet.
    const strip = buildTaskStrip(xctsk);
    const bearings = strip ? strip.legs.map((leg) => leg.bearingDeg) : [];
    return { directions, legs, totalM, bearings };
  }, [xctsk]);

  const lastIndex = xctsk.turnpoints.length - 1;
  const showWind = wind !== null && bearings.length > 0;

  // Keyboard half of the tie-in. The grid moves focus a CELL at a time and
  // RAC's Row takes no focus handlers, so the listing listens once at the top
  // and reads the row out of the event's target: arrowing down the table walks
  // the diagram's highlight with it. Clearing only when focus leaves the whole
  // listing keeps the highlight steady while the reader moves across a row.
  const focusHandlers = onTurnpointHover
    ? {
        onFocus: (e: FocusEvent<HTMLDivElement>) => {
          const row = (e.target as HTMLElement).closest("tr");
          const body = row?.parentElement;
          if (!row || body?.tagName !== "TBODY") return;
          const index = Array.prototype.indexOf.call(body.children, row);
          if (index >= 0) onTurnpointHover(index);
        },
        onBlur: (e: FocusEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget)) onTurnpointHover(null);
        },
      }
    : {};

  return (
    <div className="mt-2" {...focusHandlers}>
      {/* With the wind column the listing is wider than a phone, so it scrolls
          in its own viewport — which a keyboard user can only reach if that
          viewport is a labelled tab stop (WCAG 2.1.1). Three columns fit, so
          the stop is only claimed when there are four. */}
      <Table
        aria-label="Turnpoints"
        scrollLabel={showWind ? "Turnpoints" : undefined}
      >
        <TableHeader>
          {/* Empty visible header for the role column; labelled for AT. */}
          <Column isRowHeader={false} aria-label="Type" className="w-16" />
          <Column isRowHeader>Turnpoint</Column>
          <Column className="text-right">Leg Distance</Column>
          {showWind ? <Column className="text-right">Leg Wind</Column> : null}
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
              <Row
                key={i}
                className={i === highlightIndex ? "bg-muted" : undefined}
                onHoverChange={
                  onTurnpointHover
                    ? (hovered) => onTurnpointHover(hovered ? i : null)
                    : undefined
                }
                onAction={onTurnpointSelect ? () => onTurnpointSelect(i) : undefined}
              >
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
                {showWind ? (
                  <Cell className="text-right align-top tabular-nums">
                    {wind && bearings[i - 1] !== undefined ? (
                      <LegWindReading
                        wind={wind}
                        bearingDeg={bearings[i - 1]}
                        units={units}
                      />
                    ) : (
                      // Take-off has no leg into it, and neither has a route
                      // the geometry could not be read off.
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Cell>
                ) : null}
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
      {/* What the wind column IS. One vector for the whole task, said out
          loud: an unflown task has no per-leg timing to hang hourly wind on,
          so a reader must not take these for a forecast leg by leg. */}
      {showWind && wind ? (
        <p className="mt-1 px-2 text-xs text-muted-foreground">
          Leg wind is the modelled mean over the task window
          {wind.heightM !== null ? ` at about ${wind.heightM} m` : " at the surface"},
          from {Math.round(wind.fromDeg)}°, resolved against each leg's true
          bearing — one figure for the whole task.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One leg's wind: the dominant component, the arrow for it, and the word.
 *
 * The magnitude is the DOMINANT component, so a headwind leg reports how much
 * wind is in its face rather than the raw wind speed, which would overstate
 * every leg but a straight upwind one. Head and tail are emphasised because
 * those are the legs that change a plan; a crosswind is a fact to know, not a
 * slog.
 */
function LegWindReading({
  wind,
  bearingDeg,
  units,
}: {
  wind: TaskWind;
  bearingDeg: number;
  units: UnitPreferences;
}) {
  const resolved = legWind(wind, bearingDeg);
  // The module works in km/h and converts at the display boundary, as the
  // weather charts do.
  const speed = unitDisplay("km/h", units);
  const magnitude = Math.round(
    (resolved.kind === "cross" ? resolved.crossKmh : Math.abs(resolved.alongKmh)) *
      speed.factor
  );

  return (
    <span
      className={cn(
        "whitespace-nowrap",
        resolved.kind === "cross" ? "text-muted-foreground" : "font-medium"
      )}
    >
      <span aria-hidden="true">
        {resolved.kind === "head" ? "▲" : resolved.kind === "tail" ? "▼" : "↔"}
      </span>{" "}
      {magnitude} {speed.unit}{" "}
      <span className="sr-only">{legWindWord(resolved.kind)}</span>
      <span aria-hidden="true">
        {resolved.kind === "head" ? "head" : resolved.kind === "tail" ? "tail" : "cross"}
      </span>
    </span>
  );
}
