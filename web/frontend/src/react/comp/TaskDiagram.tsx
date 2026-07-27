/**
 * A compact, monochrome diagram of a competition task: the optimised route
 * drawn with direction arrows, the turnpoints marked and named.
 *
 * It is a *diagram*, not a map — no tiles, no north arrow, no scale bar, no
 * map library. That is the point: the shape of the task, at any size from a
 * 56px glyph in a task list to a 560px figure on a report page, in markup a
 * crawler and a printer both handle. The three surfaces that already carry a
 * real map (the route editor, the analysis map, the 3D replay) deliberately
 * do not use this.
 *
 * Black and white by construction: everything is `currentColor` at varying
 * opacity and stroke weight, so it inherits the page's foreground in both
 * themes and prints correctly. Nothing here encodes meaning in colour.
 *
 * Interaction (optional): hovering, tapping or tabbing to a turnpoint raises
 * it in the diagram and fires `onTurnpointHover` / `onTurnpointSelect`, so a
 * host page can tie the diagram to whatever else is on screen (the task page
 * highlights the matching row of its turnpoint listing). Without a handler
 * the diagram is inert and marked up as a single image.
 *
 * SSR-safe: geometry comes from the pure layout module, nothing touches
 * `window`, and coordinates are rounded so the server and client emit the
 * same path strings.
 */
import { useMemo, useRef, useState } from "react";
import type { XCTask } from "@glidecomp/engine";
import { cn } from "@/react/lib/utils";
import {
  buildTaskDiagram,
  describeTaskRoute,
  gateTickPlacement,
  type TaskDiagramTurnpoint,
} from "./task-diagram-layout";

/**
 * Size presets. Each is a whole design, not just a scale factor: the small
 * ones drop labels because a name at 5px is a smudge, not information.
 */
export type TaskDiagramSize = "xs" | "sm" | "md" | "lg";

interface SizePreset {
  width: number;
  height: number;
  padding: number;
  /** 0 = no labels. */
  labelFontSize: number;
  labelMaxChars: number;
  dotRadius: number;
  routeWidth: number;
  arrowSize: number;
  arrowMinLength: number;
  cylinders: boolean;
}

const PRESETS: Record<TaskDiagramSize, SizePreset> = {
  // Task-list glyph: route shape and direction only, read at a glance. No
  // cylinders — at this size the rings crowd out the shape, which is the one
  // thing the glyph exists to convey.
  xs: {
    width: 72,
    height: 50,
    padding: 7,
    labelFontSize: 0,
    labelMaxChars: 0,
    dotRadius: 1.5,
    routeWidth: 1.1,
    arrowSize: 2.6,
    arrowMinLength: 10,
    cylinders: false,
  },
  sm: {
    width: 132,
    height: 96,
    padding: 10,
    labelFontSize: 0,
    labelMaxChars: 0,
    dotRadius: 2,
    routeWidth: 1.4,
    arrowSize: 3.6,
    arrowMinLength: 14,
    cylinders: true,
  },
  md: {
    width: 340,
    height: 240,
    padding: 26,
    labelFontSize: 10,
    labelMaxChars: 12,
    dotRadius: 2.8,
    routeWidth: 1.6,
    arrowSize: 4.6,
    arrowMinLength: 22,
    cylinders: true,
  },
  lg: {
    width: 540,
    height: 380,
    padding: 34,
    labelFontSize: 12,
    labelMaxChars: 18,
    dotRadius: 3.4,
    routeWidth: 1.8,
    arrowSize: 5.4,
    arrowMinLength: 28,
    cylinders: true,
  },
};

export interface TaskDiagramProps {
  task: XCTask;
  size?: TaskDiagramSize;
  /**
   * Accessible name. Defaults to the route read out in order; pass `null` for
   * a decorative diagram (one sitting beside a link that already names the
   * task, where the description would just double the link's text).
   */
  label?: string | null;
  /** Override the preset's label decision (e.g. names on a `sm` diagram). */
  showLabels?: boolean;
  className?: string;
  /** Fires on hover/focus with the turnpoint, and with null when it leaves. */
  onTurnpointHover?: (turnpoint: TaskDiagramTurnpoint | null) => void;
  /** Fires on click/tap/Enter. Providing it makes turnpoints keyboard-reachable. */
  onTurnpointSelect?: (turnpoint: TaskDiagramTurnpoint) => void;
  /** Turnpoint index to draw raised, for highlighting driven from outside. */
  highlightIndex?: number | null;
}

