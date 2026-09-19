/**
 * Make an overlay dismissable with the browser's Back button (and a phone's
 * back gesture).
 *
 * A sheet that lives in React state and not in the URL is invisible to the
 * history stack, so Back skips straight past it to whatever page came before —
 * from a waypoint's details, a single Back left the waypoints page entirely,
 * unsaved edits and all. On a phone that is not an edge case: the back gesture
 * is how people close things.
 *
 * So an overlay that uses this pushes ONE history entry while it is open, and
 * consumes it again on the way out:
 *
 * - Back (popstate) → `onDismiss()`, and the entry is already gone.
 * - Closed from the UI → the entry is popped with `history.back()`, so the
 *   stack is left exactly as it was found and the NEXT Back goes where the
 *   reader expects rather than appearing to do nothing.
 *
 * The URL never changes (`pushState` is given the current href), which is what
 * keeps this compatible with the router: react-router sees a popstate for a
 * location it is already on, so it re-renders nothing. A sheet cannot be a
 * route here anyway — the page behind it is unsaved React state, a sibling
 * route would unmount it, and `use-unsaved-changes-guard` would prompt
 * "Discard changes?" on the way in.
 *
 * ## Three things make this fiddly, and all three were found by the e2e
 *
 * **A popstate reaches every listener**, so nesting needs a stack. The
 * altitude review is a sheet with a detail view inside it, and both layers use
 * this hook: a Back meant for the detail was also seen by the sheet, which
 * closed the lot. Only the layer on TOP of {@link layers} acts on a pop.
 *
 * **Popping our own entry also fires a popstate**, which the layer underneath
 * would then read as a user pressing Back. A programmatic pop is therefore
 * announced in {@link ignoringPop} and every listener sits that one out.
 *
 * **StrictMode runs the effect twice**, and the first run's cleanup would
 * release the entry the second run then needs. Releasing is deferred by a
 * task, and a re-run cancels the pending release and keeps the entry. Without
 * that, the cleanup's `history.back()` fired a popstate the second run's own
 * listener caught — so every sheet closed itself the instant it opened.
 */
import { useEffect, useRef } from "react";

/** Marks the entries this hook owns, so it never pops somebody else's. */
interface BackDismissState {
  gcBackDismiss?: number;
}

/** Open layers, outermost first. Only the last one answers a Back. */
const layers: number[] = [];

/**
 * True while a pop this module asked for is in flight.
 *
 * Not a counter, and not cleared on a timer: ONE popstate is delivered to
 * every listener in turn, so they all have to sit out the same event. It is
 * cleared in a microtask instead, which runs after that whole synchronous
 * round of listeners — a `setTimeout` raced the browser's own delivery of the
 * event and sometimes cleared the flag first, which closed the sheet
 * underneath. A pop with no listeners left to see it leaves the flag set, so
 * the next overlay to open clears it on the way in.
 */
let ignoringPop = false;

let nextId = 1;

function forget(id: number): void {
  const at = layers.lastIndexOf(id);
  if (at !== -1) layers.splice(at, 1);
}

export function useBackDismiss(onDismiss: () => void): void {
  // Through a ref, so a handler closing over fresh state keeps working without
  // the entry being pushed again on every render.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  /** The id of the entry this overlay owns, or null when it owns none. */
  const owned = useRef<number | null>(null);
  /** A release this overlay has scheduled but not yet performed. */
  const pendingRelease = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // A StrictMode re-run lands here with a release still pending from the
    // previous run's cleanup: cancel it and keep the entry we already have.
    if (pendingRelease.current !== null) {
      clearTimeout(pendingRelease.current);
      pendingRelease.current = null;
    }
    if (owned.current === null) {
      // Nothing is in flight once a new layer opens, and a pop that landed
      // with no listeners could otherwise have left this set.
      ignoringPop = false;
      const id = nextId++;
      owned.current = id;
      layers.push(id);
      const state: BackDismissState = { gcBackDismiss: id };
      window.history.pushState(state, "", window.location.href);
    }

    const onPopState = () => {
      if (ignoringPop) {
        // Every listener must see it, so clear it only once they all have.
        queueMicrotask(() => {
          ignoringPop = false;
        });
        return;
      }
      // Only the topmost layer answers: a Back aimed at a detail view inside
      // this sheet is not a Back aimed at the sheet.
      if (owned.current === null || layers[layers.length - 1] !== owned.current) return;
      forget(owned.current);
      // The entry went with the pop, so there is nothing left to release.
      owned.current = null;
      dismiss.current();
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      window.removeEventListener("popstate", onPopState);
      pendingRelease.current = window.setTimeout(() => {
        pendingRelease.current = null;
        const id = owned.current;
        if (id === null) return;
        owned.current = null;
        forget(id);
        const current = window.history.state as BackDismissState | null;
        if (current?.gcBackDismiss !== id) return;
        // Our own pop: the layer underneath must not read it as a user Back.
        ignoringPop = true;
        window.history.back();
      }, 0);
    };
  }, []);
}
