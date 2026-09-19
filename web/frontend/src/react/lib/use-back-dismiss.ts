/**
 * Make an overlay dismissable with the browser's Back button (and a phone's
 * back gesture) — and, for a page with unsaved work, make Back ask before it
 * throws that work away.
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
 * - Back (popstate) → `onDismiss()`, and the entry is already behind us.
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
 * ## A layer that answers Back with a question
 *
 * {@link ./use-unsaved-changes-guard.ts} joins this same stack, with `enabled`
 * following the form's dirty flag, so a Back on an unsaved page is asked about
 * rather than obeyed. It does not close anything, which is why a layer can do
 * two things the overlays never need:
 *
 * - {@link BackDismissLayer.rearm} puts the entry straight back, so the reader
 *   never actually moves while they decide and "Keep editing" is a no-op by
 *   construction.
 * - It takes the GROUND floor (see {@link waitingToArm}): a Back aimed at a
 *   sheet belongs to the sheet, even when the form went dirty two layers deep.
 * - {@link BackDismissLayer.unwind} walks back out of this layer's entry AND
 *   anything stacked over it — the confirm dialog pushes one of its own — and
 *   then runs the navigation the reader asked for. It counts nothing: it reads
 *   the marker off each entry as it goes, so it is right whether or not the
 *   dialog has released its entry yet.
 *
 * ## Five things make this fiddly, and all five were found by the e2e
 *
 * **A popstate reaches every listener**, so nesting needs a stack. The
 * altitude review is a sheet with a detail view inside it, and both layers use
 * this hook: a Back meant for the detail was also seen by the sheet, which
 * closed the lot. Only the layer on TOP of {@link layers} acts on a pop.
 *
 * **Every pop this module performs is somebody else's popstate**, which a
 * layer underneath would read as a user pressing Back. {@link unwinding} is
 * held for the whole of a walk — which is several pops long — and every
 * listener sits out anything that arrives while it is set.
 *
 * **StrictMode runs the effect twice**, and the first run's cleanup would
 * release the entry the second run then needs. Releasing is deferred by a
 * task, and a re-run cancels the pending release and keeps the entry. Without
 * that, the cleanup's `history.back()` fired a popstate the second run's own
 * listener caught — so every sheet closed itself the instant it opened.
 *
 * **Two walks at once pop twice for the same entry**, since a traversal is not
 * visible until its popstate lands. {@link walkBack} runs them one at a time.
 *
 * **A deferred release can be gazumped, and leaves a dead entry when it is.**
 * The waypoints sheet applies its draft on the way out, so the page goes dirty
 * — and the guard arms, and pushes — in the same tick the sheet's release is
 * still only scheduled. The release then finds somebody else's entry on top
 * and, rightly, refuses to pop it. That leaves an entry wearing the page's own
 * URL that nothing will ever return to, and a Back landing on one looks like a
 * Back that did nothing. So a walk does not stop on a marked entry no live
 * layer owns: {@link isDead} entries are popped straight through.
 */
import { useEffect, useRef } from "react";

/** Marks the entries this hook owns, so it never pops somebody else's. */
interface BackDismissState {
  gcBackDismiss?: number;
}

/** Open layers, outermost first. Only the last one answers a Back. */
const layers: number[] = [];

/**
 * True for the whole of a {@link walkBack}, which is several pops long, so no
 * layer mistakes one of them for a reader's Back. Cleared on the step that
 * stops, by which point that last popstate has already been delivered to every
 * listener registered before the walk started — which is all of them.
 */
let unwinding = false;

let nextId = 1;

function forget(id: number): void {
  const at = layers.lastIndexOf(id);
  if (at !== -1) layers.splice(at, 1);
}

/** The marker on the entry being stood on, if this module pushed it. */
function currentMarker(): number | undefined {
  return (window.history.state as BackDismissState | null)?.gcBackDismiss;
}

/** One of ours, for a layer that has gone: nothing will ever return to it. */
function isDead(marker: number | undefined): boolean {
  return marker !== undefined && !layers.includes(marker);
}

/**
 * Ground-floor layers that want an entry but cannot have one yet.
 *
 * History is linear: an entry cannot be inserted UNDER one that already
 * exists. So a layer that must sit beneath every overlay — the unsaved-changes
 * guard, which guards leaving the page and has no business taking a Back aimed
 * at a sheet — waits for the overlays to close and takes the ground floor when
 * it is free. The waypoints page makes this the ordinary case rather than a
 * corner: editing an altitude inside the review sheet is what turns the page
 * dirty, so the guard arms two layers deep.
 */
const waitingToArm: Array<() => void> = [];

/** Hand the ground floor over, if the stack has just emptied. */
function settle(): void {
  if (unwinding || layers.length > 0) return;
  for (const arm of waitingToArm.splice(0)) arm();
}

/** Push a fresh entry for a layer and put it on top of the stack. */
function pushEntry(): number {
  const id = nextId++;
  layers.push(id);
  const state: BackDismissState = { gcBackDismiss: id };
  window.history.pushState(state, "", window.location.href);
  return id;
}

/** Walks asked for while one was already running, oldest first. */
const queuedWalks: Array<() => void> = [];

/**
 * Pop for as long as `shouldPop` says so, then run `then` from wherever that
 * leaves us.
 *
 * Driven by popstate rather than by a count, because `history.back()` does not
 * take effect until its popstate arrives and what is stacked above is not
 * knowable anyway: the confirm dialog a guard opens pushes an entry of its own
 * and releases it on a timer that may or may not have fired yet. Each step
 * reads the marker off the entry it is standing on instead.
 *
 * **Strictly one at a time.** Two releases land in the same tick whenever a
 * sheet's Done also settles the form — and a second walk starting then reads
 * the marker of an entry the first walk has already asked to leave, because
 * the traversal has not landed. Both then pop for it, and the reader is thrown
 * two pages back. A walk asked for mid-walk waits its turn instead, and
 * re-reads the stack when it gets there.
 *
 * `then` runs with {@link unwinding} cleared, so the pop IT performs is a real
 * one — that is how a guard's Back reaches the layer below, or the router. Any
 * walk waiting behind it re-reads the stack after that, sees an entry no layer
 * marked, and stops without popping.
 */
