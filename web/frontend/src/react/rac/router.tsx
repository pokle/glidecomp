/**
 * Bridges RAC's client-side routing to react-router. Any RAC Link / LinkButton
 * / MenuItem / Table Row with an `href` inside this provider navigates via
 * react-router instead of a full page load. SSR-safe: useNavigate/useHref work
 * under both BrowserRouter and the server's StaticRouter.
 */
import { RouterProvider } from "react-aria-components";
import { useHref, useNavigate } from "react-router-dom";

export function RacRouterProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  return (
    <RouterProvider navigate={(to) => void navigate(to)} useHref={useHref}>
      {children}
    </RouterProvider>
  );
}