export function TaskDiagram({
  task,
  size = "md",
  label,
  showLabels,
  className,
  onTurnpointHover,
  onTurnpointSelect,
  highlightIndex = null,
}: TaskDiagramProps) {
  const preset = PRESETS[size];
  const [hovered, setHovered] = useState<number | null>(null);
  // Roving tabindex: which turnpoint currently owns the group's single tab
  // stop. Follows focus, so arrowing along the route leaves the tab stop where
  // the reader left off.
  const [tabStop, setTabStop] = useState(0);
  const hitsRef = useRef<SVGGElement>(null);

  const moveFocus = (from: number, delta: number, count: number) => {
    const next = (from + delta + count) % count;
    hitsRef.current
      ?.querySelectorAll<SVGGElement>("[data-turnpoint]")
      ?.[next]?.focus();
  };

  const withLabels = showLabels ?? preset.labelFontSize > 0;
  // A preset with no label size still needs one when labels are forced on.
  const labelFontSize = withLabels
    ? preset.labelFontSize || Math.max(8, Math.round(preset.height / 11))
    : 0;

  const layout = useMemo(
    () =>
      buildTaskDiagram(task, {
        width: preset.width,
        height: preset.height,
        padding: preset.padding,
        labelFontSize,
        labelMaxChars: preset.labelMaxChars || 12,
        arrowMinLength: preset.arrowMinLength,
        dotRadius: preset.dotRadius,
        cylinders: preset.cylinders,
      }),
    [task, preset, labelFontSize]
  );

  if (!layout) return null;

  const active = hovered ?? highlightIndex;
  const decorative = label === null;
  // Never put a tab stop inside an aria-hidden subtree: a decorative diagram
  // stays pointer-only however the caller wired it up.
  const interactive = onTurnpointSelect != null && !decorative;
  const accessibleName = label ?? describeTaskRoute(task);
  // Clamp: a shorter route (an admin deleting a turnpoint) must not strand the
  // group's only tab stop past the end, which would make it unreachable.
  const tabStopIndex = Math.min(tabStop, layout.turnpoints.length - 1);

  const setActive = (turnpoint: TaskDiagramTurnpoint | null) => {
    setHovered(turnpoint?.index ?? null);
    onTurnpointHover?.(turnpoint);
  };

  const d = layout.path
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      className={cn("text-foreground", className)}
      // A decorative diagram is hidden outright; otherwise it is one image
      // with the route as its text alternative (individual turnpoints add
      // their own names below when they are interactive).
      {...(decorative
        ? { "aria-hidden": true, focusable: false }
        : { role: "img", "aria-label": accessibleName })}
    >
      {/* Cylinders are drawn at their true size and can run past the frame.
          Nothing clips them explicitly: an outermost <svg> already clips to
          its viewport, and a clipPath would need a document-unique id — which
          useId() cannot promise across React roots, and a collision silently
          erases the whole drawing. */}
      <g fill="none" stroke="currentColor">
        {/* Turnpoint cylinders — hairlines, well back from the route. */}
        {layout.turnpoints
          .filter((tp) => tp.showCylinder)
          .map((tp) => (
            <circle
              key={`cyl-${tp.index}`}
              cx={tp.center.x}
              cy={tp.center.y}
              r={tp.radius}
              strokeWidth={0.75}
              strokeOpacity={active === tp.index ? 0.55 : 0.22}
              strokeDasharray={tp.direction === "exit" ? "2 2" : undefined}
            />
          ))}

        {/* A LINE goal is a different shape from a cylinder and pilots need to
            see which they are flying at, so it is drawn as the line it is. */}
        {layout.goalLine ? (
          <line
            x1={layout.goalLine[0].x}
            y1={layout.goalLine[0].y}
            x2={layout.goalLine[1].x}
            y2={layout.goalLine[1].y}
            strokeWidth={preset.routeWidth}
            strokeOpacity={0.85}
          />
        ) : null}

        {/* The optimised route. */}
        {layout.path.length > 1 ? (
          <path
            d={d}
            strokeWidth={preset.routeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeOpacity={0.9}
          />
        ) : null}

        {/* Direction arrows, sitting on the legs. */}
        {layout.arrows.map((arrow, i) => (
          <path
            key={`arrow-${i}`}
            d={`M${-preset.arrowSize} ${-preset.arrowSize * 0.72} L0 0 L${-preset.arrowSize} ${preset.arrowSize * 0.72}`}
            transform={`translate(${arrow.x} ${arrow.y}) rotate(${(arrow.angle * 180) / Math.PI})`}
            strokeWidth={preset.routeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Turnpoint markers. Shape carries the role — never colour:
            start = hollow ring, ESS = a gate tick across the route,
            goal = filled dot inside a ring, everything else = filled dot. */}
        {layout.turnpoints.map((tp) => (
          <TurnpointMarker
            key={`tp-${tp.index}`}
            turnpoint={tp}
            preset={preset}
            raised={active === tp.index}
            incoming={tp.index > 0 ? layout.path[tp.index - 1] : null}
          />
        ))}
      </g>

      {/* Names. Painted over the geometry with a background-coloured halo so a
          label crossing a cylinder arc stays readable. */}
      {layout.labels.map((textLabel) => (
        <text
          key={`label-${textLabel.index}`}
          x={textLabel.x}
          y={textLabel.y}
          textAnchor={textLabel.anchor}
          fontSize={labelFontSize}
          className={cn(
            "select-none fill-current",
            active === textLabel.index ? "font-semibold" : "font-medium"
          )}
          style={{
            // Halo: paint the background colour underneath the glyphs so a
            // name crossing a cylinder arc or a leg stays readable.
            paintOrder: "stroke",
            stroke: "var(--background)",
            strokeWidth: labelFontSize * 0.3,
            strokeLinejoin: "round",
          }}
        >
          {textLabel.text}
        </text>
      ))}

      {/* Hit targets last so they sit on top of everything they select. Each is
          ≥ 24 units across (WCAG 2.5.8 — the radius is half of that).

          Keyboard: the turnpoints are a composite widget with a ROVING
          tabindex, not N tab stops. A twelve-turnpoint task would otherwise
          bury twelve stops in the middle of the page for a view whose every
          fact is also in the table below; one stop in, arrow keys between,
          one stop out is the ARIA pattern for exactly this. */}
      {interactive || onTurnpointHover ? (
        <g ref={hitsRef} role={interactive ? "group" : undefined} aria-label={interactive ? "Turnpoints" : undefined}>
          {layout.turnpoints.map((tp) => (
            <TurnpointHitArea
              key={`hit-${tp.index}`}
              turnpoint={tp}
              radius={Math.max(12, preset.dotRadius * 4)}
              interactive={interactive}
              isTabStop={tp.index === tabStopIndex}
              onEnter={() => setActive(tp)}
              onLeave={() => setActive(null)}
              onFocused={() => {
                setTabStop(tp.index);
                setActive(tp);
              }}
              onMove={(delta) => moveFocus(tp.index, delta, layout.turnpoints.length)}
              onSelect={onTurnpointSelect ? () => onTurnpointSelect(tp) : undefined}
            />
          ))}
        </g>
      ) : null}
    </svg>
  );
}

/** Role glyph for one turnpoint — see the marker comment in TaskDiagram. */
function TurnpointMarker({
  turnpoint,
  preset,
  raised,
  incoming,
}: {
  turnpoint: TaskDiagramTurnpoint;
  preset: SizePreset;
  raised: boolean;
  /** Previous route point, used to angle the ESS gate tick across the leg. */
  incoming: { x: number; y: number } | null;
}) {
  const { tag } = turnpoint;
  const r = round2(preset.dotRadius * (raised ? 1.45 : 1));
  const ringR = round2(r * 2.3);

  return (
    <g>
      {raised ? (
        // Focus/hover halo: a wider soft ring, so the raised turnpoint is
        // obvious without changing hue.
        <circle
          cx={tag.x}
          cy={tag.y}
          r={round2(ringR * 1.7)}
          fill="currentColor"
          fillOpacity={0.12}
          stroke="none"
        />
      ) : null}

      {turnpoint.isStart ? (
        // Start: hollow — you begin here, the route leaves from it.
        <circle
          cx={tag.x}
          cy={tag.y}
          r={ringR}
          fill="var(--background)"
          strokeWidth={preset.routeWidth * 1.1}
        />
      ) : (
        <circle cx={tag.x} cy={tag.y} r={r} fill="currentColor" stroke="none" />
      )}

      {turnpoint.isEss && incoming ? (
        // End of speed section: a timing gate across the incoming leg, set
        // BACK from the marker rather than drawn through it. An ESS is very
        // often the last turnpoint too (this task's NCORGL is), and a tick
        // through the goal's ring reads as a strike-through — a "prohibited"
        // symbol on the one place the pilot is trying to reach.
        <GateTick
          point={tag}
          from={incoming}
          offset={round2(ringR * 1.9)}
          length={round2(ringR * 2.1)}
          width={round2(preset.routeWidth * 1.2)}
        />
      ) : null}

      {turnpoint.isGoal ? (
        <circle
          cx={tag.x}
          cy={tag.y}
          r={ringR}
          strokeWidth={round2(preset.routeWidth * 1.1)}
        />
      ) : null}
    </g>
  );
}

/** Two decimals — below SVG's rendering resolution here, and it keeps the
 *  server- and client-rendered attributes byte-identical. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The ESS timing gate: a short line across the incoming leg, positioned by
 * `gateTickPlacement` (which is where the "set back, capped to the leg" rules
 * live, and where they are tested).
 */
function GateTick({
  point,
  from,
  offset,
  length,
  width,
}: {
  point: { x: number; y: number };
  from: { x: number; y: number };
  offset: number;
  length: number;
  width: number;
}) {
  const at = gateTickPlacement(point, from, offset);
  if (!at) return null;

  const dx = (Math.cos(at.angle) * length) / 2;
  const dy = (Math.sin(at.angle) * length) / 2;
  return (
    <line
      x1={round2(at.x - dx)}
      y1={round2(at.y - dy)}
      x2={round2(at.x + dx)}
      y2={round2(at.y + dy)}
      strokeWidth={width}
      strokeLinecap="round"
    />
  );
}

/**
 * The pointer/keyboard target for one turnpoint. A transparent circle wide
 * enough to hit with a thumb, carrying the turnpoint's name so hovering gives
 * a native tooltip and — when the diagram is selectable — so tabbing to it
 * announces which turnpoint has focus.
 */
function TurnpointHitArea({
  turnpoint,
  radius,
  interactive,
  isTabStop,
  onEnter,
  onLeave,
  onFocused,
  onMove,
  onSelect,
}: {
  turnpoint: TaskDiagramTurnpoint;
  radius: number;
  interactive: boolean;
  /** Owns the group's single tab stop (roving tabindex). */
  isTabStop: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onFocused: () => void;
  /** Move focus this many turnpoints along the route (wrapping). */
  onMove: (delta: number) => void;
  onSelect?: () => void;
}) {
  const name = turnpoint.role
    ? `${turnpoint.name} (${turnpoint.role})`
    : turnpoint.name;

  return (
    <g
      data-turnpoint={interactive ? turnpoint.index : undefined}
      className={cn(
        "outline-none",
        interactive &&
          "cursor-pointer [&:focus-visible>circle]:stroke-[color:var(--ring)] [&:focus-visible>circle]:stroke-2"
      )}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? (isTabStop ? 0 : -1) : undefined}
      aria-label={interactive ? name : undefined}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onPointerDown={interactive ? onEnter : undefined}
      onFocus={interactive ? onFocused : onEnter}
      onBlur={onLeave}
      onClick={onSelect}
      onKeyDown={
        interactive
          ? (event) => {
              switch (event.key) {
                case "Enter":
                case " ":
                  event.preventDefault();
                  onSelect?.();
                  break;
                case "ArrowRight":
                case "ArrowDown":
                  event.preventDefault();
                  onMove(1);
                  break;
                case "ArrowLeft":
                case "ArrowUp":
                  event.preventDefault();
                  onMove(-1);
                  break;
                default:
                  break;
              }
            }
          : undefined
      }
    >
      <circle
        cx={turnpoint.tag.x}
        cy={turnpoint.tag.y}
        r={radius}
        fill="transparent"
        stroke="none"
      >
        <title>{name}</title>
      </circle>
    </g>
  );
}
