/**
 * The main GlideComp UI: a React + Base UI SPA served at /, /comp, /u/*,
 * /scores, /settings, /onboarding, the static about/legal/scoring pages and
 * the /admin pages. The analysis and 3D replay pages remain separate vanilla
 * entries — links point at those pages directly.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppToaster } from "./lib/toast";
import { ConfirmProvider } from "./lib/confirm";
import { UserProvider } from "./lib/user";
import { Shell } from "./components/Shell";
import { Home } from "./pages/Home";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { Competitions } from "./pages/Competitions";
import { CompDetail } from "./pages/CompDetail";
import { TaskDetail } from "./pages/TaskDetail";
import { Scores } from "./pages/Scores";
import { Settings } from "./pages/Settings";
import { About } from "./pages/About";
import { Legal } from "./pages/Legal";
import { Scoring } from "./pages/Scoring";
import { ScoringGap } from "./pages/ScoringGap";
import { ScoringOpenDistance } from "./pages/ScoringOpenDistance";
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
  return (
    <main>
      <p>Page not found</p>
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
              <Route path="/" element={<Home />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/about" element={<About />} />
              <Route path="/legal" element={<Legal />} />
              <Route path="/scoring" element={<Scoring />} />
              <Route path="/scoring/gap" element={<ScoringGap />} />
              <Route path="/scoring/open-distance" element={<ScoringOpenDistance />} />
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
