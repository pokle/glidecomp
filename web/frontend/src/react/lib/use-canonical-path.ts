/**
 * Client-side canonical-URL enforcement, the SPA half of URL canonicalisation.
 *
 * The SSR Pages Function 301s direct loads and crawlers to `${slug}-${id}`
 * (see functions/comp/[[path]].ts). This hook covers client-side navigation:
 * once a page's entity names have loaded it computes the canonical pathname and
 * `replace`s the address bar if it differs — so arriving on a bare `${id}` (an
 * old link, a not-yet-updated in-app link) settles on the slugged URL without a
 * full reload.
 *
 * Pass `null` while the name is still loading, so we never redirect to a
 * premature bare-slug URL. The id in a canonical path equals the id in a bare
 * one, so the page's data fetch (keyed on the extracted id) is unaffected — a
 * `replace` here only rewrites the URL text, it does not refetch.
 *
 * Pass `null`, too, while the page still holds data it loaded for the URL it
 * was on BEFORE. react-router keeps a page mounted when only the ids in the
 * path change, so for one load the data and the address bar disagree, and a
 * path built from that data is the previous URL: replacing the address bar
 * with it undoes the navigation that just happened. `useSeededResource`'s
 * `current` says which case a page is in.
 *
 * The one exception is a hidden comp, whose canonical id carries its share key
 * (build the path with `compUrlId()`, lib/slug.ts). An admin who arrives on a
 * bare URL — from search, an old bookmark, an assistant's link — is moved onto
 * the keyed one so their address bar is the link to share, and the page fetches
 * once more under the new id. "Reset link" navigates onto the new key itself,
 * and this is where the rule above bites: until the page has read the comp
 * under that key, the comp it holds carries the OLD one, and canonicalising
 * from it put the dead link back in the address bar (run 41430947899).
 *
 * ## The query is read when the replace happens, not at render
 *
 * The replace keeps the query and hash, and they have to be the ones the
 * address bar holds NOW. `location` is what this render saw, and it can be a
 * step behind: another effect in the same commit may already have written a
 * parameter (children's effects run before their parent's, so a list seeding
 * its default selection — `useMasterDetailSelection` — writes first), and
 * react-router renders every navigation as a transition, so a commit can run
 * its effects under a location the address bar has already left. Building the
 * replacement from that stale `location.search` put the old query back and
 * dropped the new one: the task analysis's default `?metric=` / `?thermal=`
 * was lost on most fresh loads of a bare-id URL, and its row never lit
 * (issue #845).
 *
 * So the replacement carries {@link liveQueryAndHash}. If the address bar has
 * moved to another page since this render, the hook does nothing: the router
 * will render that page, and this effect runs again if it is still on screen.
 */
import { useEffect } from "react";
import { useLocation, useNavigate, type Location } from "react-router-dom";

/**
 * The query and hash the address bar holds right now, while it is still on
 * the page `location` rendered — null once it has moved to a different page.
 *
 * The app runs under BrowserRouter, whose history IS the window's, so the
 * window is the up-to-date copy of what `location` will say on the next
 * render. Under a router that is not the window's (a MemoryRouter in a unit
 * test) the two never agree, and `location` stands in for itself.
 */
export function liveQueryAndHash(
  location: Pick<Location, "pathname" | "search" | "hash">
): string | null {
  const rendered = location.search + location.hash;
  if (typeof window === "undefined") return rendered;
  const live = window.location;
  if (live.pathname === location.pathname) return live.search + live.hash;
  // react-router's browser history stamps every entry it writes with an
  // `idx`. Without one, the window's address is not the router's at all.
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === "number" ? null : rendered;
}

export function useCanonicalPath(canonicalPath: string | null): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!canonicalPath) return;
    if (location.pathname === canonicalPath) return;
    const queryAndHash = liveQueryAndHash(location);
    // The address bar has gone to another page since this render.
    if (queryAndHash === null) return;
    navigate(canonicalPath + queryAndHash, {
      replace: true,
      // Same page, corrected address: scroll restoration must not treat this
      // as arriving somewhere new. The names this waits on can land seconds
      // after the reader has started scrolling.
      // Whatever the page was navigated in with is kept: a correction is not
      // a new arrival (lib/leave.ts reads its `openedHere()` marker off it).
      state: { ...(location.state as object | null), preserveScroll: true },
    });
  }, [canonicalPath, location.pathname, location.search, location.hash, location.state, navigate]);
}
