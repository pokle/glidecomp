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
      state: { preserveScroll: true },
    });
  }, [canonicalPath, location.pathname, location.search, location.hash, navigate]);
}
