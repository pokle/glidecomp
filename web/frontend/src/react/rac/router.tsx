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
        if (isExternalHref(to)) window.location.href = to;
        else void navigate(to);
      }}
      useHref={useAppHref}
    >
      {children}
    </RouterProvider>
  );
}
