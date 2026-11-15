/**
 * The app's last line of defence: an error thrown while rendering any route.
 *
 * Without it, React unmounts the whole tree on an uncaught render error, and
 * the reader is left looking at a blank page with nothing to press. That is
 * how a tab that outlived a deploy used to end (see lib/stale-deploy.ts).
 *
 * - A failed chunk load reloads the page once, for the reader, rather than
 *   apologising: it is a stale tab, and the new deploy is one reload away.
 *   The screen appears only if that reload was already tried.
 * - Anything else gets an apology and two ways out: reload, or the home page.
 * - It resets when the location changes, so Back (or any navigation that
 *   survives) leaves the error behind rather than keeping it on every route.
 *
 * Wraps AppRoutes, which the SSR entry renders too. It renders its children
 * untouched until something throws, so the server and client trees stay
 * identical and hydration is unaffected. It sits OUTSIDE Shell, so the screen
 * stands alone: Shell itself may be what failed.
 */
import { Component, useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ChevronLeftIcon } from "lucide-react";

import { Button, LinkButton } from "@/react/rac/button";
import { Loading } from "@/react/rac/progress";
import { isChunkLoadError, reloadForNewDeploy } from "@/react/lib/stale-deploy";

interface State {
  error: unknown;
  /** A chunk-load failure whose reload is under way. */
  reloading: boolean;
}

class Boundary extends Component<{ resetKey: string; children: ReactNode }, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, reloading: isChunkLoadError(error) };
  }

  // React has already logged the error and its component stack.
  componentDidCatch(): void {
    if (this.state.reloading && !reloadForNewDeploy()) {
      this.setState({ reloading: false });
    }
  }

  componentDidUpdate(prev: { resetKey: string }): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, reloading: false });
    }
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    if (this.state.reloading) return <Loading>Loading…</Loading>;
    return <ErrorScreen />;
  }
}

/**
 * The screen replaces the page the reader was on, so focus moves to its heading,
 * as on a route change: whatever held focus has just been unmounted.
 */
function ErrorScreen() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = "GlideComp - Something went wrong";
    heading.current?.focus();
  }, []);

  return (
    <main id="main-content" className="w-full">
      {/* The bar's look in plain markup, not `PageBar`: this screen stands
          alone, outside the Shell and its providers, because any of them may
          be what failed. Its way out is the home page, a full page load. */}
      <header className="sticky top-0 z-40 bg-background pt-safe print:hidden">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-gutter-safe py-2">
          <a
            href="/"
            aria-label="Back to the home page"
            className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card shadow-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronLeftIcon className="size-5" aria-hidden />
          </a>
          <div className="flex h-11 min-w-0 flex-1 items-center justify-center rounded-full border border-border/70 bg-card px-4 shadow-card">
            <h1
              ref={heading}
              tabIndex={-1}
              className="truncate text-[0.9375rem] font-semibold outline-none"
            >
              Something went wrong
            </h1>
          </div>
          {/* Keeps the title centred, as the trailing slot does on a page. */}
          <span className="size-11 shrink-0" aria-hidden />
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-4 px-gutter-safe pt-3 pb-12">
      <p className="text-muted-foreground">
        This page hit a problem. Reloading usually fixes it.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button onPress={() => window.location.reload()}>Reload page</Button>
        {/* A full navigation: the home page is a static page, not an SPA route. */}
        <LinkButton variant="outline" href="/">
          Go to the home page
        </LinkButton>
      </div>
      </div>
    </main>
  );
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname}>{children}</Boundary>;
}