function walkBack(shouldPop: (marker: number | undefined) => boolean, then?: () => void): void {
  if (unwinding) {
    queuedWalks.push(() => walkBack(shouldPop, then));
    return;
  }
  unwinding = true;
  const step = () => {
    if (shouldPop(currentMarker())) {
      window.history.back();
      return;
    }
    window.removeEventListener("popstate", step);
    unwinding = false;
    then?.();
    queuedWalks.shift()?.();
    settle();
  };
  window.addEventListener("popstate", step);
  step();
}

/** What a layer can do to its own history entry after it has been popped. */
export interface BackDismissLayer {
  /**
   * Push this layer's entry again, after a Back consumed it.
   *
   * For a layer that answers a Back with a question rather than by closing:
   * the reader's position never really moves, so declining to leave needs no
   * history work at all. A layer that still owns its entry is left alone.
   */
  rearm(): void;
  /**
   * Give up this layer's entry — and anything stacked over it — then run
   * `then` from the page underneath.
   *
   * This is the "yes, leave" half of a guard: `then` is the navigation the
   * reader asked for, a `history.back()` to finish the press they made or a
   * router `navigate()` to follow the link they clicked.
   */
  unwind(then?: () => void): void;
}

/**
 * @param onDismiss Called when Back consumes this layer's entry.
 * @param enabled Whether this layer holds an entry at all. A guard follows its
 *   form's dirty flag here; an overlay is mounted only while open and leaves
 *   it alone. Disarming releases the entry exactly as unmounting would.
 * @param ground Take the entry only when no other layer holds one, and wait
 *   for the stack to empty otherwise — see {@link waitingToArm}. For a layer
 *   that belongs to the PAGE rather than to something drawn over it.
 */
export function useBackDismiss(
  onDismiss: () => void,
  enabled = true,
  ground = false
): BackDismissLayer {
  // Through a ref, so a handler closing over fresh state keeps working without
  // the entry being pushed again on every render.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  /** The id of the entry this overlay owns, or null when it owns none. */
  const owned = useRef<number | null>(null);
  /** A release this overlay has scheduled but not yet performed. */
  const pendingRelease = useRef<number | null>(null);
  /** False once disarmed or unmounted, so a deferred arm knows to stand down. */
  const wanted = useRef(false);

  // Built once: a caller may hold on to it (the unsaved-changes guard keeps it
  // in a ref and calls it from a promise), so its identity has to be stable.
  const layer = useRef<BackDismissLayer | null>(null);
  if (layer.current === null) {
    layer.current = {
      rearm() {
        if (typeof window === "undefined" || owned.current !== null) return;
        owned.current = pushEntry();
      },
      unwind(then) {
        const id = owned.current;
        owned.current = null;
        if (id === null || typeof window === "undefined") {
          then?.();
          return;
        }
        forget(id);
        // Pop through whatever the prompt stacked on top, then through this
        // layer's own entry, then through any dead entry under it — and stop
        // on the first one that is really there, which is where the reader's
        // press was headed.
        let passed = false;
        walkBack((marker) => {
          if (passed) return isDead(marker);
          if (marker === undefined) {
            // Already below our own entry: nothing of ours left to leave.
            passed = true;
            return false;
          }
          if (marker === id) passed = true;
          return true;
        }, then);
      },
    };
  }

  useEffect(() => {
    if (typeof window === "undefined" || !enabled) return;

    // A StrictMode re-run lands here with a release still pending from the
    // previous run's cleanup: cancel it and keep the entry we already have.
    // Disarming skips this on purpose (the early return above), because there
    // the pending release is the whole point.
    if (pendingRelease.current !== null) {
      clearTimeout(pendingRelease.current);
      pendingRelease.current = null;
    }
    wanted.current = true;
    const arm = () => {
      if (wanted.current && owned.current === null) owned.current = pushEntry();
    };
    if (owned.current === null) {
      if (ground && layers.length > 0) waitingToArm.push(arm);
      else arm();
    }

    const onPopState = () => {
      // A walk is several pops long and none of them is a reader's Back.
      if (unwinding) return;
      // Only the topmost layer answers: a Back aimed at a detail view inside
      // this sheet is not a Back aimed at the sheet.
      if (owned.current === null || layers[layers.length - 1] !== owned.current) return;
      forget(owned.current);
      // The entry went with the pop, so there is nothing left to release —
      // unless the handler decides to rearm.
      owned.current = null;
      dismiss.current();
      // This layer was the last thing standing between a waiting ground-floor
      // layer and its entry.
      settle();
    };
    window.addEventListener("popstate", onPopState);

    return () => {
      wanted.current = false;
      window.removeEventListener("popstate", onPopState);
      pendingRelease.current = window.setTimeout(() => {
        pendingRelease.current = null;
        const id = owned.current;
        if (id === null) return;
        owned.current = null;
        forget(id);
        // Take back this layer's entry, and any dead one it was sitting on.
        // Standing on somebody else's LIVE entry means this release was
        // gazumped — walking through that would close a layer still open, so
        // the walk stops there and leaves a dead entry for the next one.
        walkBack(isDead);
      }, 0);
    };
  }, [enabled]);

  return layer.current;
}
