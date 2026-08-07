/**
 * Bridges RAC's client-side routing to react-router. Any RAC Link / LinkButton
 * / MenuItem / Table Row with an `href` inside this provider navigates via
 * react-router instead of a full page load. SSR-safe: useNavigate/useHref work
 * under both BrowserRouter and the server's StaticRouter.
 */
import { RouterProvider } from "react-aria-components";
import { useHref, useNavigate } from "react-router-dom";

/**
 * True for an href that is NOT an app route: anything carrying a scheme
 * (`https:`, `mailto:`, `tel:`) or protocol-relative (`//host/…`).
 *
 * It matters because react-router's `useHref` resolves what it is given
 * against the CURRENT path, and RAC writes the result into the anchor's href.
 * So an external URL came out as a route under the page it was clicked from —
 * "https://sheets.new" on the scores page rendered as
 * `/comp/<comp>/scores/https:/sheets.new`, a 404 nobody sees until they click
 * it. Passing these through untouched is the whole fix: RAC then declines to
 * client-navigate them anyway (different origin, or a `target`), so they open
 * as ordinary links.
 */
export function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * True for a SAME-ORIGIN href that the server has to answer rather than
 * react-router: a Pages Function (`/civl-rankings.csv`, `/sitemap.xml`) or a
 * separate Vite entry (`/analysis.html`, `/replay.html`).
 *
 * Client-navigating one of those renders the 404 page — react-router matches
 * nothing — and only a reload, which is a real request, reveals the file. That
 * is exactly what a superadmin saw clicking the CIVL rankings download.
 *
 * The test is a dot in the LAST path segment, the same rule `public/_redirects`
 * uses to keep the SPA rewrites off module requests. It is safe because no SPA
 * path can contain one: the route table has none, `slugify()` turns every
 * non-alphanumeric character into a dash, and a username is `[a-zA-Z0-9-]`.
 *
 * A `download` attribute also stops RAC client-navigating (see
 * comp/ScoresDownload.tsx) — this is the net under the links that forget.
 */
export function isServerHref(href: string, base: string): boolean {
  if (isExternalHref(href)) return false;
  let pathname: string;
  try {
    // Resolved rather than string-sliced: `to` may be relative ("./scores.csv"),
    // and only the path matters — a dot in a query or hash is not a filename.
    pathname = new URL(href, base).pathname;
  } catch {
    return false;
  }
  return pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

function useAppHref(href: string): string {
  // Hooks run unconditionally; the dummy keeps react-router out of the
  // external case without branching around the call.
  const routed = useHref(isExternalHref(href) ? "/" : href);
  return isExternalHref(href) ? href : routed;
}

export function RacRouterProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <RouterProvider
      navigate={(to) => {
        // Same rule on the navigate side: react-router would push an external
        // URL onto the history stack as a path. RAC only reaches here for a
        // link it decided to client-navigate, so this is belt and braces.
        //
        // A same-origin file (a Pages Function, another Vite entry) leaves the
        // SPA the same way — react-router has no route for it, and pushing it
        // would render the 404 page over a URL the server answers fine.
        if (isExternalHref(to) || isServerHref(to, window.location.href)) {
          window.location.href = to;
        } else void navigate(to);
      }}
      useHref={useAppHref}
    >
      {children}
    </RouterProvider>
  );
}
