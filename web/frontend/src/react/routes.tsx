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
  Navigate,
  Route,
  Routes,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Suspense, lazy } from "react";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ConfirmProvider } from "./rac/confirm";
import { UserProvider } from "./lib/user";
import type { AuthUser } from "../auth/client";
import { Loading } from "./rac/progress";
import { Shell } from "./components/Shell";
/* Static, like the SSR'd pages: the public comp pages render it from their own
   not-found branches, so a lazy boundary here would suspend during hydration. */
import { NotFound } from "./components/NotFound";

/*
 * The server-rendered public routes are STATIC imports and must stay
 * that way: entry-server renders them, and a lazy boundary the server resolved
 * but the client hasn't fetched yet is exactly what makes hydration fall back
 * to a client render — discarding the SSR markup this architecture exists to
 * produce. See functions/comp/[[path]].ts ROUTES for the authoritative list.
 */
import { Competitions } from "./pages/Competitions";
// Eager, not lazy: this is the homepage's primary call to action, so a pilot
// arriving on it must not pay a second round trip for the chunk. It is
// SSR-safe (no module-scope browser globals) even though /submit is never
// server-rendered.
import { SubmitTrack } from "./pages/SubmitTrack";
import { CompDetail } from "./pages/CompDetail";
import { CompScoresPage } from "./pages/CompScoresPage";
import { CompWaypoints } from "./pages/CompWaypoints";
import { TaskDetail } from "./pages/TaskDetail";
import { TaskDiagramPage } from "./pages/TaskDiagramPage";
import { PilotScoreDetail } from "./pages/PilotScoreDetail";
import { CompAnalysis } from "./pages/CompAnalysis";
import { TaskAnalysis } from "./pages/TaskAnalysis";
import { TaskAnalysisSection } from "./pages/TaskAnalysisSection";
import { TaskAnalysisMetricChart } from "./pages/TaskAnalysisMetricChart";

/*
 * Everything else is signed-in, admin-only or otherwise never server-rendered,
 * so it has no business in the bundle an anonymous visitor downloads to read a
 * scoreboard. Splitting these keeps the dashboard, settings, onboarding, the
 * admin screens and the pilots roster editor out of the entry chunk.
 */
const Dashboard = lazy(() =>
  import("./pages/Dashboard").then((m) => ({ default: m.Dashboard }))
);
const Onboarding = lazy(() =>
  import("./pages/Onboarding").then((m) => ({ default: m.Onboarding }))
);
// An MCP client asking to act as the organiser (docs/2026-10-24-mcp-oauth-plan.md §8).
const OAuthConsent = lazy(() =>
  import("./pages/OAuthConsent").then((m) => ({ default: m.OAuthConsent }))
);
const SignIn = lazy(() =>
  import("./pages/SignIn").then((m) => ({ default: m.SignIn }))
);
// The kit form's test bench, for e2e/forms.spec.ts. Development builds and the
// e2e suite's build (`vite build --mode e2e`, web/scripts/e2e-frontend.sh)
// only: in the production build both conditions are constant false, so neither
// the route nor the page is in it.
const KitFormFixture = import.meta.env.DEV || import.meta.env.MODE === "e2e"
  ? lazy(() => import("./pages/KitFormFixture").then((m) => ({ default: m.KitFormFixture })))
  : null;
