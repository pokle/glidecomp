/**
 * The URL-state half of {@link MasterDetail}'s `navigation` mode.
 *
 * `navigation` lays the two halves out; it deliberately owns nothing about
 * WHICH one is showing, because that has to be derivable on the server. This
 * hook is the other half — the four mechanisms every navigating caller needs,
 * which were written twice (the thermal census, the behaviour ranking) before
 * they were written once:
 *
 * 1. **The selection is a query parameter**, so the server and the first
 *    client render agree, Back is the way out of the detail, and a reader can
 *    paste what they are looking at to someone else.
 * 2. **Stacked, choosing PUSHES; side by side it REPLACES.** Which it is comes
 *    from `onWideChange` — MasterDetail's ResizeObserver, the one breakpoint —
 *    never from a media query of the caller's own, which would be a second
 *    opinion about where the layout splits.
 * 3. **`back()` unwinds its own push** rather than stacking another entry, and
 *    falls back to dropping the parameter for a deep link that arrived on the
 *    detail with no entry to unwind.
 * 4. **Side by side the query is seeded** with the default, so the list always
 *    has the row lit that matches the pane beside it. Seeded with `replace`,
 *    so it never costs the reader a Back press, and only once the layout is
 *    known — never on the server, where the width is not.
 *
 * Parsing stays with the caller: what a valid id IS differs per list (a
 * thermal id is a number matched against the census, a metric id a string
 * matched against the ranked set), both are unit-tested where they live, and
 * the caller needs the resolved object anyway. Pass the result in as `chosen`.
 *
 * ## Seeding re-runs; it does not latch
 *
 * The seed fires whenever the parameter is absent while wide, not once per
 * mount. An earlier copy of this code guarded with a `seededWide` ref that
 * latched forever, which loses to `useCanonicalPath`: it replaces the URL with
 * `canonicalPath + location.search` once the entity names load, and from a
 * closure that can predate the seed — so a seed written first is wiped, and a
 * latched guard never writes another. The reader is then wide with a pane that
 * has a subject and a list with nothing lit, until they pick something.
 *
 * Dropping the latch was not enough on its own (issue #845). The effect ran
 * again only when one of its inputs changed, and a wiped seed changes none of
 * them: `chosen` was null before the seed and is null after it, because the
 * seed never reached a render. So it also runs on every change of location,
 * and the URL is what it asks — is the parameter there? — rather than whether
 * it has written one. (`useCanonicalPath` no longer wipes it either: it now
 * carries the query the address bar holds when it replaces. This is the
 * other half, for any replace built from a query older than the seed.)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

/**
 * Should the side-by-side layout write the default into the query right now?
 *
 * A predicate rather than an inline condition because its one interesting
 * property is a NEGATIVE: it is not "have we seeded yet", it is "is the query
 * missing a selection while wide" — so it answers true again after a seed is
 * undone. The version this replaces latched on a ref and could not (see the
 * note at the top of this file).
 *
 * `named` is the parameter as the URL holds it. When it already names the
 * default and `chosen` is still null, the list does not carry the default,
 * and writing it again would only replace the URL with itself — on every
 * location change, for ever, now that the seed runs on each one.
 */
export function shouldSeedSelection<T extends string | number>({
  enabled,
  wide,
  chosen,
  defaultId,
  named = null,
}: {
  enabled: boolean;
  wide: boolean;
  chosen: T | null;
  defaultId: T | null;
  named?: string | null;
}): boolean {
  return (
    enabled &&
    wide &&
    chosen === null &&
    defaultId !== null &&
    named !== String(defaultId)
  );
}

export interface MasterDetailSelection<T extends string | number> {
  /** Stacked: is the detail the current view? Pass to `navigation`. */
  showingDetail: boolean;
  /** Is the layout side by side? For behaviour only — never for rendering. */
  wide: boolean;
  /**
   * Write the selection to the query. `replace` skips the history entry —
   * pass the `wide` above, so stacked it is a navigation and side by side it
   * is only a change of view.
   */
  choose: (id: T, replace: boolean) => void;
  /** Out of the detail, back to the list. Pass as `navigation.onBack`. */
  back: () => void;
  /** Pass to MasterDetail's `onWideChange`. */
  onWideChange: (wide: boolean) => void;
}

export function useMasterDetailSelection<T extends string | number>({
  param,
  chosen,
  defaultId,
  enabled = true,
}: {
  /** Query parameter naming the selection, e.g. "thermal" or "metric". */
  param: string;
  /**
   * The id the URL names, already validated against the list — null when it
   * names nothing, or names something this list does not carry.
   */
  chosen: T | null;
  /** What the pane shows before anyone picks; null disables seeding. */
  defaultId: T | null;
  /**
   * False while the list has nothing to select yet (a report still loading),
   * so the seed does not write a parameter for a row that is not there.
   */
  enabled?: boolean;
}): MasterDetailSelection<T> {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  // Every change of address re-asks whether the seed is still in it.
  const { key: locationKey } = useLocation();

  // The measured breakpoint, reported by MasterDetail. Held rather than
  // queried so the two can never disagree about where the layout splits.
  const [wide, setWide] = useState(false);
  // Whether THIS hook pushed the history entry the detail is showing on, so
  // `back` can unwind that entry rather than stack another.
  const pushed = useRef(false);
  useEffect(() => {
    if (chosen === null) pushed.current = false;
  }, [chosen]);

  const choose = useCallback(
    (id: T, replace: boolean) => {
      const next = new URLSearchParams(searchParams);
      next.set(param, String(id));
      setSearchParams(next, { replace });
      if (!replace) pushed.current = true;
    },
    [param, searchParams, setSearchParams]
  );

  const named = searchParams.get(param);
  useEffect(() => {
    if (!shouldSeedSelection({ enabled, wide, chosen, defaultId, named })) return;
    // Narrowed by the predicate; TypeScript cannot see through the call.
    choose(defaultId as T, true);
    // `choose` is a new function whenever the query changes, which the
    // location key already covers. A location whose query still names a
    // selection answers false above, so this never overrides one the reader
    // made — it only notices a selection that went missing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, wide, chosen, defaultId, named, locationKey]);

  const back = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete(param);
    setSearchParams(next, { replace: true });
  }, [navigate, param, searchParams, setSearchParams]);

  const onWideChange = useCallback((next: boolean) => setWide(next), []);

  return { showingDetail: chosen !== null, wide, choose, back, onWideChange };
}
