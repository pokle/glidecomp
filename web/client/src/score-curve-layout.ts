/**
 * Which pilots the report card's score curve names, and where each name goes
 * — shared by the website's SVG (`charts/ScoreCurve.tsx`) and the app's
 * (`mobile/src/charts/ScoreCurve.tsx`), so the two name the same anchors.
 * Pure geometry: the caller has already mapped data to its own pixels.
 */
import type { ScoreChartPilot, ScoreCurveChart } from "@glidecomp/engine";

/**
 * Below this many plotted pilots the median is not worth naming: with a small
 * field the best three and the last are most of it already, and "the middle
 * one of five" is a label, not a finding.
 */
const MEDIAN_MIN_FIELD = 7;

/** Rough width of a label, for collision testing. The names are proportional
 *  text; 0.54em per character over-estimates slightly, which is the safe
 *  direction — it drops a marginal label rather than overlapping one. Taking
 *  the size as an argument is what keeps the estimate honest once the type
 *  grows on a narrow screen: measured against a fixed 10-unit assumption,
 *  every phone-sized name would be judged less than half its drawn width and
 *  the collision test would pass five labels that land on top of each other. */
function labelWidth(name: string, fontSize: number): number {
  return name.length * 0.54 * fontSize;
}

/**
 * Vertical offsets from a dot to try for its label, in order — as multiples
 * of the label's own size, because that is what "far enough to clear the line
 * above" actually means.
 *
 * These curves are steep at one end, which is exactly where the best pilots
 * bunch — on a real task the three fastest sat within four minutes and twenty
 * points of each other, so their labels cannot all sit above their own dots.
 * Rather than drop two of the three, walk outwards until one fits and draw a
 * leader line back to the dot.
 */
const LABEL_OFFSETS_EM = [-1.2, 1.9, -2.7, 3.4, -4.2, 4.9];

/** Beyond this displacement a label no longer obviously belongs to the dot
 *  under it, so it earns a leader line. In ems for the same reason as
 *  {@link LABEL_OFFSETS_EM}. */
const LEADER_THRESHOLD_EM = 2.2;

/**
 * Two dots closer than this are one dot to the eye, so only the first of them
 * is named.
 *
 * Not a nicety: on the distance chart every pilot who made goal sits at the
 * same (best distance, full points), so "the best three" are one point. Three
 * names stacked beside it, with three leader lines into the same pixel, says
 * there are three things there when there is one.
 */
const SAME_DOT_PX = 6;

export interface PlacedLabel {
  key: string;
  name: string;
  x: number;
  y: number;
  /** The dot this names, for the leader line. */
  dotX: number;
  dotY: number;
  you: boolean;
  /** True when the name sits far enough from its dot to need a leader line. */
  leader: boolean;
  box: { x0: number; x1: number; y0: number; y1: number };
}

function overlaps(a: PlacedLabel["box"], b: PlacedLabel["box"]): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Format an x value for a tick or a readout, by what the axis measures. */
export function formatChartX(unit: ScoreCurveChart["xUnit"], v: number): string {
  switch (unit) {
    case "duration": {
      const s = Math.max(0, Math.round(v));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
        : `${m}:${String(sec).padStart(2, "0")}`;
    }
    case "distance":
      return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} km`;
    case "position":
      return String(Math.round(v));
    case "coefficient":
      return v.toFixed(2);
  }
}

/** A pilot's dot, read aloud: "Jo Bloggs, 1:42:07, 343.2 points". */
export function curvePilotLabel(unit: ScoreCurveChart["xUnit"], p: ScoreChartPilot): string {
  return `${p.name}, ${formatChartX(unit, p.x)}, ${Math.round(p.y * 10) / 10} points`;
}

/**
 * Name the anchors of the field and place each name clear of the others.
 *
 * A lone accent dot tells you where you are but not what that is worth — the
 * field needs anchors, so the best three, the last and (in a field big enough
 * for it to mean anything) the median are named too. Ranked by THIS
 * component's points — the y axis — not by the class scores. That is what
 * "the best three" means on a chart about one component, and it is the
 * reading that makes the arrival chart's story legible: the pilot who won the
 * day is not necessarily among the three named at the top of it.
 *
 * Greedy placement: each name takes the first offset that collides with
 * nothing already placed, so a bunched leader board stacks outwards instead
 * of losing everyone after the first. A name that fits nowhere is dropped
 * rather than drawn over another — an unreadable pile helps no one — and the
 * priority order means the subject of the page is never the one dropped.
 */
export function placeCurveLabels({
  points,
  x,
  y,
  fontSize,
  width,
  plot,
}: {
  points: ScoreChartPilot[];
  x: (v: number) => number;
  y: (v: number) => number;
  fontSize: number;
  /** The drawing's full width, which a name may use up to its right edge. */
  width: number;
  /** The plot area: a name stays inside it vertically, and right of its left
   *  edge, where the y-axis numbers are. */
  plot: { left: number; top: number; bottom: number };
}): PlacedLabel[] {
  const you = points.find((p) => p.you);
  const byPoints = [...points].sort((a, b) => b.y - a.y);
  const candidates: ScoreChartPilot[] = [];
  const consider = (p: ScoreChartPilot | undefined) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  if (you) consider(you);
  byPoints.slice(0, 3).forEach(consider);
  consider(byPoints[byPoints.length - 1]);
  if (byPoints.length >= MEDIAN_MIN_FIELD) {
    consider(byPoints[Math.floor(byPoints.length / 2)]);
  }

  const labels: PlacedLabel[] = [];
  for (const p of candidates) {
    const dotX = x(p.x);
    const dotY = y(p.y);
    // One name per visible dot — see SAME_DOT_PX.
    if (labels.some((l) => Math.hypot(l.dotX - dotX, l.dotY - dotY) < SAME_DOT_PX)) {
      continue;
    }
    const half = labelWidth(p.name, fontSize) / 2;
    // Clamp by the label's OWN width — a fixed inset lets a long name run off
    // the right edge, which is where the best pilots sit on a rising curve.
    // Asymmetric on purpose: the right margin is empty so a label may use it,
    // but the LEFT margin holds the y-axis numbers, and a name pushed into it
    // sits on top of them. Displacement is what the leader lines are for.
    const cx = Math.min(width - half - 2, Math.max(plot.left + half + 2, dotX));
    for (const em of LABEL_OFFSETS_EM) {
      const ly = dotY + em * fontSize;
      // Keep it inside the plot: a label pushed off the top or bottom is as
      // lost as one that collided.
      if (ly < plot.top + fontSize * 0.9 || ly > plot.bottom - fontSize * 0.2) continue;
      const box = {
        x0: cx - half,
        x1: cx + half,
        y0: ly - fontSize * 0.9,
        y1: ly + fontSize * 0.3,
      };
      if (labels.some((l) => overlaps(l.box, box))) continue;
      labels.push({
        key: p.key,
        name: p.name,
        x: cx,
        y: ly,
        dotX,
        dotY,
        you: p.you,
        leader: Math.abs(ly - dotY) > LEADER_THRESHOLD_EM * fontSize,
        box,
      });
      break;
    }
  }
  return labels;
}
