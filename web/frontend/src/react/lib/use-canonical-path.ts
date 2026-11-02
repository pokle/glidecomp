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
 */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function useCanonicalPath(canonicalPath: string | null): void {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!canonicalPath) return;
    if (location.pathname === canonicalPath) return;
    navigate(canonicalPath + location.search + location.hash, {
      replace: true,
      // Same page, corrected address: scroll restoration must not treat this
      // as arriving somewhere new. The names this waits on can land seconds
      // after the reader has started scrolling.
      // Whatever the page was navigated in with is kept: a correction is not
      // a new arrival (the pilot page reads `fromList` off it).
      state: { ...(location.state as object | null), preserveScroll: true },
    });
  }, [canonicalPath, location.pathname, location.search, location.hash, location.state, navigate]);
}
