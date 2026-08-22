/**
 * Applying a Quick entry line to the route the editor already holds.
 *
 * The line is a LOSSY view of a route: it names waypoints, radii, types and
 * the start, and it cannot say a turnpoint's coordinates, its altitude or its
 * long name. So applying it by rebuilding every turnpoint from the matched
 * waypoint records — which is what the field used to do on every keystroke —
 * throws away exactly the details the line was never able to carry, silently.
 *
 * Instead, reconcile. Walk the picks in order and claim the first unclaimed
 * existing turnpoint with the same name; reuse that row wholesale (its id, its
 * coordinates, its altitude, its description) and overwrite only what the line
 * actually said. Picks that claim nothing become new turnpoints; rows nothing
 * claimed are removed, which is what deleting a name from the line means.
 *
 * Claiming greedily and in order is what makes a repeated waypoint work:
 * "ell 400m ell 5k" is two concentric cylinders at ELLIOT, and the two rows
 * for them must not both collapse onto the first.
 *
 * Reusing the row also keeps its `id` stable, which the turnpoint list needs:
 * a RAC collection keys on it, and minting a fresh id per apply would drop
 * focus and re-mount every row.
 *
 * DOM-free, so it's unit-testable (route-reconcile.test.ts).
 */
import type { QuickTaskPick } from "./quick-task";
import type { RouteRow } from "./route-editor";
import { draftFromRecord } from "./turnpoint-draft";

/** How two names are compared when a pick claims a row: case and space blind. */
function key(name: string): string {
  return String(name).trim().toUpperCase();
}

/**
 * The route a quick-task line describes, built over the route already loaded.
 *
 * `nextId` mints ids for turnpoints the line adds; existing rows keep theirs.
 */
export function reconcileRoute(
  prev: RouteRow[],
  picks: QuickTaskPick[],
  nextId: () => number
): RouteRow[] {
  const claimed = new Set<number>();
  const rows: RouteRow[] = [];

  for (const pick of picks) {
    // A pick with no record is one the parse handed back untouched because it
    // names a turnpoint the route already has (see quickTaskApply's
    // `knownNames`), so its name is the only thing that can find the row.
    const wanted = key(pick.record?.code ?? pick.query);
    const match = prev.find((r) => !claimed.has(r.id) && key(r.name) === wanted);

    if (match) {
      claimed.add(match.id);
      // Everything the line SAYS is taken from the line; everything it can't
      // say — and everything it simply didn't — is the row's own. A radius the
      // reader never typed is the second kind: `parseQuickTask` fills those in
      // from `defaultRadius`, and applying that over a 3 km cylinder somebody
      // set by hand would be this component undoing their work in the name of
      // a number nobody wrote.
      rows.push({
        ...match,
        ...(pick.radiusStated ? { radius: pick.radius } : {}),
        type: pick.type,
        leg: null,
        dir: null,
      });
      continue;
    }

    // Nothing to claim and nothing to build from: a "keep this one" pick whose
    // row has gone. Dropping it is right — it names a turnpoint that no longer
    // exists — and it can't reach the UI anyway, since knownNames comes from
    // these very rows.
    if (!pick.record) continue;

    // A brand-new turnpoint with no radius in the line takes the waypoint's
    // own, exactly as picking that waypoint by hand would.
    const draft = draftFromRecord(pick.record);
    rows.push({
      id: nextId(),
      ...draft,
      ...(pick.radiusStated ? { radius: pick.radius } : {}),
      type: pick.type,
      leg: null,
      dir: null,
    });
  }

  return rows;
}

/**
 * The turnpoints an apply would remove — rows no pick claims.
 *
 * Same greedy claiming as {@link reconcileRoute}, so the two agree by
 * construction. Used to tell the reader what a Quick entry apply is about to
 * cost them before they press it.
 */
export function removedByReconcile(
  prev: RouteRow[],
  picks: QuickTaskPick[]
): RouteRow[] {
  const claimed = new Set<number>();
  for (const pick of picks) {
    const wanted = key(pick.record?.code ?? pick.query);
    const match = prev.find((r) => !claimed.has(r.id) && key(r.name) === wanted);
    if (match) claimed.add(match.id);
  }
  return prev.filter((r) => !claimed.has(r.id));
}
