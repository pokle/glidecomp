/**
 * SSR initial-data handoff. The server-rendered Pages Function
 * (functions/comp/[[path]].ts) runs a route loader, embeds the result as
 * `window.__SSR_DATA__ = { path, data }`, and the client reads it here so the
 * page's first render matches the server markup exactly (no hydration diff).
 *
 * The data is valid for one render of the SSR'd URL only: the moment the app
 * navigates away (a client-side pushState), it is retired, so returning to the
 * same path re-fetches fresh instead of re-seeding from the now-stale blob.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

/** The loader result plus the pathname it was rendered for. */
export interface InitialData {
  path: string;
  data: unknown;
}

const InitialDataContext = createContext<InitialData | null>(null);

export function InitialDataProvider({
  value,
  children,
}: {
  value: InitialData | null;
  children: React.ReactNode;
}) {
  const startPath = useRef(value?.path ?? null);
  const [active, setActive] = useState(value != null);
  const location = useLocation();

  useEffect(() => {
    // Any navigation off the initial SSR path retires the seed data. Pages have
    // already lazily seeded their state from it by now, so this is invisible.
    if (active && location.pathname !== startPath.current) setActive(false);
  }, [active, location.pathname]);

  return (
    <InitialDataContext.Provider value={active ? value : null}>
      {children}
    </InitialDataContext.Provider>
  );
}

/**
 * The SSR loader data for the current route, or null when there is none
 * (classic SPA boot, or a client-side navigation). Pages use it to seed
 * `useState` lazily and skip their initial fetch.
 */
export function useInitialData<T>(): T | null {
  const value = useContext(InitialDataContext);
  const location = useLocation();
  if (value && value.path === location.pathname) return value.data as T;
  return null;
}