// Starting a competition — signed-in only, a noindex shell in the SSR Function.
const NewCompPage = lazy(() =>
  import("./pages/NewCompPage").then((m) => ({ default: m.NewCompPage }))
);
const CompPilotsPage = lazy(() =>
  import("./pages/CompPilotsPage").then((m) => ({ default: m.CompPilotsPage }))
);
const CompSettingsPage = lazy(() =>
  import("./pages/CompSettingsPage").then((m) => ({ default: m.CompSettingsPage }))
);
const CompPilotPage = lazy(() =>
  import("./pages/CompPilotPage").then((m) => ({ default: m.CompPilotPage }))
);
const CompRosterImportPage = lazy(() =>
  import("./pages/CompRosterImportPage").then((m) => ({ default: m.CompRosterImportPage }))
);
const CompCivlFillPage = lazy(() =>
  import("./pages/CompCivlFillPage").then((m) => ({ default: m.CompCivlFillPage }))
);
// The waypoints editor's pages (#811): one waypoint, Add waypoint, the map at
// full size and the altitude review. The list itself is SSR'd (above).
const CompWaypointPage = lazy(() =>
  import("./pages/CompWaypointPage").then((m) => ({ default: m.CompWaypointPage }))
);
const CompWaypointNewPage = lazy(() =>
  import("./pages/CompWaypointNewPage").then((m) => ({ default: m.CompWaypointNewPage }))
);
const CompWaypointsMapPage = lazy(() =>
  import("./pages/CompWaypointsMapPage").then((m) => ({ default: m.CompWaypointsMapPage }))
);
const CompAltitudeReviewPage = lazy(() =>
  import("./pages/CompAltitudeReviewPage").then((m) => ({ default: m.CompAltitudeReviewPage }))
);
const CompNewTaskPage = lazy(() =>
  import("./pages/CompNewTaskPage").then((m) => ({ default: m.CompNewTaskPage }))
);
const TaskSettingsPage = lazy(() =>
  import("./pages/TaskSettingsPage").then((m) => ({ default: m.TaskSettingsPage }))
);
const TaskRoutePage = lazy(() =>
  import("./pages/TaskRoutePage").then((m) => ({ default: m.TaskRoutePage }))
);
// The route editor's other pages (#812): one turnpoint, Quick entry, Load
// from XContest and Add waypoint, where they were sheets and dialogs.
const TaskRouteTurnpointPage = lazy(() =>
  import("./pages/TaskRouteTurnpointPage").then((m) => ({ default: m.TaskRouteTurnpointPage }))
);
const TaskRouteQuickPage = lazy(() =>
  import("./pages/TaskRouteQuickPage").then((m) => ({ default: m.TaskRouteQuickPage }))
);
const TaskRouteXContestPage = lazy(() =>
  import("./pages/TaskRouteXContestPage").then((m) => ({ default: m.TaskRouteXContestPage }))
);
const TaskRouteAddWaypointPage = lazy(() =>
  import("./pages/TaskRouteAddWaypointPage").then((m) => ({
    default: m.TaskRouteAddWaypointPage,
  }))
);
const ManualFlightPage = lazy(() =>
  import("./pages/ManualFlightPage").then((m) => ({ default: m.ManualFlightPage }))
);
const TaskWeatherPage = lazy(() =>
  import("./pages/TaskWeatherPage").then((m) => ({ default: m.TaskWeatherPage }))
);
const TaskTestIgcPage = lazy(() =>
  import("./pages/TaskTestIgcPage").then((m) => ({ default: m.TaskTestIgcPage }))
);
// Public, but a noindex shell rather than SSR'd: a QR code is a picture for a
// camera, with nothing in it for a crawler. Lazy, so `qrcode.react` stays out
// of the entry bundles.
const TaskQrPage = lazy(() =>
  import("./pages/TaskQrPage").then((m) => ({ default: m.TaskQrPage }))
);
// Client-only (a noindex shell in the SSR Function), and lazy so it costs
// nothing on the pages that do not open it.
const TaskPilotSimilarity = lazy(() =>
  import("./pages/TaskPilotSimilarity").then((m) => ({
    default: m.TaskPilotSimilarity,
  }))
);
// One thermal's rose and map at the size of the screen (#816). Client-only
// for the same reason: a noindex shell, and the map in it is browser-only.
const TaskThermalMap = lazy(() =>
  import("./pages/TaskThermalMap").then((m) => ({ default: m.TaskThermalMap }))
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
 * The per-task analysis lives under the task again:
 * /comp/:c/analysis/task/:t → /comp/:c/task/:t/analysis, and likewise for the
 * similarity sheet below it. Keeps old links (and anyone's open tab) working.
 * `?class=`, `?pilot=` and friends are carried across — they are the shareable
 * part of the URL.
 *
 * A hard load of the old URL never gets here: the Pages Function 301s it (see
 * functions/comp/[[path]].ts), because that URL was public and server-rendered
 * and a crawler must be told where the page went. This covers the in-app and
 * back/forward cases.
 */
function TaskAnalysisRedirect({ similar = false }: { similar?: boolean }) {
  const { compId, taskId } = useParams();
  const [searchParams] = useSearchParams();
  const query = searchParams.toString();
  return (
    <Navigate
      replace
      to={`/comp/${compId}/task/${taskId}/analysis${similar ? "/similar" : ""}${
        query ? `?${query}` : ""
      }`}
    />
  );
}

export function AppRoutes() {
  return (
    // An error thrown by any route lands here rather than blanking the page.
    // A chunk that no longer exists (a tab that outlived a deploy) reloads
    // once; anything else gets an apology with a way out.
    <AppErrorBoundary>
      {/* The lazy routes above need a boundary. It wraps everything so there is
          one, but it can only ever be hit by a split route: the server-rendered
          pages are static imports and never suspend, so hydration of an SSR'd
          page never sees this fallback. */}
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
          <Route path="/oauth/consent" element={<OAuthConsent />} />
          <Route element={<Shell />}>
            <Route path="/u/:username" element={<Dashboard />} />
            {/* Inside Shell: /submit is a destination with somewhere to go
                afterwards, not a dead end like /signin. */}
            <Route path="/submit" element={<SubmitTrack />} />
            {KitFormFixture ? (
              <Route path="/__kit/form" element={<KitFormFixture />} />
            ) : null}
            <Route path="/comp" element={<Competitions />} />
            {/* A page rather than a dialog over the list (the overlays rule in
                CLAUDE.md). The static segment outranks /comp/:compId below. */}
            <Route path="/comp/new" element={<NewCompPage />} />
            <Route path="/comp/:compId" element={<CompDetail />} />
            <Route path="/comp/:compId/scores" element={<CompScoresPage />} />
            {/* Admin-only roster editor — noindex shell in the SSR Function. */}
            <Route path="/comp/:compId/pilots" element={<CompPilotsPage />} />
            {/* One pilot's editor, and a blank one — pages rather than sheets
                over the list (the overlays rule in CLAUDE.md). Noindex shells. */}
            <Route path="/comp/:compId/pilots/new" element={<CompPilotPage />} />
            {/* The roster's CSV import and CIVL fill, pages where they were
                sheets over the list (#810). Static segments, so they outrank
                :pilotId below. Noindex shells, like the rest of /pilots. */}
            <Route path="/comp/:compId/pilots/import" element={<CompRosterImportPage />} />
            <Route path="/comp/:compId/pilots/civl-fill" element={<CompCivlFillPage />} />
            <Route path="/comp/:compId/pilots/:pilotId" element={<CompPilotPage />} />
            {/* Admin-only settings pages (index + one sub-page per group) —
                noindex shell in the SSR Function, like /pilots. */}
            <Route path="/comp/:compId/settings" element={<CompSettingsPage />} />
            <Route
              path="/comp/:compId/settings/:group"
              element={<CompSettingsPage />}
            />
            <Route path="/comp/:compId/waypoints" element={<CompWaypoints />} />
            {/* The waypoints editor's other pages, where they were sheets and a
                dialog over the list (#811). Admin-only noindex shells in the
                SSR Function. The static segments outrank :rowId by themselves. */}
            <Route path="/comp/:compId/waypoints/new" element={<CompWaypointNewPage />} />
            <Route path="/comp/:compId/waypoints/map" element={<CompWaypointsMapPage />} />
            <Route
              path="/comp/:compId/waypoints/altitudes"
              element={<CompAltitudeReviewPage />}
            />
            <Route
              path="/comp/:compId/waypoints/altitudes/:rowId"
              element={<CompAltitudeReviewPage />}
            />
            <Route path="/comp/:compId/waypoints/:rowId" element={<CompWaypointPage />} />
            {/* Analysis (behavioural metrics). One COMP analysis per competition
                at /analysis, and one chapter per task UNDER THAT TASK — see the
                task routes below. The comp report collects the chapters; it does
                not own their URLs, and the breadcrumbs agree (lib/crumbs.ts).
                PUBLIC and server-rendered since July 2026 — both have ROUTES
                entries in functions/comp/[[path]].ts, and a cold report renders
                its pending notice server-side (noindex) while the client polls.
                A hidden `test` comp still 404s for non-admins. */}
            <Route path="/comp/:compId/analysis" element={<CompAnalysis />} />
            {/* Creating a task: a page, not a dialog over the comp (#819).
                Admin-only, so a noindex shell in the SSR Function, listed
                ahead of the public task route, whose URL shape it shares. The
                router ranks the static `new` above `:taskId` by itself. */}
            <Route path="/comp/:compId/task/new" element={<CompNewTaskPage />} />
            <Route path="/comp/:compId/task/:taskId" element={<TaskDetail />} />
            {/* The task's route at full size, opened from the glyph beside
                each task on the competition page (#814; it was an overlay).
                Public and server-rendered, but noindexed: the task page is
                the indexable form of the same route. */}
            <Route
              path="/comp/:compId/task/:taskId/diagram"
              element={<TaskDiagramPage />}
            />
            {/* The task's three admin-only editors, all SIBLINGS: each is
                reached from the part of the task page it edits, so none nests
                under another. Noindex shells in the SSR Function, like /pilots.

                Settings is flat where the comp's is an index — a task has five
                settings, which is a form and not a hierarchy. The route editor
                is the surface a phone needed most: a map, a turnpoint grid and
                two config panels used to share one 100dvh modal. */}
            <Route
              path="/comp/:compId/task/:taskId/settings"
              element={<TaskSettingsPage />}
            />
            <Route
              path="/comp/:compId/task/:taskId/route"
              element={<TaskRoutePage />}
            />
            {/* The route editor's other pages (#812), over the same stored
                draft of the route (comp/route-draft.ts). The static segments
                rank above the turnpoint's row id by themselves. */}
            <Route
              path="/comp/:compId/task/:taskId/route/quick"
              element={<TaskRouteQuickPage />}
            />
            <Route
              path="/comp/:compId/task/:taskId/route/xcontest"
              element={<TaskRouteXContestPage />}
            />
            <Route
              path="/comp/:compId/task/:taskId/route/add-waypoint"
              element={<TaskRouteAddWaypointPage />}
            />
            <Route
              path="/comp/:compId/task/:taskId/route/:rowId"
              element={<TaskRouteTurnpointPage />}
            />
            <Route
              path="/comp/:compId/task/:taskId/weather"
              element={<TaskWeatherPage />}
            />
            {/* Create a test IGC: an organiser's tool rather than an editor (it
                makes a file to download and changes nothing), and admin-only
                like them, so a noindex shell in the SSR Function too. */}
            <Route
              path="/comp/:compId/task/:taskId/test-igc"
              element={<TaskTestIgcPage />}
            />
            {/* The task's QR code, for a phone camera: a page of its own
                (#813), where it was a full-screen overlay over the task page. */}
            <Route
              path="/comp/:compId/task/:taskId/qr"
              element={<TaskQrPage />}
            />
            {/* This task's own TASK analysis, collected by the comp analysis: a summary, with
                a box per section linking to the section's own page. */}
            <Route
              path="/comp/:compId/task/:taskId/analysis"
              element={<TaskAnalysis />}
            />
            {/* Pilot-to-pilot behavioural similarity, a leaf of the chapter it
                derives from. Client-only, so it needs a NOINDEX_SHELL_ROUTES
                entry in functions/comp/[[path]].ts rather than a loader. It is
                a STATIC segment, so it out-ranks the :section route below
                whichever order they are declared in. */}
            <Route
              path="/comp/:compId/task/:taskId/analysis/similar"
              element={<TaskPilotSimilarity />}
            />
            {/* One thermal's rose over the terrain it worked, at the size of
                the screen — a leaf of the thermals section, where it was a
                full-screen sheet until #816. Two segments deep, so the
                :section route below can never match it; a noindex shell in
                functions/comp/[[path]].ts. */}
            <Route
              path="/comp/:compId/task/:taskId/analysis/thermals/map"
              element={<TaskThermalMap />}
            />
            {/* One section of the chapter, each showing that one thing. Five
                slugs, listed in analysis/sections.ts and matched by the
                SSR Function's own pattern; anything else renders NotFound. */}
            <Route
              path="/comp/:compId/task/:taskId/analysis/:section"
              element={<TaskAnalysisSection />}
            />
            {/* One metric's chart at full size (#815), under the Metric
                details section that holds every metric. Public and SSR'd
                like the sections, but noindexed: it is a bigger copy of a
                chart the strategies page already shows. */}
            <Route
              path="/comp/:compId/task/:taskId/analysis/metrics/:metric"
              element={<TaskAnalysisMetricChart />}
            />
            {/* Where the per-task analysis lived while it was nested under the
                comp report (July–August 2026). */}
            <Route
              path="/comp/:compId/analysis/task/:taskId"
              element={<TaskAnalysisRedirect />}
            />
            <Route
              path="/comp/:compId/analysis/task/:taskId/similar"
              element={<TaskAnalysisRedirect similar />}
            />
            <Route
              path="/comp/:compId/task/:taskId/pilot/:pilotId"
              element={<PilotScoreDetail />}
            />
            {/* Recording a flight for a pilot with no tracklog (S7F §9.2.2) —
                admin-only, and a child of the report card because that is the
                page it is about. */}
            <Route
              path="/comp/:compId/task/:taskId/pilot/:pilotId/manual-flight"
              element={<ManualFlightPage />}
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
    </AppErrorBoundary>
  );
}
