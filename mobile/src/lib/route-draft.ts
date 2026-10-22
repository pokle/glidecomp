/**
 * The app's route editor, as operations on its rows — pure, so the rules the
 * website's editor follows are tested here too: the goal stays last, a
 * turnpoint typed Goal moves to the end and demotes any other, and a reorder
 * that moves the goal off the end hands Goal to the new last turnpoint.
 * Built from @glidecomp/client's own turnpoint-draft helpers.
 */
import type { RouteRow } from '@glidecomp/client/route-editor';
import {
  demoteOtherGoals,
  moveRowToEnd,
  reconcileGoalPosition,
  type TurnpointDraft,
} from '@glidecomp/client/turnpoint-draft';

/** Put a draft in place — as a new last row when `id` is null — keeping the goal rules. */
export function applyDraft(rows: RouteRow[], id: number | null, draft: TurnpointDraft, nextId: () => number): RouteRow[] {
  let next: RouteRow[];
  let targetId: number;
  if (id === null) {
    targetId = nextId();
    next = [...rows, { ...draft, id: targetId, leg: null, dir: null }];
  } else {
    targetId = id;
    next = rows.map((r) => (r.id === id ? { ...r, ...draft } : r));
  }
  if (draft.type === 'GOAL') {
    next = moveRowToEnd(demoteOtherGoals(next, targetId), targetId);
  }
  return reconcileGoalPosition(next);
}

/** Move one row up (-1) or down (+1); the goal rule follows the reorder. */
export function moveRow(rows: RouteRow[], id: number, delta: -1 | 1): RouteRow[] {
  const at = rows.findIndex((r) => r.id === id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= rows.length) return rows;
  const next = rows.slice();
  [next[at], next[to]] = [next[to], next[at]];
  return reconcileGoalPosition(next);
}

export function removeRow(rows: RouteRow[], id: number): RouteRow[] {
  return reconcileGoalPosition(rows.filter((r) => r.id !== id));
}
