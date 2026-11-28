/**
 * The floating window's rules, without React or the DOM: where it sits, what
 * it remembers, and where a drag lets it go. See `FloatingWindow.tsx` for the
 * window itself and docs/interaction-guide.md 2.8 for why it exists.
 */

export type FloatSide = "left" | "right";
export type FloatEdge = "top" | "bottom";
export type FloatSize = "small" | "large";

export interface FloatState {
  /** The corner it rests in. Tucked, the side its tab is on. */
  side: FloatSide;
  edge: FloatEdge;
  size: FloatSize;
  /** Put away against `side`, with only its tab showing. */
  tucked: boolean;
}

/**
 * Small, top right. Top, because a thumb scrolls from the bottom of a phone
 * and a window resting there would be dragged by every scroll that began on
 * it. Right, because the text it covers is left-aligned.
 */
export const DEFAULT_FLOAT: FloatState = {
  side: "right",
  edge: "top",
  size: "small",
  tucked: false,
};

const STORAGE_PREFIX = "glidecomp:float:";

export function floatStorageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

/** A stored value is only trusted field by field: it is the reader's disk. */
export function parseFloatState(raw: string | null): FloatState | null {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof FloatState, unknown>>;
    if (v == null || typeof v !== "object") return null;
    return {
      side: v.side === "left" ? "left" : v.side === "right" ? "right" : DEFAULT_FLOAT.side,
      edge: v.edge === "bottom" ? "bottom" : v.edge === "top" ? "top" : DEFAULT_FLOAT.edge,
      size: v.size === "large" ? "large" : "small",
      tucked: v.tucked === true,
    };
  } catch {
    return null;
  }
}

export function readStoredFloat(key: string): FloatState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseFloatState(window.localStorage.getItem(floatStorageKey(key)));
  } catch {
    return null;
  }
}

export function writeStoredFloat(key: string, state: FloatState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(floatStorageKey(key), JSON.stringify(state));
  } catch {
    // Quota or private mode: the state still holds for the session.
  }
}

/** A drag shorter than this is a tap. A fingertip is not still. */
export const DRAG_SLOP_PX = 8;
/** Two taps this close together are a double tap. */
export const DOUBLE_TAP_MS = 320;

/** How far ahead a flick carries the window, at its speed on release. */
const PROJECT_MS = 180;
/** A finger does not exceed this by much; a noisy sample can. px/ms. */
const MAX_SPEED = 3;
/** This much of the window past a side edge means "put it away". */
const TUCK_OVERHANG = 1 / 3;
/** A flick outward puts it away from less far: this much, at this speed. */
const TUCK_FLICK_OVERHANG = 1 / 10;
const TUCK_FLICK_SPEED = 0.5;
/** Around the middle, the window keeps the side it had. A large window
 * rests with its centre ON the middle, and must not flip on a tremor. */
const SIDE_DEAD_ZONE_PX = 24;

export interface Release {
  /** The window's centre on release, in viewport pixels. */
  cx: number;
  cy: number;
  /** The window's width on release. */
  width: number;
  /** Speed on release, px/ms. */
  vx: number;
  vy: number;
  /** The viewport. */
  vw: number;
  vh: number;
}

const clampSpeed = (v: number) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));

/**
 * Where a released window comes to rest. It always lands in a corner or
 * against a side: there is no in-between for the reader to tidy up.
 */
export function settle(from: FloatState, r: Release): FloatState {
  const px = r.cx + clampSpeed(r.vx) * PROJECT_MS;
  const py = r.cy + clampSpeed(r.vy) * PROJECT_MS;
  const mid = r.vw / 2;
  // Putting it away takes the window itself going over the edge. A flick
  // TOWARDS a side is only a throw to that side's corner: a projected
  // position must never tuck, or every fast move to the right would.
  const overLeft = (r.width / 2 - r.cx) / r.width;
  const overRight = (r.cx + r.width / 2 - r.vw) / r.width;
  const vx = clampSpeed(r.vx);
  const tuckLeft =
    overLeft >= TUCK_OVERHANG ||
    (overLeft >= TUCK_FLICK_OVERHANG && vx <= -TUCK_FLICK_SPEED);
  const tuckRight =
    !tuckLeft &&
    (overRight >= TUCK_OVERHANG ||
      (overRight >= TUCK_FLICK_OVERHANG && vx >= TUCK_FLICK_SPEED));
  const side: FloatSide =
    tuckLeft ? "left"
    : tuckRight ? "right"
    : Math.abs(px - mid) < SIDE_DEAD_ZONE_PX ? from.side
    : px < mid ? "left" : "right";
  return {
    ...from,
    side,
    edge: py < r.vh / 2 ? "top" : "bottom",
    tucked: tuckLeft || tuckRight,
  };
}

/**
 * Speed over the last moments of a drag, px/ms. The last sample alone is
 * noise, and the whole drag is history: a finger that stopped before lifting
 * has not flicked.
 */
export function releaseVelocity(
  samples: readonly { x: number; y: number; t: number }[],
  now: number
): { vx: number; vy: number } {
  const WINDOW_MS = 100;
  const recent = samples.filter((s) => now - s.t <= WINDOW_MS);
  if (recent.length < 2) return { vx: 0, vy: 0 };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
}

/** Does typing here bring up an on-screen keyboard? */
export function opensKeyboard(el: {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  readOnly?: boolean;
} | null): boolean {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.readOnly) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !/^(button|checkbox|radio|range|submit|reset|file|color|image|hidden)$/.test(
    el.type ?? "text"
  );
}
