/**
 * The main GlideComp UI: a React + Base UI SPA served from /app.html and
 * mapped to /comp, /u/*, /scores, /settings, /onboarding and the /admin
 * routes via _redirects. Home, about, legal and the scoring guides are static
 * pages built by ./static (Astro); the analysis and 3D replay pages remain
 * separate vanilla entries — links point at those pages directly.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { AppToaster } from "./lib/toast";
import { ConfirmProvider } from "./lib/confirm";
import { UserProvider } from "./lib/user";
import { Shell } from "./components/Shell";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { Competitions } from "./pages/Competitions";
import { CompDetail } from "./pages/CompDetail";
import { TaskDetail } from "./pages/TaskDetail";
import { Scores } from "./pages/Scores";
import { Settings } from "./pages/Settings";
import { AdminUsers } from "./pages/AdminUsers";
import { AdminCache } from "./pages/AdminCache";

// shadcn theming keys dark mode off a `.dark` class on <html>; follow the
// OS preference (matching the previous prefers-color-scheme behaviour).
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function syncDarkClass() {
  document.documentElement.classList.toggle("dark", darkQuery.matches);
}
syncDarkClass();
darkQuery.addEventListener("change", syncDarkClass);

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
        <li><a href="/" className={linkClass}>Home</a></li>
        <li><Link to="/comp" className={linkClass}>Competitions</Link></li>
        <li><Link to="/u/me" className={linkClass}>My Flights</Link></li>
        <li><a href="/scoring" className={linkClass}>How scoring works</a></li>
      </ul>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UserProvider>
      <AppToaster />
      <ConfirmProvider>
          <BrowserRouter>
            <Routes>
              {/* Home, about, legal and the scoring guides are static pages
                  built by ./static (Astro) — served outside the SPA. */}
              {/* /app is the SPA shell's own URL. Browsers that cached the old
                  broken 308 (SPA route -> /app) before the _redirects fix land
                  here; bounce them to the dashboard. This is a client-side
                  (pushState) nav, so it doesn't re-trigger the cached redirect. */}
              <Route path="/app" element={<Navigate to="/u/me" replace />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route element={<Shell />}>
                <Route path="/u/:username" element={<Dashboard />} />
                <Route path="/comp" element={<Competitions />} />
                <Route path="/comp/:compId" element={<CompDetail />} />
                <Route path="/comp/:compId/task/:taskId" element={<TaskDetail />} />
                <Route path="/scores" element={<Scores />} />
                {/* "My Profile" merged into Settings; keep the old path working. */}
                <Route path="/profile" element={<Navigate to="/settings" replace />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/admin/users" element={<AdminUsers />} />
                <Route path="/admin/cache" element={<AdminCache />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
      </ConfirmProvider>
    </UserProvider>
  </StrictMode>
);
