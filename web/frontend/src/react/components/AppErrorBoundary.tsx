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
    <main
      id="main-content"
      className="mx-auto flex max-w-xl flex-col items-start gap-4 px-gutter-safe py-12"
    >
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-bold outline-none">
        Something went wrong
      </h1>
      <p className="text-muted-foreground">
        Sorry, this page hit a problem it couldn't recover from. Reloading
        usually fixes it, especially if GlideComp was updated while you had the
        page open.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button onPress={() => window.location.reload()}>Reload page</Button>
        {/* A full navigation: the home page is a static page, not an SPA route. */}
        <LinkButton variant="outline" href="/">
          Go to the home page
        </LinkButton>
      </div>
    </main>
  );
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname}>{children}</Boundary>;
}
