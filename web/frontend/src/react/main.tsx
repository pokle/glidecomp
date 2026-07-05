/**
 * React + Base UI version of the main GlideComp UI, served at /react/*.
 * The analysis and 3D replay pages are intentionally not converted — links
 * point at the existing vanilla pages.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppToastProvider } from "./lib/toast";
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
import { Profile } from "./pages/Profile";
import { Settings } from "./pages/Settings";

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
      <AppToastProvider>
        <ConfirmProvider>
          <BrowserRouter basename="/react">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route element={<Shell />}>
                <Route path="/u/:username" element={<Dashboard />} />
                <Route path="/comp" element={<Competitions />} />
                <Route path="/comp/:compId" element={<CompDetail />} />
                <Route path="/comp/:compId/task/:taskId" element={<TaskDetail />} />
                <Route path="/scores" element={<Scores />} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ConfirmProvider>
      </AppToastProvider>
    </UserProvider>
  </StrictMode>
);
