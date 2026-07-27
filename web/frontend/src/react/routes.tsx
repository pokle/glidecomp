/**
 * Shared route tree + provider stack, consumed by both entries:
 *   entry-client.tsx  — hydrateRoot / createRoot inside <BrowserRouter>
 *   entry-server.tsx  — renderToReadableStream inside <StaticRouter>
 *
 * Nothing here may touch `window`/`document` at module scope or during render
 * (it runs on the server too). The toaster (a body-level portal) is rendered
 * only by the client entry.
 */
import {
  Link,
  Navigate,
  Route,
  Routes,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Suspense, lazy } from "react";
import { ConfirmProvider } from "./rac/confirm";
import { UserProvider } from "./lib/user";
import type { AuthUser } from "../auth/client";
import { Loading } from "./rac/progress";
import { Shell } from "./components/Shell";

/*
 * The eight server-rendered public routes are STATIC imports and must stay
 * that way: entry-server renders them, and a lazy boundary the server resolved
 * but the client hasn't fetched yet is exactly what makes hydration fall back
 * to a client render — discarding the SSR markup this architecture exists to
 * produce. See functions/comp/[[path]].ts ROUTES for the authoritative list.
 */
import { Competitions } from "./pages/Competitions";
import { CompDetail } from "./pages/CompDetail";
import { CompScoresPage } from "./pages/CompScoresPage";
import { CompWaypoints } from "./pages/CompWaypoints";
import { TaskDetail } from "./pages/TaskDetail";
import { PilotScoreDetail } from "./pages/PilotScoreDetail";
import { CompFieldAnalysis } from "./pages/CompFieldAnalysis";
import { TaskFieldAnalysis } from "./pages/TaskFieldAnalysis";

/*
 * Everything else is signed-in, admin-only or otherwise never server-rendered,
 * so it has no business in the bundle an anonymous visitor downloads to read a
 * scoreboard. Splitting these keeps the dashboard, settings, onboarding, the
 * admin screens and the Tabulator-backed pilots roster out of the entry chunk.
 */
const Dashboard = lazy(() =>
  import("./pages/Dashboard").then((m) => ({ default: m.Dashboard }))
);
const Onboarding = lazy(() =>
  import("./pages/Onboarding").then((m) => ({ default: m.Onboarding }))
);
const SignIn = lazy(() =>
  import("./pages/SignIn").then((m) => ({ default: m.SignIn }))
);
const CompPilotsPage = lazy(() =>
  import("./pages/CompPilotsPage").then((m) => ({ default: m.CompPilotsPage }))
);
const Scores = lazy(() =>
  import("./pages/Scores").then((m) => ({ default: m.Scores }))
);
const Settings = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.Settings }))
);
const AdminUsers = lazy(() =>
  import("./pages/AdminUsers").then((m) => ({ default: m.AdminUsers }))
);
const AdminCache = lazy(() =>
  import("./pages/AdminCache").then((m) => ({ default: m.AdminCache }))
);

/** App-wide context providers. SSR-safe (no portals rendered here).
 *
 * `initialUser` carries the visitor the SSR Function already resolved from the
 * forwarded cookie. Both entries must pass the same value or the UserProvider's
 * first render differs between server and client. `undefined` = not known. */
export function AppProviders({
  children,
  initialUser,
}: {
  children: React.ReactNode;
  initialUser?: AuthUser | null;
}) {
  return (
    <UserProvider initialUser={initialUser}>
      <ConfirmProvider>{children}</ConfirmProvider>
    </UserProvider>
  );
}

/**
 * The per-task field analysis moved from /comp/:c/task/:t/analysis to
 * /comp/:c/analysis/task/:t. Keeps old links (and anyone's open tab) working.
 * `?class=` is carried across — it's the shareable part of the URL.
 */
function TaskAnalysisRedirect() {
  const { compId, taskId } = useParams();
  const [searchParams] = useSearchParams();
  const query = searchParams.toString();
  return (
    <Navigate
      replace
      to={`/comp/${compId}/analysis/task/${taskId}${query ? `?${query}` : ""}`}
    />
  );
}

function NotFound() {
  const linkClass = "underline underline-offset-4 hover:text-foreground";
  return (
    <main className="mx-auto flex max-w-md flex-col items-start gap-4 py-12">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="text-muted-foreground">
        The page you're looking for doesn't exist or may have moved. Try one of these:
      </p>
      <ul className="flex flex-col gap-2 text-sm">
        {/* Home and Scoring are static (Astro) pages — full navigation. */}
        <li><Link to="/comp" className={linkClass}>Competitions</Link></li>
        <li><Link to="/u/me" className={linkClass}>My Flights</Link></li>
        <li><a href="/scoring" className={linkClass}>How scoring works</a></li>
        <li><a href="/" className={linkClass}>Home</a></li>
      </ul>
    </main>
  );
}

export function AppRoutes() {
  return (
    // The lazy routes above need a boundary. It wraps everything so there is
    // one, but it can only ever be hit by a split route: the server-rendered
    // pages are static imports and never suspend, so hydration of an SSR'd
    // page never sees this fallback.
    <Suspense fallback={<Loading>Loading…</Loading>}>
      <Routes>
        {/* Home, about, legal and the scoring guides are static pages built by
            ./static (Astro) — served outside the SPA. */}
        {/* /app is the SPA shell's own URL. Browsers that cached the old broken
            308 (SPA route -> /app) before the _redirects fix land here; bounce
            them to the dashboard. This is a client-side (pushState) nav, so it
            doesn't re-trigger the cached redirect. */}
        <Route path="/app" element={<Navigate to="/u/me" replace />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/signin" element={<SignIn />} />
        <Route element={<Shell />}>
          <Route path="/u/:username" element={<Dashboard />} />
          <Route path="/comp" element={<Competitions />} />
          <Route path="/comp/:compId" element={<CompDetail />} />
          <Route path="/comp/:compId/scores" element={<CompScoresPage />} />
          {/* Admin-only roster editor — noindex shell in the SSR Function, like
              the field-analysis pages. */}
          <Route path="/comp/:compId/pilots" element={<CompPilotsPage />} />
          <Route path="/comp/:compId/waypoints" element={<CompWaypoints />} />
          {/* Field analysis (behavioural metrics). One report per competition,
              with a chapter per task NESTED UNDER IT — the per-task page is a
              drill-down of the comp report, not a leaf of the task page, so
              "up one level" lands back in the report where the other tasks are.
              Admin-gated by the API and deliberately NOT server-rendered —
              functions/comp/[[path]].ts has no ROUTES entry for these, so a hard
              reload falls through to the plain SPA shell (with noindex). */}
          <Route path="/comp/:compId/analysis" element={<CompFieldAnalysis />} />
          <Route
            path="/comp/:compId/analysis/task/:taskId"
            element={<TaskFieldAnalysis />}
          />
          <Route path="/comp/:compId/task/:taskId" element={<TaskDetail />} />
          {/* Where the per-task analysis lived until the re-nesting above. */}
          <Route
            path="/comp/:compId/task/:taskId/analysis"
            element={<TaskAnalysisRedirect />}
          />
          <Route
            path="/comp/:compId/task/:taskId/pilot/:pilotId"
            element={<PilotScoreDetail />}
          />
          <Route path="/scores" element={<Scores />} />
          {/* "My Profile" merged into Settings; keep the old path working. */}
          <Route path="/profile" element={<Navigate to="/settings" replace />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/cache" element={<AdminCache />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
