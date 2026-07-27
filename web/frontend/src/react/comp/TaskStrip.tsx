/**
 * The task straightened into a line: turnpoints as stations in order, each leg
 * carrying its distance and true bearing, each turnpoint its course change.
 *
 * The tube-map idea, with the one change that makes it honest for flying: a
 * tube map throws geography away because a rider doesn't care which way is
 * north, but a pilot cares enormously — so the route is straightened while
 * heading survives as an explicit number and arrow. What the strip buys over
 * the map-like TaskDiagram is that it is ONE-DIMENSIONAL: it stays readable at
 * twelve turnpoints, where the diagram is cramped, and it answers "what's
 * next, which way, how far, how sharp a turn" in reading order.
 *
 * Marked up as a real ordered list, not a picture. Bearings and turn angles
 * appear nowhere else on the page, so they cannot live in a `role="img"` whose
 * text alternative a sighted-keyboard or magnifier user never hears. The
 * visually-hidden connectives make the DOM read as a sentence:
 * "1. ELLIOT (TAKEOFF) … then 5.0 km on 042° NE to 2. ELLIOT (SSS, exit),
 * turning 106° right."
 *
 * SSR-safe: geometry from the pure layout module, no window, no measurement.
 */
import type { XCTask } from "@glidecomp/engine";
import { cn } from "@/react/lib/utils";
import { formatDistance, useUnits } from "../lib/units";
import {
  buildTaskStrip,
  type TaskStripLeg,
  type TaskStripStation,
} from "./task-strip-layout";

export function TaskStrip({ xctsk }: { xctsk: XCTask }) {
  const units = useUnits();
  const strip = buildTaskStrip(xctsk);
  if (!strip) return null;

  return (
    <div className="mt-3">
      {/* The strip is wider than a phone on any real task, so it scrolls in
          its own container — never the page body (accessibility §3.2). */}
      <ol
        className="flex items-stretch gap-0 overflow-x-auto pb-2 text-sm"
        aria-label="Turnpoints in order, with the leg into each"
      >
        {strip.stations.map((station, i) => (
          // `relative` is load-bearing. The visually-hidden connectives below
          // are `sr-only`, which is `position: absolute` — and `overflow` does
          // NOT establish a containing block for absolute descendants. Without
          // a positioned ancestor they are laid out against the document at
          // their static position, deep inside this horizontally-scrolled
          // strip, so they escape the scroll container and give the whole PAGE
          // a horizontal scrollbar (§3.2). Measured: 1533px of body scroll on
          // a 390px viewport.
          <li key={i} className="relative flex shrink-0 items-stretch">
            {i > 0 ? <Leg leg={strip.legs[i - 1]} units={units} /> : null}
            <Station station={station} position={i + 1} />
          </li>
        ))}
      </ol>
      <p className="mt-1 text-xs text-muted-foreground">
        The task straightened out — order, heading and turns. Distances are the
        optimised route; bearings are true.{" "}
        <span className="whitespace-nowrap">
          Total {formatDistance(strip.totalMeters, { decimals: 1, prefs: units }).withUnit}
        </span>
        .
      </p>
    </div>
  );
}

/** One station: the marker, the name, its role, and the turn made here. */
function Station({
  station,
  position,
}: {
  station: TaskStripStation;
  position: number;
}) {
  const isExit = station.role !== "TAKEOFF" && station.direction === "exit";

  return (
    <div className="flex w-[7.5rem] flex-col items-center px-1 text-center">
      {/* The marker line. The dot sits on the same baseline as the legs' rules
          so the strip reads as one continuous track. */}
      <div className="flex h-4 w-full items-center">
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
        <span
          className={cn(
            "mx-0.5 size-2.5 rounded-full border-2 border-foreground",
            // Filled = a turnpoint you enter; hollow = one you leave (the
            // start, and any exit cylinder). Shape, never colour.
            isExit ? "bg-background" : "bg-foreground"
          )}
          aria-hidden="true"
        />
        <span className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>

      <span className="sr-only">{position}. </span>
      <span className="mt-1 leading-tight font-medium">{station.name}</span>
      {station.role ? (
        <span className="text-[11px] tracking-wide text-muted-foreground">
          {station.role}
          {isExit ? " · exit" : ""}
        </span>
      ) : isExit ? (
        <span className="text-[11px] text-muted-foreground">exit</span>
      ) : null}

      {/* The winding: how far the course bends here. */}
      {station.turnDeg !== null && station.turnSide ? (
        <span className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
          <span aria-hidden="true">{station.turnSide === "left" ? "↰" : "↱"}</span>{" "}
          {station.isReversal ? (
            <>turns back {Math.round(station.turnDeg)}°</>
          ) : (
            <>
              {Math.round(station.turnDeg)}°{" "}
              {station.turnSide === "left" ? "left" : "right"}
            </>
          )}
        </span>
      ) : station.turnDeg !== null ? (
        <span className="mt-0.5 text-[11px] text-muted-foreground">straight on</span>
      ) : null}
    </div>
  );
}

/** One leg: a rule with a bearing arrow, its distance and heading beneath. */
function Leg({
  leg,
  units,
}: {
  leg: TaskStripLeg;
  units: ReturnType<typeof useUnits>;
}) {
  const heading = `${Math.round(leg.bearingDeg).toString().padStart(3, "0")}°`;
  return (
    <div className="flex w-[5.5rem] flex-col items-center px-1 text-center">
      <div className="flex h-4 w-full items-center gap-0.5">
        <span className="h-px flex-1 bg-foreground/40" aria-hidden="true" />
        {/* The arrow points where the leg actually points — the one piece of
            geography the strip keeps. 0° is up (north). */}
        <svg
          viewBox="0 0 12 12"
          width={12}
          height={12}
          className="shrink-0 text-foreground"
          aria-hidden="true"
        >
          <g
            transform={`rotate(${Math.round(leg.bearingDeg)} 6 6)`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 10.5 L6 1.5 M3 4.5 L6 1.5 L9 4.5" />
          </g>
        </svg>
        <span className="h-px flex-1 bg-foreground/40" aria-hidden="true" />
      </div>
      <span className="sr-only">then fly </span>
      <span className="mt-1 leading-tight tabular-nums">
        {formatDistance(leg.meters, { decimals: 1, prefs: units }).withUnit}
      </span>
      <span className="sr-only"> on a bearing of </span>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {heading} {leg.compass}
      </span>
      <span className="sr-only"> to </span>
    </div>
  );
}
