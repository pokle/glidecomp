/**
 * Poll while something is still being computed, and give up eventually.
 *
 * The field-analysis pages both promise "this page refreshes itself" while a
 * cold analysis computes in the background — the cold path never computes on
 * the request, so the first reader gets `pending` and has to be told when the
 * real answer lands. The ScoreFreshness ETag poll cannot cover it: a pending
 * response has no stored body to validate against.
 *
 * Both pages had their own copy of this effect, identical down to the
 * constants and differing only in the name of the predicate — and both copies
 * carried the same bug. `startedAt` and `delay` were locals of the effect, and
 * the effect listed the refetch counter in its deps, so every tick tore it down
 * and rebuilt it with the clock back at zero. The backoff never grew past its
 * first step and the deadline never arrived: an analysis that stayed pending
 * was polled every three seconds for as long as the page was open. Both now
 * live in refs that survive the re-run, so the documented behaviour is the
 * actual behaviour.
 *
 * Three behaviours are worth keeping in one place:
 *
 *   - **It backs off.** 3s, then ×1.5 up to 10s. A fixed short interval would
 *     hammer an endpoint that is expensive precisely when it is pending.
 *   - **It stops.** After ~2 minutes it simply stops asking. The pending banner
 *     stays up and a manual reload picks up whatever is newest; a poll that ran
 *     forever would keep a backgrounded tab talking to the API all day.
 *   - **It waits for a visible tab.** A hidden tab reschedules instead of
 *     fetching, so a comp left open in a background tab costs nothing.
 */
import { useEffect, useRef } from "react";

/** First wait before re-asking. */
const INITIAL_DELAY_MS = 3_000;
/** The wait never grows past this. */
const MAX_DELAY_MS = 10_000;
/** Total time to keep asking before leaving it to a manual reload. */
const GIVE_UP_AFTER_MS = 120_000;

/**
 * While `active`, call `tick` on a backing-off schedule.
 *
 * `tick` is expected to cause a refetch, which is what ends the poll — so pass
 * the same value the caller bumps (its refetch counter) as `restartKey`, so a
 * landed response restarts the schedule rather than leaving the old timer to
 * fire against stale state.
 */
export function usePollWhile(
  active: boolean,
  tick: () => void,
  restartKey: unknown
): void {
  // These outlive the effect on purpose. `restartKey` changing re-runs the
  // effect on every landed response, so anything held as an effect-local is
  // reset by the very thing whose repetition it is meant to be limiting.
  const startedAt = useRef<number | null>(null);
  const delay = useRef(INITIAL_DELAY_MS);

  // Read through a ref so a fresh closure each render doesn't have to restart
  // the schedule to be seen.
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!active) {
      // Not pending any more — the next poll is a new one and starts over.
      startedAt.current = null;
      delay.current = INITIAL_DELAY_MS;
      return;
    }
    if (startedAt.current === null) startedAt.current = Date.now();
    const began = startedAt.current;

    let timer: number | undefined;
    const schedule = () => {
      if (Date.now() - began > GIVE_UP_AFTER_MS) return;
      timer = window.setTimeout(() => {
        if (!document.hidden) tickRef.current();
        else schedule();
      }, delay.current);
      delay.current = Math.min(delay.current * 1.5, MAX_DELAY_MS);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [active, restartKey]);
}
