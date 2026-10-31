/**
 * The task page's route diagram, drawn into the results record.
 *
 * Same geometry and same preset as the page (`buildTaskDiagram` at the `md`
 * preset, TASK_DIAGRAM_PRESETS in task-diagram-layout.ts), so the record shows
 * the drawing an organiser already knows, not a second idea of one. This file
 * only translates TaskDiagram.tsx's marks into pdf-lib calls:
 *
 *   cylinders   hairline rings, dashed for an exit cylinder
 *   route       the optimised line, with an arrow on each long-enough leg
 *   markers     start = hollow ring, ESS = a gate tick across the incoming
 *               leg, goal = dot inside a ring, anything else = a dot
 *   labels      names with a white halo, so one crossing a ring stays legible
 *
 * The page's interactive parts (the highlighter, hit targets, wind rose) have
 * no place on paper and are left out. Diagram units are y-down; PDF space is
 * y-up, so every point goes through `at()`.
 */
import {
  clip,
  endPath,
  LineCapStyle,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type Color,
} from "pdf-lib";
import type { XCTask } from "@glidecomp/engine";
import {
  buildTaskDiagram,
  gateTickPlacement,
  TASK_DIAGRAM_PRESETS,
} from "../react/comp/task-diagram-layout";
import type { PdfWriter } from "./pdf-writer";

const PRESET = TASK_DIAGRAM_PRESETS.md;

/** Opacity on white, as flat greys: prints the same on every printer. */
const ink = (opacity: number): Color => rgb(1 - 0.91 * opacity, 1 - 0.91 * opacity, 1 - 0.89 * opacity);
const PAPER = rgb(1, 1, 1);
const FRAME = rgb(0.975, 0.975, 0.98);

/** The diagram's size in points at `scale`. */
export function taskDiagramSize(scale: number): { width: number; height: number } {
  return { width: PRESET.width * scale, height: PRESET.height * scale };
}

/**
 * Draw the route diagram with its top-left corner at (left, top), `scale`
 * points per diagram unit. Returns false (drawing nothing) when the task has
 * no drawable route.
 */
export function drawTaskDiagram(
  w: PdfWriter,
  task: XCTask,
  left: number,
  top: number,
  scale: number
): boolean {
  const layout = buildTaskDiagram(task, {
    width: PRESET.width,
    height: PRESET.height,
    padding: PRESET.padding,
    labelFontSize: PRESET.labelFontSize,
    labelMaxChars: PRESET.labelMaxChars,
    arrowMinLength: PRESET.arrowMinLength,
    dotRadius: PRESET.dotRadius,
    cylinders: PRESET.cylinders,
  });
  if (!layout) return false;

  const page = w.page;
  const s = scale;
  const at = (p: { x: number; y: number }) => ({ x: left + p.x * s, y: top - p.y * s });
  const width = layout.width * s;
  const height = layout.height * s;

  // The frame, then clip to it: a cylinder is drawn at its true size and may
  // run past the box, exactly as the SVG viewport clips it on the page.
  page.drawRectangle({ x: left, y: top - height, width, height, color: FRAME });
  page.pushOperators(pushGraphicsState(), rectangle(left, top - height, width, height), clip(), endPath());

  const line = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    thickness: number,
    color: Color,
    dashArray?: number[]
  ) =>
    page.drawLine({
      start: at(a),
      end: at(b),
      thickness: thickness * s,
      color,
      lineCap: LineCapStyle.Round,
      dashArray: dashArray?.map((d) => d * s),
    });

  for (const tp of layout.turnpoints) {
    if (!tp.showCylinder) continue;
    const c = at(tp.center);
    page.drawCircle({
      x: c.x,
      y: c.y,
      size: tp.radius * s,
      borderColor: ink(0.22),
      borderWidth: 0.75 * s,
      borderDashArray: tp.direction === "exit" ? [2 * s, 2 * s] : undefined,
    });
  }

  if (layout.goalLine) line(layout.goalLine[0], layout.goalLine[1], PRESET.routeWidth, ink(0.85));

  for (let i = 1; i < layout.path.length; i++) {
    line(layout.path[i - 1], layout.path[i], PRESET.routeWidth, ink(0.9));
  }

  const a = PRESET.arrowSize;
  for (const arrow of layout.arrows) {
    // The page's chevron, M(-a,-0.72a) L0,0 L(-a,0.72a), rotated onto the leg.
    const rot = (dx: number, dy: number) => ({
      x: arrow.x + dx * Math.cos(arrow.angle) - dy * Math.sin(arrow.angle),
      y: arrow.y + dx * Math.sin(arrow.angle) + dy * Math.cos(arrow.angle),
    });
    const tip = { x: arrow.x, y: arrow.y };
    line(rot(-a, -a * 0.72), tip, PRESET.routeWidth, ink(1));
    line(rot(-a, a * 0.72), tip, PRESET.routeWidth, ink(1));
  }

  const r = PRESET.dotRadius;
  const ringR = r * 2.3;
  for (const tp of layout.turnpoints) {
    const c = at(tp.tag);
    if (tp.isStart) {
      page.drawCircle({
        x: c.x,
        y: c.y,
        size: ringR * s,
        color: PAPER,
        borderColor: ink(1),
        borderWidth: PRESET.routeWidth * 1.1 * s,
      });
    } else {
      page.drawCircle({ x: c.x, y: c.y, size: r * s, color: ink(1) });
    }
    const incoming = tp.index > 0 ? layout.path[tp.index - 1] : null;
    if (tp.isEss && incoming) {
      const gate = gateTickPlacement(tp.tag, incoming, ringR * 1.9);
      if (gate) {
        const half = ringR * 2.1 * 0.5;
        const dx = Math.cos(gate.angle) * half;
        const dy = Math.sin(gate.angle) * half;
        line({ x: gate.x - dx, y: gate.y - dy }, { x: gate.x + dx, y: gate.y + dy }, PRESET.routeWidth * 1.2, ink(1));
      }
    }
    if (tp.isGoal) {
      page.drawCircle({ x: c.x, y: c.y, size: ringR * s, borderColor: ink(1), borderWidth: PRESET.routeWidth * 1.1 * s });
    }
  }

  // Names last, over the geometry. The page paints a background-coloured
  // halo under each; here it is a small frame-coloured box, because a halo
  // faked by drawing the name several times in white would put each name in
  // the PDF's extracted text several times over.
  const size = PRESET.labelFontSize * s;
  const font = w.font(false);
  const pad = size * 0.15;
  for (const label of layout.labels) {
    const text = w.clean(label.text);
    const textWidth = w.width(text, size);
    const p = at(label);
    const x = label.anchor === "middle" ? p.x - textWidth / 2 : label.anchor === "end" ? p.x - textWidth : p.x;
    page.drawRectangle({
      x: x - pad,
      y: p.y - size * 0.25,
      width: textWidth + 2 * pad,
      height: size * 1.1,
      color: FRAME,
      opacity: 0.85,
    });
    page.drawText(text, { x, y: p.y, size, font, color: ink(1) });
  }

  page.pushOperators(popGraphicsState());
  return true;
}
