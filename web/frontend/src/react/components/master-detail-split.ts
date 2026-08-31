/**
 * The side-by-side split for {@link MasterDetail}: a share of the row that
 * the list occupies, with the detail taking the rest.
 *
 * 5/8 is the layout's original 5fr/3fr. The clamp stops either pane collapsing
 * into a sliver you cannot read or drag back from. Pointer math is in the
 * grid's own box so rails and page padding cannot skew the handle.
 */

/** List share matching the old `5fr / 3fr` grid. */
export const DEFAULT_MASTER_SHARE = 5 / 8;

/** Floor: below this the list (or a ranking table) is no longer usable. */
export const MIN_MASTER_SHARE = 0.28;

/** Ceiling: below the complement the detail pane is no longer usable. */
export const MAX_MASTER_SHARE = 0.72;

/** One arrow-key tick. ~4% of the row, enough to feel without leaping. */
export const SHARE_STEP = 0.04;

const STORAGE_PREFIX = "glidecomp:md-split:";

/**
 * The stacked fold is remembered separately from the side-by-side share:
 * they are answers to different questions ("do I want this pane at all on a
 * phone" versus "how much of the row does the list get"), and one reader can
 * hold both at once on the same `detailLabel`.
 */
const COLLAPSE_PREFIX = "glidecomp:md-collapsed:";

export function clampMasterShare(share: number): number {
  if (!Number.isFinite(share)) return DEFAULT_MASTER_SHARE;
  return Math.min(MAX_MASTER_SHARE, Math.max(MIN_MASTER_SHARE, share));
}

/**
 * Where the splitter sits, as a list share, from a pointer inside `grid`.
 * `splitterPx` is the handle column so the value is the list's fraction of
 * the leftover, not of the whole row (a 24–44px handle is not part of either
 * pane).
 */
export function masterShareFromPointer(
  clientX: number,
  grid: { left: number; width: number },
  splitterPx: number
): number {
  const usable = grid.width - splitterPx;
  if (usable <= 0) return DEFAULT_MASTER_SHARE;
  return clampMasterShare((clientX - grid.left - splitterPx / 2) / usable);
}

export function splitStorageKey(detailLabel: string): string {
  return `${STORAGE_PREFIX}${detailLabel}`;
}

export function readStoredMasterShare(detailLabel: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(splitStorageKey(detailLabel));
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampMasterShare(n) : null;
  } catch {
    return null;
  }
}

export function writeStoredMasterShare(detailLabel: string, share: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      splitStorageKey(detailLabel),
      String(clampMasterShare(share))
    );
  } catch {
    // Quota or private mode: the in-memory share still holds for the session.
  }
}

export function collapseStorageKey(detailLabel: string): string {
  return `${COLLAPSE_PREFIX}${detailLabel}`;
}

/**
 * Whether the reader last folded this pane away, or null for "never said".
 *
 * Null is not false: a caller that opens folded by default has to be able to
 * tell an untouched browser from a reader who deliberately unfolded it.
 */
export function readStoredCollapsed(detailLabel: string): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(collapseStorageKey(detailLabel));
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

export function writeStoredCollapsed(
  detailLabel: string,
  collapsed: boolean
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      collapseStorageKey(detailLabel),
      collapsed ? "1" : "0"
    );
  } catch {
    // Quota or private mode: the in-memory fold still holds for the session.
  }
}
